import { getCurrentWindow } from "@tauri-apps/api/window";
import { isWeb } from "./transport";

/**
 * Multi-window identity. The app runs the same frontend bundle in every
 * window; the URL query decides what that window shows (a conversation, a
 * standalone file editor, or the full main interface). Windows created by
 * the app carry `?ctx=…`; anything else — including web-access tabs — is the
 * main window.
 */

export type WindowContext =
  | { kind: "main" }
  | { kind: "chat"; engine: string; sessionId: string; workspacePath: string }
  | { kind: "editor"; filePath: string }
  | { kind: "drag-ghost"; label: string };

export function parseWindowContext(search: string): WindowContext {
  const params = new URLSearchParams(search);
  const ctx = params.get("ctx");
  if (ctx === "chat") {
    const engine = params.get("engine");
    const sessionId = params.get("sessionId");
    const workspacePath = params.get("workspacePath");
    // Incomplete params fall through to main so the window never renders blank.
    if (engine && sessionId && workspacePath) {
      return { kind: "chat", engine, sessionId, workspacePath };
    }
  }
  if (ctx === "editor") {
    const filePath = params.get("filePath");
    if (filePath) return { kind: "editor", filePath };
  }
  if (ctx === "drag-ghost") {
    return { kind: "drag-ghost", label: params.get("label") ?? "" };
  }
  return { kind: "main" };
}

export const windowContext: WindowContext =
  typeof window === "undefined"
    ? { kind: "main" }
    : parseWindowContext(window.location.search);

/** Current window label; "main" in web-access mode and wherever the Tauri
 *  API is absent (tests, plain browsers). */
export function windowLabel(): string {
  if (isWeb) return "main";
  try {
    return getCurrentWindow().label || "main";
  } catch {
    return "main";
  }
}

/** localStorage key suffix isolating per-window chat state. The main window
 *  keeps the legacy keys so existing installs restore exactly as before;
 *  extra windows get their own tab list and active session. */
export function windowStorageSuffix(): string {
  const label = windowLabel();
  return label === "main" ? "" : `:w:${label}`;
}
