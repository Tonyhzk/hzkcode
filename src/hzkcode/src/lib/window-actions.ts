import { ipc } from "./ipc";
import { isWeb } from "./transport";
import { windowLabel } from "./window-context";

/**
 * Window-opening actions. Desktop creates real Tauri windows; web-access
 * mode falls back to a browser tab pointing at the same `?ctx=…` URL, which
 * the bundle resolves into the same window role on load.
 */

function ctxUrl(params: Record<string, string>): string {
  const search = new URLSearchParams(params).toString();
  return `${window.location.origin}${window.location.pathname}?${search}`;
}

/** Open one conversation in its own window. Returns false when the desktop
 *  window could not be created (the caller keeps its tab open). */
export async function openChatWindow(
  engine: string,
  sessionId: string,
  workspacePath: string,
): Promise<boolean> {
  if (isWeb) {
    window.open(
      ctxUrl({ ctx: "chat", engine, sessionId, workspacePath }),
      "_blank",
      "noopener",
    );
    return true;
  }
  try {
    await ipc.openChatWindow(engine, sessionId, workspacePath);
    return true;
  } catch (error) {
    console.error("[window] failed to open chat window", error);
    return false;
  }
}

/** Open one file in a standalone editor window. `screenPosition` (logical
 *  screen coordinates) opens it with its top-left at that point. */
export async function openEditorWindow(
  filePath: string,
  screenPosition?: { x: number; y: number },
): Promise<boolean> {
  if (isWeb) {
    window.open(ctxUrl({ ctx: "editor", filePath }), "_blank", "noopener");
    return true;
  }
  try {
    await ipc.openEditorWindow(filePath, screenPosition ?? null);
    return true;
  } catch (error) {
    console.error("[window] failed to open editor window", error);
    return false;
  }
}

/** Remember which window gave a file tab away to a standalone editor window,
 *  so that window's close can hand the file back (lib.rs broadcasts
 *  `editor://window-closed` to every window; each window claims the file only
 *  when the record names it). localStorage is shared across the app's
 *  windows, hence the label in the value. */
export function rememberEditorTabMovedOut(filePath: string): void {
  try {
    localStorage.setItem(movedOutKey(filePath), windowLabel());
  } catch {
    // Storage can be unavailable; the file then simply is not restored.
  }
}

/** True when THIS window moved the tab out. The record is consumed only by
 *  the owner: the close event is broadcast to every window in no particular
 *  order, so a non-owner pass must leave the record for the real owner. */
export function claimMovedOutEditorTab(filePath: string): boolean {
  const key = movedOutKey(filePath);
  try {
    const owner = localStorage.getItem(key);
    if (owner === null || owner !== windowLabel()) return false;
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function movedOutKey(filePath: string): string {
  return `hzkcode.editorMovedOut:${filePath}`;
}
