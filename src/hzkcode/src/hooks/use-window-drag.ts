import { useEffect } from "react";
import type { RefObject } from "react";
import { isWeb, startWindowDrag } from "@/lib/platform";

// Interactive elements keep their click behavior; any other press inside the
// strip (empty padding, container wrappers, panel header blanks) starts a
// window drag. data-tauri-drag-region alone only fires when the press lands
// on the element carrying the attribute, never on its children — so the
// nested containers swallowing most of the titlebar could not drag.
export const DRAG_IGNORE_SELECTOR = "button, a, input, textarea, select, [role='tab']";

/** Window drag: presses that miss every interactive element start dragging
 *  the window (overlay titlebar). Native listener — the drag region is a
 *  window-level gesture, not a control with click/keyboard semantics. */
export function useWindowDragRegion(stripRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onMouseDown = (e: globalThis.MouseEvent) => {
      // No native titlebar to drag in web-access mode.
      if (isWeb || e.button !== 0) return;
      if ((e.target as HTMLElement).closest(DRAG_IGNORE_SELECTOR)) return;
      e.preventDefault();
      startWindowDrag();
    };
    el.addEventListener("mousedown", onMouseDown);
    return () => el.removeEventListener("mousedown", onMouseDown);
  }, [stripRef]);
}
