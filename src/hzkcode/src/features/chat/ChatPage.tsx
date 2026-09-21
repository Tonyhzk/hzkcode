import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { sessionKey, useChatStore } from "./store";
import { ErrorBanner } from "./components/ErrorBanner";
import { ChatConversation } from "./components/ChatConversation";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import { AppStatusBar } from "@/components/application/app-status-bar/app-status-bar";
import { isWeb } from "@/lib/platform";
import { useTitlebarStyle } from "@/features/settings/titlebar";
import { TerminalDock } from "@/features/terminal/TerminalDock";
import { useTerminalStore } from "@/features/terminal/store";
import { useGitStore } from "@/features/git/store";
import { useFilesStore } from "@/features/files/store";
import { EditorDock } from "@/features/files/EditorDock";
import { moveFileToNewWindow } from "@/features/files/open-in-window";
import type { SessionMeta } from "@/lib/ipc";
import { windowContext } from "@/lib/window-context";
import { cx } from "@/utils/cx";
import { useMediaQuery } from "@/hooks/use-media-query";
import { EDITOR_MIN_WIDTH, useLayoutPanels } from "./use-layout-panels";
import {
  useChatPageLifecycle,
  useChatShortcutHandlers,
  useLayoutCommands,
} from "./use-chat-page-effects";
import { useChatSidebar } from "./use-chat-sidebar";
import { ChatPageDialogs, type ChatPageDialog } from "./ChatPageDialogs";
import { ChatTopBar } from "./ChatTopBar";
import { ChatSidebarFrame } from "./ChatSidebarFrame";
import { ChatSidePanel } from "./ChatSidePanel";
// Side-effect import: registers the builtin files/changes tabs into
// panelTabRegistry (plan §4.2 #4).
import "./panel-tabs";

// Windows keeps its native titlebar (titleBarStyle Overlay is macOS-only), so
// the caption row sits directly on the app background with no visual break —
// draw a hairline under it. Web mode has browser chrome; skip there.
const NEEDS_TITLEBAR_HAIRLINE =
  !isWeb &&
  typeof navigator !== "undefined" &&
  /windows/i.test(navigator.userAgent);

// Below Tailwind's xl breakpoint the side panel and the conversation column
// cannot both be comfortable, so the panel defaults to collapsed there. It
// stays expandable: the titlebar toggle renders at every width.
const PANEL_MEDIA = "(max-width: 1279px)";
// Floor reserved for the conversation column when clamping panel widths.
const CHAT_MIN_WIDTH = 320;

/** Four-column workspace, left to right: session list, conversation, file
 *  list (files/changes), and the multi-tab file editor dock. The
 *  conversation column is always just the conversation — editors and diffs
 *  live in the right-most dock, never on top of it. */
