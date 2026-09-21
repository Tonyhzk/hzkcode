/**
 * Global drag guard for the desktop window. A press that begins on chrome —
 * a tab strip, a pane divider, empty space — turns the whole window
 * non-selectable until release (`html[data-window-dragging]`, see
 * globals.css): WebKit starts a selection the moment such a drag sweeps over
 * selectable text, so dragging a tab or a divider used to smear a selection
 * across the pane like a web page. A press on a readable surface opts out,
 * keeping text selection exactly as before.
 */

/** Readable surfaces, mirroring the `user-select: text` whitelist in
 *  styles/globals.css — keep the two in sync. */
const SELECTABLE_SELECTOR =
  'input, textarea, select, [contenteditable="true"], .cm-editor, .prose-chat, pre, code, [data-selectable]';

/** Installs the guard; returns the uninstaller (App unmount / tests). */
export function installSelectionGuard(): () => void {
  const root = document.documentElement;
  const clear = () => {
    delete root.dataset.windowDragging;
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    if (
      target &&
      typeof target.closest === "function" &&
      target.closest(SELECTABLE_SELECTOR)
    ) {
      // Also drops a stale flag from a pointerup the window never saw.
      clear();
      return;
    }
    root.dataset.windowDragging = "";
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", clear, true);
  document.addEventListener("pointercancel", clear, true);
  // A drag that leaves the window (release outside, app switch) never
  // delivers pointerup; blur is the reliable "press is over" signal.
  window.addEventListener("blur", clear);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointerup", clear, true);
    document.removeEventListener("pointercancel", clear, true);
    window.removeEventListener("blur", clear);
    clear();
  };
}
