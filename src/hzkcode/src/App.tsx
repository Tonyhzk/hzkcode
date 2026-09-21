import { lazy, Suspense, useEffect } from "react";
import { LazyMotion, domAnimation } from "motion/react";
import { HashRouter, Route, Routes } from "react-router-dom";
import ChatPage from "@/features/chat/ChatPage";
import { CommandPalette } from "@/features/commands/CommandPalette";
import PluginPageHost from "@/features/plugins/manager/PluginPageHost";
import { bindSystemThemeSync, bindThemeChangePersistence } from "@/features/settings/theme";
import { UpdateToast } from "@/features/update/UpdateToast";
import { useUpdateStore } from "@/features/update/store";
import { EditorWindow } from "@/features/files/EditorWindow";
import { DragGhostCard } from "@/features/files/DragGhostCard";
import { useFilesStore } from "@/features/files/store";
import { GrantAccessDialogHost } from "@/components/dialogs";
import { startPluginSystem } from "@/features/plugins";
import { CloseConfirmDialogHost } from "@/components/dialogs";
import { installCloseConfirm } from "@/lib/close-confirm";
import { installSelectionGuard } from "@/lib/selection-guard";
import { listenEditorWindowClosed } from "@/lib/events";
import { claimMovedOutEditorTab } from "@/lib/window-actions";
import { windowContext } from "@/lib/window-context";
import { startShortcutRuntime } from "@/features/shortcuts/runtime";
import { ShortcutsGuideModal } from "@/features/shortcuts/ShortcutsGuideModal";

// Settings is a rare route; load it on demand so startup ships less JS.
// Warm the chunk shortly after startup so the first click has no fetch gap.
const loadSettingsPage = () => import("@/features/settings/SettingsPage");
const SettingsPage = lazy(loadSettingsPage);

export default function App() {
  // Startup theme/language init lives in main.tsx module scope; only the
  // theme-change listeners (with their own cleanup) are registered here.
  useEffect(() => bindThemeChangePersistence(), []);
  // bindSystemThemeSync keeps a "system" theme following OS color-scheme
  // flips app-wide — this used to live in the settings page, where it only
  // worked while Settings was open.
  useEffect(() => bindSystemThemeSync(), []);
  // Standalone editor windows (?ctx=editor) render one file and nothing else:
  // no settings chunk, plugin host, command palette, or update toast.
  const editorFilePath =
    windowContext.kind === "editor" ? windowContext.filePath : null;
  // The drag-ghost window (?ctx=drag-ghost) is a bare card: none of the
  // startup work below applies to it.
  const isGhostWindow = windowContext.kind === "drag-ghost";
  // Prefetch the settings chunk once startup work has settled.
  useEffect(() => {
    if (editorFilePath || isGhostWindow) return;
    const id = setTimeout(() => void loadSettingsPage(), 2000);
    return () => clearTimeout(id);
  }, [editorFilePath, isGhostWindow]);
  // Plugin system bootstrap: hardening + event bridge + builtin/installed
  // plugin activation. Failures are logged, never fatal to the host UI.
  useEffect(() => {
    if (editorFilePath || isGhostWindow) return;
    return startPluginSystem();
  }, [editorFilePath, isGhostWindow]);
  // Intercept the window close button so quitting the main window needs a
  // confirmation (no-op in extra windows and in web-access mode).
  useEffect(() => {
    if (isGhostWindow) return;
    return installCloseConfirm();
  }, [isGhostWindow]);
  // Desktop-grade selection: a press on chrome (tabs, dividers, empty space)
  // turns the window non-selectable until release, so dragging never smears
  // a selection across the pane the way a web page does.
  useEffect(() => installSelectionGuard(), []);
  // An editor window closed: hand its file back to the window that moved the
  // tab out (the close is broadcast to every window; only the source window
  // claims it).
  useEffect(() => {
    if (editorFilePath || isGhostWindow) return;
    const unlisten = listenEditorWindowClosed((filePath) => {
      if (claimMovedOutEditorTab(filePath)) {
        void useFilesStore.getState().openFile(filePath);
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [editorFilePath, isGhostWindow]);
  // Global keyboard-shortcut runtime: one dispatcher handler binding the
  // configured keys to registered action handlers / palette commands.
  useEffect(() => {
    if (isGhostWindow) return;
    return startShortcutRuntime();
  }, [isGhostWindow]);
  // Background update check after startup settles; dev builds skip it so
  // `tauri dev` doesn't nag about the published release being newer.
  useEffect(() => {
    if (editorFilePath || isGhostWindow || import.meta.env.DEV) return;
    const id = setTimeout(() => void useUpdateStore.getState().checkForUpdates(), 3000);
    return () => clearTimeout(id);
  }, [editorFilePath, isGhostWindow]);

  // Drag ghost window (?ctx=drag-ghost): a bare card the native window shows
  // under the cursor while an editor tab is dragged outside the main window.
  if (windowContext.kind === "drag-ghost") {
    return <DragGhostCard label={windowContext.label} />;
  }

  if (editorFilePath) {
    return (
      <LazyMotion features={domAnimation}>
        <EditorWindow filePath={editorFilePath} />
        {/* Opening files outside the registered workspaces still routes
            through the one-click grant dialog. */}
        <GrantAccessDialogHost />
      </LazyMotion>
    );
  }

  return (
    <LazyMotion features={domAnimation}>
      <HashRouter>
        {/* ChatPage stays mounted on every route; /settings only adds the
            modal overlay on top, so opening/closing settings never rebuilds
            the chat tree. */}
        <ChatPage />
        {/* ⌘K command palette (plan §4.2 #9); a pure projection of
            commandRegistry, mounted once for the whole app. */}
        <CommandPalette />
        <Routes>
          <Route
            path="/settings"
            element={
              <Suspense fallback={null}>
                <SettingsPage />
              </Suspense>
            }
          />
          {/* Plugin overlay pages (plan §4.2 #10); ChatPage stays mounted
              underneath, same as the /settings overlay. */}
          <Route path="/p/:pageId" element={<PluginPageHost />} />
        </Routes>
      </HashRouter>
      <UpdateToast />
      <GrantAccessDialogHost />
      <CloseConfirmDialogHost />
      <ShortcutsGuideModal />
    </LazyMotion>
  );
}