export default function ChatPage() {
  const { t } = useTranslation();
  const titlebarStyle = useTitlebarStyle();
  // Store actions/slices are stable or low-frequency references. The
  // high-frequency session/draft subscriptions live in ChatConversation
  // (components/ChatConversation.tsx).
  const init = useChatStore((s) => s.init);
  const engines = useChatStore((s) => s.engines);
  const workspaces = useChatStore((s) => s.workspaces);
  const sessions = useChatStore((s) => s.sessions);
  const streamingByKey = useChatStore((s) => s.streamingByKey);
  const active = useChatStore((s) => s.active);
  const actionError = useChatStore((s) => s.actionError);
  const dismissActionError = useChatStore((s) => s.dismissActionError);
  const gitRefresh = useGitStore((s) => s.refresh);
  // The changes diff renders in the editor dock; the row below must expand
  // that dock when a diff opens, same as it does for files.
  const diffView = useGitStore((s) => s.diffView);
  // Terminal dock: toggled from the header open-actions cluster (and ⌘J).
  const toggleTerminal = useTerminalStore((s) => s.toggle);
  const activeFilePath = useFilesStore((s) => s.activeFilePath);
  const [dialog, setDialog] = useState<ChatPageDialog | null>(null);
  const composerInputRef = useRef<ComposerInputHandle>(null);
  const {
    panelWidth,
    panelCollapsed,
    togglePanelCollapsed,
    setPanelCollapsedValue,
    panelTab,
    setPanelTab,
    sidebarCollapsed,
    toggleSidebarCollapsed,
    collapseSidebarOnMobile,
    sidebarWidth,
    editorWidth,
    editorCollapsed,
    toggleEditorCollapsed,
    setEditorCollapsedValue,
    dragging,
    handleResizeStart,
    panelRef,
    editorRef,
    sidebarRef,
    sidebarResizerRef,
  } = useLayoutPanels();

  // Narrow windows default to a collapsed panel. The override is local and
  // deliberately NOT persisted: toggling while narrow must not clobber the
  // wide-window preference, and every breakpoint crossing re-applies the
  // default while an explicit expand sticks until the next crossing.
  const narrowPanel = useMediaQuery(PANEL_MEDIA);
  const [narrowPanelExpanded, setNarrowPanelExpanded] = useState(false);
  useEffect(() => {
    setNarrowPanelExpanded(false);
  }, [narrowPanel]);
  const panelCollapsedEffective = narrowPanel
    ? !narrowPanelExpanded
    : panelCollapsed;
  const handleTogglePanel = useCallback(() => {
    if (narrowPanel) setNarrowPanelExpanded((prev) => !prev);
    else togglePanelCollapsed();
  }, [narrowPanel, togglePanelCollapsed]);
  // The persisted width can exceed what is left beside the sidebar, so clamp
  // it for rendering only: storage keeps the user's width, and drags still
  // mutate style.width imperatively against the real min/max. Measured off
  // the center row rather than window.innerWidth because the sidebar overlays
  // the content below md instead of taking layout space.
  const centerRowRef = useRef<HTMLDivElement>(null);
  const [centerRowWidth, setCenterRowWidth] = useState(0);
  useEffect(() => {
    const el = centerRowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setCenterRowWidth(el.getBoundingClientRect().width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Before the first measurement centerRowWidth is 0; fall back to the stored
  // width so the panel does not flash collapsed on mount.
  const panelWidthEffective =
    centerRowWidth > 0
      ? Math.min(panelWidth, Math.max(0, centerRowWidth - CHAT_MIN_WIDTH))
      : panelWidth;
  // Same clamp for the editor dock, sharing what remains after the panel.
  const editorAvail = Math.max(
    0,
    centerRowWidth -
      CHAT_MIN_WIDTH -
      (panelCollapsedEffective ? 0 : panelWidthEffective),
  );
  const editorWidthEffective = editorCollapsed
    ? 0
    : centerRowWidth > 0
      ? Math.min(editorWidth, editorAvail)
      : editorWidth;
  const editorVisible = !editorCollapsed && editorWidthEffective > 0;

  // Opening a file — or the changes diff — must never land in a hidden dock:
  // expand it, and reclaim space from the file panel when the row cannot fit
  // both side by side. Clicking another changed file while a diff is already
  // open swaps the target, which counts as opening too.
  const lastActiveFilePath = useRef<string | null>(null);
  const lastDiffView = useRef<typeof diffView>(null);
  useEffect(() => {
    const fileOpened =
      activeFilePath !== null && activeFilePath !== lastActiveFilePath.current;
    const diffOpened = diffView !== null && diffView !== lastDiffView.current;
    lastActiveFilePath.current = activeFilePath;
    lastDiffView.current = diffView;
    if (!fileOpened && !diffOpened) return;
    setEditorCollapsedValue(false);
    if (centerRowWidth <= 0) return;
    const avail =
      centerRowWidth -
      CHAT_MIN_WIDTH -
      (panelCollapsedEffective ? 0 : panelWidthEffective);
    if (avail < EDITOR_MIN_WIDTH && !panelCollapsedEffective) {
      setPanelCollapsedValue(true);
      if (narrowPanel) setNarrowPanelExpanded(false);
    }
  }, [
    activeFilePath,
    diffView,
    centerRowWidth,
    panelCollapsedEffective,
    panelWidthEffective,
    narrowPanel,
    setEditorCollapsedValue,
    setPanelCollapsedValue,
  ]);

  useLayoutCommands(handleTogglePanel, toggleSidebarCollapsed);
  // Sidebar data: sessions indexed by tab key, plus per-thread streaming
  // flags for the status dots.
  const sessionById = useMemo(() => {
    const map = new Map<string, SessionMeta>();
    for (const s of sessions) map.set(`${s.engine}/${s.sessionId}`, s);
    return map;
  }, [sessions]);
  const threadStreaming = useMemo(
    () =>
      sessions.map(
        (sess) =>
          streamingByKey[sessionKey(sess.engine, sess.sessionId, sess.workspacePath)] === true,
      ),
    [sessions, streamingByKey],
  );
  const title = useMemo(() => {
    if (!active) return "";
    const meta = active.sessionId
      ? sessionById.get(`${active.engine}/${active.sessionId}`)
      : undefined;
    return meta?.customTitle || meta?.title || t("chat.newChat");
  }, [active, sessionById, t]);
  // Extra conversation windows show the session name in the native title bar.
  useEffect(() => {
    if (windowContext.kind !== "chat" || !title) return;
    if (isWeb) {
      document.title = title;
      return;
    }
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  }, [title]);
  const {
    startNewChat,
    repos,
    sections,
    archivedRepos,
    handleAddWorkspace,
    handleThreadSelect,
    handleThreadAction,
    handleCopyThreadId,
    handleRemoveWorkspace,
    handleWorkspaceAlias,
    handleSetWorkspaceArchived,
    handleNewSession,
    handleNewSessionInWorkspace,
    handleReorderWorkspaces,
    handleDropWorkspaceToSection,
  } = useChatSidebar({
    sessionById,
    threadStreaming,
    collapseSidebarOnMobile,
    composerInputRef,
    setDialog,
  });

  useChatPageLifecycle(init, gitRefresh, active?.workspacePath);
  useChatShortcutHandlers(
    active?.workspacePath,
    toggleTerminal,
    handleNewSession,
  );

  // Editor dock interactions: unsaved tabs route through the save dialog;
  // dragging a tab out of the window moves it into a standalone editor.
  const handleDirtyClose = useCallback((path: string) => {
    setDialog({ kind: "closeFile", path });
  }, []);
  const handleDragOut = useCallback(
    (path: string, screenPosition: { x: number; y: number }) => {
      if (useFilesStore.getState().dirtyPaths[path]) {
        setDialog({ kind: "dragOutFile", path, screenPosition });
      } else {
        void moveFileToNewWindow(path, screenPosition);
      }
    },
    [],
  );

  return (
    <div
      className={cx(
        "relative flex h-dvh w-full overflow-hidden bg-background-secondary-default",
        // Phones with `viewport-fit=cover` (index.html) lay the app under the
        // status bar/notch: without the inset the top bar — and with it the
        // only way to switch sessions — sits behind the iOS chrome.
        "pt-[env(safe-area-inset-top)]",
        // Same for the home indicator: it overlays AppStatusBar otherwise.
        "pb-[env(safe-area-inset-bottom)]",
        NEEDS_TITLEBAR_HAIRLINE && titlebarStyle === "native" && "border-t border-separator-border",
        dragging && "cursor-col-resize select-none",
      )}
    >
      <ChatSidebarFrame
        active={active}
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        dragging={dragging}
        sidebarRef={sidebarRef}
        resizerRef={sidebarResizerRef}
        onResizeStart={handleResizeStart("sidebar")}
        onClose={toggleSidebarCollapsed}
        repos={repos}
        sections={sections}
        onThreadSelect={handleThreadSelect}
        onThreadAction={handleThreadAction}
        onCopyThreadId={handleCopyThreadId}
        onAddWorkspace={handleAddWorkspace}
        onRemoveWorkspace={handleRemoveWorkspace}
        onWorkspaceAlias={handleWorkspaceAlias}
        onSetWorkspaceArchived={handleSetWorkspaceArchived}
        archivedRepos={archivedRepos}
        onNewSessionInWorkspace={handleNewSessionInWorkspace}
        onNewSession={handleNewSession}
        onReorderWorkspaces={handleReorderWorkspaces}
        onDropWorkspaceToSection={handleDropWorkspaceToSection}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background-primary-default md:rounded-l-[14px] md:border-l md:border-separator-border">
        <ChatTopBar
          title={title}
          workspacePath={active?.workspacePath}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebarCollapsed}
          editorCollapsed={editorCollapsed}
          onToggleEditor={toggleEditorCollapsed}
          panelCollapsed={panelCollapsedEffective}
          onTogglePanel={handleTogglePanel}
        />

        {actionError && (
          <ErrorBanner
            className="mx-4 mt-2"
            message={`${t("common.error")}: ${actionError}`}
            onDismiss={dismissActionError}
          />
        )}

        <div
          ref={centerRowRef}
          className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          {/* Conversation column: always just the conversation. */}
          <div className="relative flex min-w-0 flex-1 basis-0 flex-col overflow-hidden bg-background-primary-default">
            <ChatConversation
              active={active}
              engines={engines}
              workspaces={workspaces}
              startNewChat={startNewChat}
              composerInputRef={composerInputRef}
            />
          </div>
          <ChatSidePanel
            active={active}
            panelRef={panelRef}
            panelWidth={panelWidthEffective}
            panelCollapsed={panelCollapsedEffective}
            dragging={dragging}
            panelTab={panelTab}
            onPanelTabChange={setPanelTab}
            onResizeStart={handleResizeStart("panel")}
          />
          <EditorDock
            width={editorWidthEffective}
            collapsed={!editorVisible}
            dragging={dragging}
            dockRef={editorRef}
            onResizeStart={handleResizeStart("editor")}
            onDirtyClose={handleDirtyClose}
            onDragOut={handleDragOut}
          />
        </div>
        {active && <TerminalDock workspacePath={active.workspacePath} />}
        <AppStatusBar />
      </div>

      <ChatPageDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}
