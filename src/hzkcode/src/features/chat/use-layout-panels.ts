import { useCallback, useEffect, useRef, useState } from "react";
import { MOBILE_MEDIA } from "@/hooks/use-media-query";
import { readStoredBool, readStoredNumber, writeStored } from "@/lib/storage";

// The squeeze floor: dragging the editor's edge may tighten the file-list
// column this far; the default opens wider so a fresh window reads well. The
// caps are generous because the row itself (and the chat minimum) already
// bounds the two columns — tighter caps only froze the editor|panel border
// once both columns sat at their maximum.
const PANEL_MIN_WIDTH = 100;
const PANEL_MAX_WIDTH = 1000;
const PANEL_DEFAULT_WIDTH = 150;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 260;
const EDITOR_MIN_WIDTH = 320;
const EDITOR_MAX_WIDTH = 1400;
const EDITOR_DEFAULT_WIDTH = 420;
const PANEL_COLLAPSED_KEY = "hzkcode.panelCollapsed";
const PANEL_WIDTH_MIGRATION_KEY = "hzkcode.panelWidthMigrated";
/** The old default = minimum width of the file-list column, before it was
 *  tightened (300 → 150); stored values at exactly this width migrate once. */
const LEGACY_PANEL_MIN_WIDTH = 300;
const SIDEBAR_COLLAPSED_KEY = "hzkcode.sidebarCollapsed";
const EDITOR_COLLAPSED_KEY = "hzkcode.editorCollapsed";
const PANEL_WIDTH_KEY = "hzkcode.panelWidth";
const SIDEBAR_WIDTH_KEY = "hzkcode.sidebarWidth";
const EDITOR_WIDTH_KEY = "hzkcode.editorWidth";

export type LayoutDragTarget = "sidebar" | "panel" | "editor";

/** Stored width, validated against the live min/max before use. */
function readStoredWidth(key: string, min: number, max: number, fallback: number): number {
  const raw = readStoredNumber(key, fallback);
  return raw >= min && raw <= max ? raw : fallback;
}

/** Sidebar + side-panel + file-editor chrome: persisted widths and collapse
 * flags, the files/changes panel tab, and full-height edge drag-resizing.
 * Every edge resizes the same way: press anywhere on the strip, drag,
 * release. Width is mutated directly during the drag; committing to state
 * once on pointerup avoids a re-render per pointermove. */
