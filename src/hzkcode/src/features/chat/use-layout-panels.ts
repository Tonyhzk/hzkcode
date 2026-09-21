import { useCallback, useEffect, useRef, useState } from "react";
import { MOBILE_MEDIA } from "@/hooks/use-media-query";
import { readStoredBool, readStoredNumber, writeStored } from "@/lib/storage";

const PANEL_MIN_WIDTH = 300;
const PANEL_MAX_WIDTH = 560;
// Open at the narrowest usable width; users can widen via the resize grip.
const PANEL_DEFAULT_WIDTH = PANEL_MIN_WIDTH;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 260;
const EDITOR_MIN_WIDTH = 320;
const EDITOR_MAX_WIDTH = 720;
const EDITOR_DEFAULT_WIDTH = 420;
const PANEL_COLLAPSED_KEY = "hzkcode.panelCollapsed";
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
  const [panelWidth, setPanelWidth] = useState(() => readStoredWidth(PANEL_WIDTH_KEY, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, PANEL_DEFAULT_WIDTH));
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
  const panelRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarResizerRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback(
    (target: LayoutDragTarget) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      widthAtDragStart.current =
        target === "panel"
          ? panelWidth
          : target === "editor"
            ? editorWidth
            : sidebarWidth;
      dragWidth.current = widthAtDragStart.current;
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
      } else if (isEditor) {
        setEditorWidth(dragWidth.current);
        writeStored(EDITOR_WIDTH_KEY, dragWidth.current);
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
