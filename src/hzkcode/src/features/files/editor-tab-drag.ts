import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const DRAG_THRESHOLD = 5;
/** Distance (px) from a window edge that counts as "dragged out". Pointer
 *  capture keeps events flowing when the pointer leaves the window, but
 *  WKWebView does not guarantee events past the edge, so releasing while the
 *  pointer sits against an edge is the reliable signal. */
const DRAG_OUT_EDGE = 6;

/** True when the pointer sits against the window's right, left or top edge —
 *  releasing a dragged editor tab there opens it in a dedicated window. */
export function isDragOutPosition(x: number, y: number): boolean {
  if (typeof window === "undefined") return false;
  return (
    x >= window.innerWidth - DRAG_OUT_EDGE ||
    x <= DRAG_OUT_EDGE ||
    y <= DRAG_OUT_EDGE
  );
}

/** Pointer-driven tab drag for the editor dock: reorder within the strip, or
 *  drag out of the window to move the tab into a standalone editor window.
 *  Pointer events, not HTML5 DnD: WKWebView never delivers dragover/drop, so
 *  native DnD only reordered in Chromium. A 5px threshold keeps plain clicks
 *  intact. */
export function useEditorTabDrag({
  onReorder,
  onDragOut,
}: {
  onReorder?: (draggedKey: string, targetKey: string, before: boolean) => void;
  onDragOut?: (draggedKey: string) => void;
}) {
  const dragStateRef = useRef<{ key: string; startX: number; dragging: boolean } | null>(null);
  const dragOutRef = useRef(false);
  const [dragOutActive, setDragOutActive] = useState(false);
  const [dropTarget, setDropTarget] = useState<{
    draggedKey: string;
    key: string;
    before: boolean;
  } | null>(null);
  // pointerup fires before click; swallow the click that ends a drag.
  const suppressClickRef = useRef(false);

  function handleTabPointerDown(key: string) {
    return (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // Dragging from the close button feels broken; keep it click-only.
      if ((e.target as HTMLElement).closest("button")) return;
      // Pointer capture lets the drag continue once the pointer leaves the
      // window, so a release outside the right edge can still be seen.
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // Capture is best-effort; the edge fallback below still applies.
      }
      dragStateRef.current = { key, startX: e.clientX, dragging: false };
    };
  }

  useEffect(() => {
    const targetAt = (x: number, y: number, excludeKey: string) => {
      const el = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-tab-key]");
      const key = el?.dataset.tabKey;
      if (!el || !key || key === excludeKey) return null;
      const rect = el.getBoundingClientRect();
      return { key, before: x < rect.left + rect.width / 2 };
    };
    const onMove = (e: PointerEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      if (!st.dragging) {
        if (Math.abs(e.clientX - st.startX) < DRAG_THRESHOLD) return;
        st.dragging = true;
      }
      const out = isDragOutPosition(e.clientX, e.clientY);
      dragOutRef.current = out;
      setDragOutActive(out);
      if (out) {
        setDropTarget(null);
        return;
      }
      const target = targetAt(e.clientX, e.clientY, st.key);
      setDropTarget((prev) => {
        const next = target ? { draggedKey: st.key, ...target } : null;
        return prev?.key === next?.key &&
          prev?.before === next?.before &&
          prev?.draggedKey === next?.draggedKey
          ? prev
          : next;
      });
    };
    const onUp = (e: PointerEvent) => {
      const st = dragStateRef.current;
      dragStateRef.current = null;
      const wasOut = dragOutRef.current;
      dragOutRef.current = false;
      setDragOutActive(false);
      setDropTarget(null);
      if (!st?.dragging) return;
      suppressClickRef.current = true;
      // The click ending the drag fires right after pointerup — but when
      // the press lands on one tab and releases on another, it targets
      // their container instead, never reaching a tab's onClick. Clear the
      // flag on the next task so it can't swallow a later genuine click.
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      if (wasOut) {
        onDragOut?.(st.key);
        return;
      }
      const target = targetAt(e.clientX, e.clientY, st.key);
      if (target) onReorder?.(st.key, target.key, target.before);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [onReorder, onDragOut]);

  return { dropTarget, dragOutActive, suppressClickRef, handleTabPointerDown };
}