export function useLayoutPanels() {
  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = readStoredWidth(
      PANEL_WIDTH_KEY,
      PANEL_MIN_WIDTH,
      PANEL_MAX_WIDTH,
      PANEL_DEFAULT_WIDTH,
    );
    // A panel sitting at the legacy minimum was as narrow as the old UI
    // allowed; carry that intent to the tightened default exactly once, so a
    // later manual drag back to 300px is never re-migrated.
    if (!readStoredBool(PANEL_WIDTH_MIGRATION_KEY, false)) {
      writeStored(PANEL_WIDTH_MIGRATION_KEY, "1");
      if (stored === LEGACY_PANEL_MIN_WIDTH) {
        writeStored(PANEL_WIDTH_KEY, PANEL_DEFAULT_WIDTH);
        return PANEL_DEFAULT_WIDTH;
      }
    }
    return stored;
  });
  const [panelCollapsed, setPanelCollapsed] = useState(
    () => readStoredBool(PANEL_COLLAPSED_KEY, false),
  );
  const togglePanelCollapsed = useCallback(() => {
    setPanelCollapsed((prev) => {
      writeStored(PANEL_COLLAPSED_KEY, prev ? "0" : "1");
      return !prev;
    });
  }, []);
  const setPanelCollapsedValue = useCallback((collapsed: boolean) => {
    setPanelCollapsed((prev) => {
      if (prev === collapsed) return prev;
      writeStored(PANEL_COLLAPSED_KEY, collapsed ? "1" : "0");
      return collapsed;
    });
  }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readStoredBool(SIDEBAR_COLLAPSED_KEY, false),
  );
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      writeStored(SIDEBAR_COLLAPSED_KEY, prev ? "0" : "1");
      return !prev;
    });
  }, []);
  // Drawer behavior on phones: selecting anything dismisses the overlay.
  const collapseSidebarOnMobile = useCallback(() => {
    if (!window.matchMedia(MOBILE_MEDIA).matches) return;
    setSidebarCollapsed((prev) => {
      if (prev) return prev;
      writeStored(SIDEBAR_COLLAPSED_KEY, "1");
      return true;
    });
  }, []);
  const [editorWidth, setEditorWidth] = useState(() => readStoredWidth(EDITOR_WIDTH_KEY, EDITOR_MIN_WIDTH, EDITOR_MAX_WIDTH, EDITOR_DEFAULT_WIDTH));
  const [editorCollapsed, setEditorCollapsed] = useState(
    () => readStoredBool(EDITOR_COLLAPSED_KEY, false),
  );
  const toggleEditorCollapsed = useCallback(() => {
    setEditorCollapsed((prev) => {
      writeStored(EDITOR_COLLAPSED_KEY, prev ? "0" : "1");
      return !prev;
    });
  }, []);
  const setEditorCollapsedValue = useCallback((collapsed: boolean) => {
    setEditorCollapsed((prev) => {
      if (prev === collapsed) return prev;
      writeStored(EDITOR_COLLAPSED_KEY, collapsed ? "1" : "0");
      return collapsed;
    });
  }, []);
  const [dragging, setDragging] = useState<LayoutDragTarget | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH));
  const [panelTab, setPanelTab] = useState("files");
  const widthAtDragStart = useRef(PANEL_DEFAULT_WIDTH);
  const dragStartX = useRef(0);
  const dragWidth = useRef(PANEL_DEFAULT_WIDTH);
  // The editor drag also moves the file-list column (the three|four split
  // trades width between them), so it snapshots both columns.
  const panelWidthAtDragStart = useRef(PANEL_DEFAULT_WIDTH);
  const dragPanelWidth = useRef(PANEL_DEFAULT_WIDTH);
  /** The file-list column only joins the editor drag while it is on screen:
   *  a collapsed panel (rendered at width 0) must not come along. */
  const panelOnScreenAtDragStart = useRef(false);
  // The panel drag scales the editor along with it while both are on screen:
  // the pair keeps its ratio and the chat column absorbs the difference.
  const editorWidthAtDragStart = useRef(EDITOR_DEFAULT_WIDTH);
  const dragEditorWidth = useRef(EDITOR_DEFAULT_WIDTH);
  const editorOnScreenAtDragStart = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarResizerRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback(
    (target: LayoutDragTarget) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // Start from what is rendered, not from the stored state: a stored
      // 720px editor can be squeezed by the chat minimum (so it renders at
      // 648), and splitting from the stale state would freeze the
      // editor|panel border entirely.
      const renderedPanel = parseFloat(panelRef.current?.style.width ?? "");
      const renderedEditor = parseFloat(editorRef.current?.style.width ?? "");
      const panelOnScreen = Number.isFinite(renderedPanel) && renderedPanel > 0;
      widthAtDragStart.current =
        target === "panel"
          ? panelWidth
          : target === "editor"
            ? Number.isFinite(renderedEditor) && renderedEditor > 0
              ? renderedEditor
              : editorWidth
            : sidebarWidth;
      dragWidth.current = widthAtDragStart.current;
      const editorOnScreen = Number.isFinite(renderedEditor) && renderedEditor > 0;
      panelWidthAtDragStart.current = panelOnScreen ? renderedPanel : panelWidth;
      dragPanelWidth.current = panelWidthAtDragStart.current;
      panelOnScreenAtDragStart.current = panelOnScreen;
      editorWidthAtDragStart.current = editorOnScreen ? renderedEditor : editorWidth;
      dragEditorWidth.current = editorWidthAtDragStart.current;
      editorOnScreenAtDragStart.current = editorOnScreen;
      dragStartX.current = e.clientX;
      setDragging(target);
    },
    [panelWidth, editorWidth, sidebarWidth],
  );

  useEffect(() => {
    if (!dragging) return;
    const isPanel = dragging === "panel";
    const isEditor = dragging === "editor";
    const sized = isPanel
      ? panelRef.current
      : isEditor
        ? editorRef.current
        : sidebarRef.current;
    const resizer = dragging === "sidebar" ? sidebarResizerRef.current : null;
    const min = isPanel
      ? PANEL_MIN_WIDTH
      : isEditor
        ? EDITOR_MIN_WIDTH
        : SIDEBAR_MIN_WIDTH;
    const max = isPanel
      ? PANEL_MAX_WIDTH
      : isEditor
        ? EDITOR_MAX_WIDTH
        : SIDEBAR_MAX_WIDTH;
    const onMove = (e: PointerEvent) => {
      // Panels grow leftward, the sidebar rightward.
      const delta =
        isPanel || isEditor
          ? dragStartX.current - e.clientX
          : e.clientX - dragStartX.current;
      // Dragging the panel's edge with the editor on screen scales the two
      // right-hand columns together, keeping their width ratio: the chat
      // column absorbs the difference. With the editor hidden, only the
      // panel moves (its edge alone).
      if (isPanel && editorOnScreenAtDragStart.current) {
        const basePanel = panelWidthAtDragStart.current;
        const baseEditor = editorWidthAtDragStart.current;
        const total = basePanel + baseEditor + delta;
        const ratio = basePanel / (basePanel + baseEditor);
        let nextPanel = Math.round(total * ratio);
        nextPanel = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, nextPanel));
        let nextEditor = Math.round(total - nextPanel);
        nextEditor = Math.min(EDITOR_MAX_WIDTH, Math.max(EDITOR_MIN_WIDTH, nextEditor));
        nextPanel = Math.min(
          PANEL_MAX_WIDTH,
          Math.max(PANEL_MIN_WIDTH, Math.round(total - nextEditor)),
        );
        dragWidth.current = nextPanel;
        dragPanelWidth.current = nextPanel;
        dragEditorWidth.current = nextEditor;
        if (sized) sized.style.width = `${nextPanel}px`;
        if (editorRef.current) editorRef.current.style.width = `${nextEditor}px`;
        return;
      }
      // Dragging the editor's edge only re-splits the space between the
      // file-list column and the editor: the pair's sum stays constant, so the
      // conversation column never moves and the border tracks the pointer
      // until either column reaches its own limit (then it simply stops).
      if (isEditor && panelOnScreenAtDragStart.current) {
        const total = panelWidthAtDragStart.current + widthAtDragStart.current;
        let nextPanel = Math.min(
          PANEL_MAX_WIDTH,
          Math.max(PANEL_MIN_WIDTH, panelWidthAtDragStart.current - delta),
        );
        const nextEditor = Math.min(
          EDITOR_MAX_WIDTH,
          Math.max(EDITOR_MIN_WIDTH, total - nextPanel),
        );
        nextPanel = Math.min(
          PANEL_MAX_WIDTH,
          Math.max(PANEL_MIN_WIDTH, total - nextEditor),
        );
        dragPanelWidth.current = nextPanel;
        dragWidth.current = nextEditor;
        if (sized) sized.style.width = `${nextEditor}px`;
        if (panelRef.current) panelRef.current.style.width = `${nextPanel}px`;
        return;
      }
      const next = Math.min(max, Math.max(min, widthAtDragStart.current + delta));
      dragWidth.current = next;
      if (sized) sized.style.width = `${next}px`;
      if (resizer) resizer.style.left = `${next}px`;
    };
    const onUp = () => {
      setDragging(null);
      // Persist once on release; mid-drag writes would thrash storage.
      if (isPanel) {
        setPanelWidth(dragWidth.current);
        writeStored(PANEL_WIDTH_KEY, dragWidth.current);
        if (editorOnScreenAtDragStart.current) {
          setEditorWidth(dragEditorWidth.current);
          writeStored(EDITOR_WIDTH_KEY, dragEditorWidth.current);
        }
      } else if (isEditor) {
        setEditorWidth(dragWidth.current);
        writeStored(EDITOR_WIDTH_KEY, dragWidth.current);
        if (panelOnScreenAtDragStart.current) {
          setPanelWidth(dragPanelWidth.current);
          writeStored(PANEL_WIDTH_KEY, dragPanelWidth.current);
        }
      } else {
        setSidebarWidth(dragWidth.current);
        writeStored(SIDEBAR_WIDTH_KEY, dragWidth.current);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  return {
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
  };
}

export {
  PANEL_MIN_WIDTH,
  PANEL_MAX_WIDTH,
  EDITOR_MIN_WIDTH,
  EDITOR_MAX_WIDTH,
};
