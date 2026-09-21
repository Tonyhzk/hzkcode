import { useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { ipc } from "@/lib/ipc";

/** Distance (px) from a window edge that counts as "dragged out". */
const DRAG_OUT_EDGE = 6;

/** Custom MIME for the dragged tab: gives the drag a data item to carry
 *  (required for it to start at all) while dropping on another app stays
 *  inert. */
const TAB_MIME = "application/x-hzkcode-tab";

/** Fallback ghost height (h-7) for the bottom-rim clamp before a tab rect is
 *  measured. */
const GHOST_HEIGHT = 28;

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

/** Clamp a ghost coordinate so the card stays inside the window — DOM content
 *  cannot paint past the window edge. */
function clampAxis(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(Math.max(value, 0), max);
}

/** 1×1 transparent GIF, preloaded at module scope. WebKit aborts the whole
 *  drag when the drag image is not fully loaded — and a canvas snapshot it
 *  cannot rasterize behaves the same — so the image must be ready long before
 *  any dragstart. A transparent image keeps the platform's "fly back on
 *  cancel" animation invisible (Chromium-based apps like VS Code simply do
 *  not animate a cancelled drag); the visible feedback is our own ghost. */
export const EMPTY_DRAG_IMAGE = new Image(1, 1);
EMPTY_DRAG_IMAGE.src =
  "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICTAEAOw==";

/** "file:/a/b/c.ts" → "c.ts": the text the ghost card shows. */
function tabLabel(key: string): string {
  const path = key.replace(/^file:/, "");
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Editor-tab drag on HTML5 drag-and-drop. The system drag image is made
 * transparent (see `EMPTY_DRAG_IMAGE`) and the visible feedback is a ghost
 * card: a DOM card while the pointer is inside the window, and — once it
 * leaves, where DOM content cannot paint — a native follow-the-cursor window
 * (see drag_ghost.rs). `dragend` fires on the source tab wherever the release
 * happened, so a drop outside the window is still seen.
 *
 * Requires Tauri's own drag-drop handler to be off (see
 * windows::build_window), otherwise the webview never receives these events.
 */
export function useEditorTabDrag({
  onReorder,
  onDragOut,
}: {
  onReorder?: (draggedKey: string, targetKey: string, before: boolean) => void;
  onDragOut?: (
    draggedKey: string,
    screenPosition: { x: number; y: number },
  ) => void;
}) {
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  /** DOM ghost card following the pointer while it is inside the window. */
  const [dragGhost, setDragGhost] = useState<{
    key: string;
    x: number;
    y: number;
    width: number;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    draggedKey: string;
    key: string;
    before: boolean;
  } | null>(null);
  const [dragOutActive, setDragOutActive] = useState(false);
  // Refs mirror the state so `dragend` reads the final values without waiting
  // for a re-render, and the document-level listeners can bail out cheaply
  // when no tab drag is in flight.
  const draggedKeyRef = useRef<string | null>(null);
  const dropTargetRef = useRef<{ key: string; before: boolean } | null>(null);
  /** The pointer left the window mid-drag (document dragleave with no
   *  relatedTarget). `dragend`'s coordinates are not trustworthy once
   *  outside, so this is the reliable "out" flag. */
  const leftWindowRef = useRef(false);
  /** The native ghost window took over the visible feedback (pointer is
   *  outside the window). */
  const nativeGhostRef = useRef(false);
  // A click may follow dragend; swallow the one that ends a drag.
  const suppressClickRef = useRef(false);
  /** Pointer offset inside the tab when the drag started, so the ghost keeps
   *  that grip instead of snapping its corner to the cursor. */
  const grabOffsetRef = useRef({ x: 0, y: 0 });
  /** Ghost card size = the dragged tab's size. */
  const ghostWidthRef = useRef(0);
  const ghostHeightRef = useRef(0);

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      const key = draggedKeyRef.current;
      if (!key) return;
      // Marking the hovered area as a drop target keeps the drag alive (and
      // the cursor as "move") across the strip.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      if (!nativeGhostRef.current) {
        setDragGhost({
          key,
          x: clampAxis(
            e.clientX - grabOffsetRef.current.x,
            window.innerWidth - ghostWidthRef.current,
          ),
          y: clampAxis(
            e.clientY - grabOffsetRef.current.y,
            window.innerHeight - GHOST_HEIGHT,
          ),
          width: ghostWidthRef.current,
        });
      }
      const out = isDragOutPosition(e.clientX, e.clientY);
      setDragOutActive(out);
      if (out) {
        dropTargetRef.current = null;
        setDropTarget(null);
        return;
      }
      const el = (e.target as Element | null)?.closest<HTMLElement>("[data-tab-key]");
      const targetKey = el?.dataset.tabKey;
      let target: { key: string; before: boolean } | null = null;
      if (el && targetKey && targetKey !== key) {
        const rect = el.getBoundingClientRect();
        target = { key: targetKey, before: e.clientX < rect.left + rect.width / 2 };
      }
      dropTargetRef.current = target;
      setDropTarget((prev) => {
        const next = target ? { draggedKey: key, ...target } : null;
        return prev?.key === next?.key &&
          prev?.before === next?.before &&
          prev?.draggedKey === next?.draggedKey
          ? prev
          : next;
      });
    };
    const onDragLeave = (e: DragEvent) => {
      const key = draggedKeyRef.current;
      if (!key) return;
      if (e.relatedTarget) return;
      leftWindowRef.current = true;
      // Past the window edge the DOM card cannot follow; hand the feedback to
      // the native window, which tracks the cursor on the Rust side.
      if (!nativeGhostRef.current) {
        nativeGhostRef.current = true;
        setDragGhost(null);
        void ipc
          .showDragGhost({
            label: tabLabel(key),
            width: ghostWidthRef.current,
            height: ghostHeightRef.current,
            offsetX: grabOffsetRef.current.x,
            offsetY: grabOffsetRef.current.y,
          })
          .catch(() => {});
      }
    };
    const onDragEnter = (e: DragEvent) => {
      if (!draggedKeyRef.current) return;
      if (e.relatedTarget) return;
      leftWindowRef.current = false;
      if (nativeGhostRef.current) {
        nativeGhostRef.current = false;
        void ipc.hideDragGhost().catch(() => {});
        // The DOM card reappears on the next dragover.
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!draggedKeyRef.current) return;
      // Accepting the drop (dragover already prevents the default) marks the
      // drag as handled.
      e.preventDefault();
    };
    document.addEventListener("dragover", onDragOver, true);
    document.addEventListener("dragleave", onDragLeave, true);
    document.addEventListener("dragenter", onDragEnter, true);
    document.addEventListener("drop", onDrop, true);
    return () => {
      document.removeEventListener("dragover", onDragOver, true);
      document.removeEventListener("dragleave", onDragLeave, true);
      document.removeEventListener("dragenter", onDragEnter, true);
      document.removeEventListener("drop", onDrop, true);
      // The window may be torn down mid-drag (close, reload): never leave the
      // native ghost window behind.
      if (nativeGhostRef.current) {
        nativeGhostRef.current = false;
        void ipc.hideDragGhost().catch(() => {});
      }
    };
  }, []);

  function handleTabDragStart(key: string) {
    return (e: ReactDragEvent<HTMLDivElement>) => {
      draggedKeyRef.current = key;
      dropTargetRef.current = null;
      leftWindowRef.current = false;
      setDraggedKey(key);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(TAB_MIME, key);
      // Transparent system image: the platform's cancel animation still
      // plays, but with nothing visible in it. Skipped while the preloaded
      // image is somehow not ready — Safari aborts the drag in that case, and
      // the default image is better than no drag at all.
      if (EMPTY_DRAG_IMAGE.complete) {
        e.dataTransfer.setDragImage(EMPTY_DRAG_IMAGE, 0, 0);
      }
      const tabEl = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-tab-key]");
      const rect = tabEl?.getBoundingClientRect();
      grabOffsetRef.current = rect
        ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
        : { x: 0, y: 0 };
      ghostWidthRef.current = rect?.width ?? 0;
      ghostHeightRef.current = rect?.height ?? GHOST_HEIGHT;
      setDragGhost({
        key,
        x: e.clientX - grabOffsetRef.current.x,
        y: e.clientY - grabOffsetRef.current.y,
        width: ghostWidthRef.current,
      });
    };
  }

  function handleTabDragEnd(key: string) {
    return (e: ReactDragEvent<HTMLDivElement>) => {
      // A stray dragend (no drag in flight): nothing to settle.
      if (!draggedKeyRef.current) return;
      const wasOut =
        leftWindowRef.current || isDragOutPosition(e.clientX, e.clientY);
      const target = dropTargetRef.current;
      draggedKeyRef.current = null;
      dropTargetRef.current = null;
      leftWindowRef.current = false;
      if (nativeGhostRef.current) {
        nativeGhostRef.current = false;
        void ipc.hideDragGhost().catch(() => {});
      }
      setDraggedKey(null);
      setDragGhost(null);
      setDropTarget(null);
      setDragOutActive(false);
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      if (wasOut) {
        onDragOut?.(key, { x: e.screenX, y: e.screenY });
        return;
      }
      if (target && target.key !== key) {
        onReorder?.(key, target.key, target.before);
      }
    };
  }

  return {
    draggedKey,
    dragGhost,
    dropTarget,
    dragOutActive,
    suppressClickRef,
    handleTabDragStart,
    handleTabDragEnd,
  };
}
