import { ipc } from "./ipc";
import { isWeb } from "./transport";

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

/** Open one file in a standalone editor window. */
export async function openEditorWindow(filePath: string): Promise<boolean> {
  if (isWeb) {
    window.open(ctxUrl({ ctx: "editor", filePath }), "_blank", "noopener");
    return true;
  }
  try {
    await ipc.openEditorWindow(filePath);
    return true;
  } catch (error) {
    console.error("[window] failed to open editor window", error);
    return false;
  }
}
