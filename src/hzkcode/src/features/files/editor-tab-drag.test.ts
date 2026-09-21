import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The native ghost window commands go through Tauri's invoke, which does not
// exist in jsdom; the hand-off logic is what these tests assert.
vi.mock("@/lib/ipc", () => ({
  ipc: {
    showDragGhost: vi.fn(async () => {}),
    hideDragGhost: vi.fn(async () => {}),
  },
}));

import { ipc } from "@/lib/ipc";
import { EMPTY_DRAG_IMAGE, isDragOutPosition, useEditorTabDrag } from "./editor-tab-drag";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("isDragOutPosition", () => {
  it("flags pointer positions against the left, right and top window edges", () => {
    expect(isDragOutPosition(window.innerWidth - 2, 300)).toBe(true);
    expect(isDragOutPosition(2, 300)).toBe(true);
    expect(isDragOutPosition(400, 2)).toBe(true);
  });

  it("leaves the strip's interior and the bottom edge alone", () => {
    expect(isDragOutPosition(400, 300)).toBe(false);
    expect(isDragOutPosition(400, window.innerHeight - 2)).toBe(false);
    // Just inside the right edge but past the threshold band.
    expect(isDragOutPosition(window.innerWidth - 40, 300)).toBe(false);
  });
});

/** jsdom lacks DataTransfer; the hook only reads effectAllowed / dropEffect
 *  and writes one data item plus the drag image. */
function dataTransferStub() {
  return {
    effectAllowed: "none",
    dropEffect: "none",
    setData: vi.fn(),
    getData: vi.fn(() => ""),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

/** Dispatch a drag event with a dataTransfer attached — jsdom's DragEvent
 *  cannot carry one through its constructor. */
function fireDrag(
  target: EventTarget,
  type: string,
  init: MouseEventInit & { dataTransfer?: DataTransfer } = {},
) {
  const e = new MouseEvent(type, { bubbles: true, ...init });
  Object.defineProperty(e, "dataTransfer", {
    value: init.dataTransfer ?? dataTransferStub(),
  });
  target.dispatchEvent(e);
}

describe("useEditorTabDrag (HTML5 drag and drop)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: {
    draggedKey: string | null;
    dragGhost: { key: string; x: number; y: number; width: number } | null;
    dropTarget: { draggedKey: string; key: string; before: boolean } | null;
    dragOutActive: boolean;
  };
  let onReorder: ReturnType<typeof vi.fn>;
  let onDragOut: ReturnType<typeof vi.fn>;

  /** Two tabs wired to the hook, mirroring EditorTab's drag wiring. */
  function Harness() {
    const drag = useEditorTabDrag({ onReorder, onDragOut });
    state = {
      draggedKey: drag.draggedKey,
      dragGhost: drag.dragGhost,
      dropTarget: drag.dropTarget,
      dragOutActive: drag.dragOutActive,
    };
    return createElement(
      "div",
      null,
      createElement(
        "div",
        {
          "data-tab-key": "t1",
          draggable: true,
          onDragStart: drag.handleTabDragStart("t1"),
          onDragEnd: drag.handleTabDragEnd("t1"),
        },
        "one",
      ),
      createElement(
        "div",
        {
          "data-tab-key": "t2",
          draggable: true,
          onDragStart: drag.handleTabDragStart("t2"),
          onDragEnd: drag.handleTabDragEnd("t2"),
        },
        "two",
      ),
    );
  }

  function tab(key: string) {
    return container.querySelector(`[data-tab-key="${key}"]`) as HTMLElement;
  }

  beforeEach(async () => {
    // jsdom never rasterizes images; make the preloaded drag image count as
    // ready so the dragstart path under test actually sets it.
    Object.defineProperty(EMPTY_DRAG_IMAGE, "complete", {
      value: true,
      configurable: true,
    });
    state = { draggedKey: null, dragGhost: null, dropTarget: null, dragOutActive: false };
    onReorder = vi.fn();
    onDragOut = vi.fn();
    // jsdom has no layout: give each tab a distinct rect for the drop-side
    // math and the ghost grip (t1: 80..200, t2: 200..320).
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const key = (this as HTMLElement).dataset?.tabKey;
      const left = key === "t2" ? 200 : 80;
      return {
        left,
        top: 30,
        width: 120,
        height: 28,
        right: left + 120,
        bottom: 58,
        x: left,
        y: 30,
        toJSON: () => ({}),
      } as DOMRect;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("starts a drag with the key, a data item and a transparent drag image", () => {
    const dt = dataTransferStub();
    act(() => {
      fireDrag(tab("t1"), "dragstart", {
        dataTransfer: dt,
        clientX: 100,
        clientY: 40,
      });
    });
    expect(state.draggedKey).toBe("t1");
    expect(dt.setData).toHaveBeenCalled();
    // Transparent system image: hides the platform's cancel animation.
    expect(dt.setDragImage).toHaveBeenCalled();
    // The ghost starts on the tab itself (press grip preserved).
    expect(state.dragGhost).toEqual({ key: "t1", x: 80, y: 30, width: 120 });
  });

  it("falls back to the default drag image while the preloaded one is not ready", () => {
    Object.defineProperty(EMPTY_DRAG_IMAGE, "complete", {
      value: false,
      configurable: true,
    });
    const dt = dataTransferStub();
    act(() => {
      fireDrag(tab("t1"), "dragstart", {
        dataTransfer: dt,
        clientX: 100,
        clientY: 40,
      });
    });
    // Safari aborts a drag whose image is not loaded; skipping the call keeps
    // the drag alive with the default image.
    expect(dt.setDragImage).not.toHaveBeenCalled();
    expect(state.draggedKey).toBe("t1");
  });

  it("floats a ghost that tracks the pointer and parks inside the window", () => {
    act(() => {
      fireDrag(tab("t1"), "dragstart", { clientX: 100, clientY: 40 });
    });
    act(() => {
      fireDrag(tab("t2"), "dragover", { clientX: 140, clientY: 60 });
    });
    expect(state.dragGhost).toEqual({ key: "t1", x: 120, y: 50, width: 120 });

    // Far outside the right edge: the ghost parks against the rim instead of
    // rendering (blank) past it.
    act(() => {
      fireDrag(tab("t2"), "dragover", { clientX: 3000, clientY: 40 });
    });
    expect(state.dragGhost).toEqual({
      key: "t1",
      x: window.innerWidth - 120,
      y: 30,
      width: 120,
    });

    act(() => {
      fireDrag(tab("t1"), "dragend", { clientX: 3000, clientY: 40 });
    });
    expect(state.dragGhost).toBeNull();
  });

  it("tracks the drop target under the pointer while dragging", () => {
    act(() => {
      fireDrag(tab("t1"), "dragstart");
    });
    // Over the left half of t2: the indicator goes before it.
    act(() => {
      fireDrag(tab("t2"), "dragover", { clientX: 210, clientY: 40 });
    });
    expect(state.dropTarget).toEqual({ draggedKey: "t1", key: "t2", before: true });
    // Over t2's right half: after it.
    act(() => {
      fireDrag(tab("t2"), "dragover", { clientX: 300, clientY: 40 });
    });
    expect(state.dropTarget).toEqual({ draggedKey: "t1", key: "t2", before: false });
  });

  it("reorders on drop over another tab", () => {
    act(() => {
      fireDrag(tab("t1"), "dragstart");
      fireDrag(tab("t2"), "dragover", { clientX: 210, clientY: 40 });
      fireDrag(tab("t1"), "dragend", { clientX: 210, clientY: 40 });
    });
    expect(onReorder).toHaveBeenCalledWith("t1", "t2", true);
    expect(onDragOut).not.toHaveBeenCalled();
    expect(state.draggedKey).toBeNull();
  });

  it("hands the tab out when released against a window edge", () => {
    act(() => {
      fireDrag(tab("t1"), "dragstart");
      fireDrag(tab("t1"), "dragend", {
        clientX: window.innerWidth - 2,
        clientY: 40,
        screenX: 1800,
        screenY: 500,
      });
    });
    expect(onDragOut).toHaveBeenCalledWith("t1", { x: 1800, y: 500 });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("hands the tab out when the pointer left the window mid-drag", () => {
    act(() => {
      fireDrag(tab("t1"), "dragstart");
      // A document-level dragleave without a relatedTarget means the pointer
      // exited the window; dragend's coordinates are not trusted after that.
      fireDrag(document, "dragleave", { relatedTarget: null });
      fireDrag(tab("t1"), "dragend", {
        clientX: 400,
        clientY: 300,
        screenX: 900,
        screenY: 300,
      });
    });
    expect(onDragOut).toHaveBeenCalledWith("t1", { x: 900, y: 300 });
    // The native ghost window is torn down with the drag.
    expect(vi.mocked(ipc.hideDragGhost)).toHaveBeenCalled();
  });

  it("hands the feedback to the native ghost when the pointer leaves the window", () => {
    act(() => {
      fireDrag(tab("t1"), "dragstart", { clientX: 100, clientY: 40 });
    });
    act(() => {
      fireDrag(document, "dragleave", { relatedTarget: null });
    });
    expect(vi.mocked(ipc.showDragGhost)).toHaveBeenCalledWith({
      label: "t1",
      width: 120,
      height: 28,
      offsetX: 20,
      offsetY: 10,
    });
    // The DOM card is parked while the native window owns the feedback.
    expect(state.dragGhost).toBeNull();
  });

  it("tears the native ghost down when the window unmounts mid-drag", () => {
    act(() => {
      fireDrag(tab("t1"), "dragstart", { clientX: 100, clientY: 40 });
      fireDrag(document, "dragleave", { relatedTarget: null });
    });
    vi.mocked(ipc.hideDragGhost).mockClear();
    act(() => root.unmount());
    // The window may be torn down mid-drag (close, reload): never leave the
    // native ghost window behind.
    expect(vi.mocked(ipc.hideDragGhost)).toHaveBeenCalledTimes(1);
  });

  it("returns the feedback to the DOM card when the pointer comes back", () => {
    act(() => {
      fireDrag(tab("t1"), "dragstart", { clientX: 100, clientY: 40 });
      fireDrag(document, "dragleave", { relatedTarget: null });
    });
    act(() => {
      fireDrag(document, "dragenter", { relatedTarget: null });
    });
    expect(vi.mocked(ipc.hideDragGhost)).toHaveBeenCalled();
  });

  it("cancels without action when released over empty space", () => {
    act(() => {
      fireDrag(tab("t1"), "dragstart");
      fireDrag(tab("t1"), "dragend", { clientX: 400, clientY: 300 });
    });
    expect(onReorder).not.toHaveBeenCalled();
    expect(onDragOut).not.toHaveBeenCalled();
    expect(state.draggedKey).toBeNull();
    expect(state.dragGhost).toBeNull();
    expect(state.dropTarget).toBeNull();
  });

  it("ignores a stray dragend with no drag in flight", () => {
    // Against the edge band: without the early bail this would hand the tab
    // out even though nothing was dragged.
    act(() => {
      fireDrag(tab("t1"), "dragend", { clientX: 2, clientY: 2 });
    });
    expect(onDragOut).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();

    act(() => {
      fireDrag(tab("t1"), "dragstart");
      fireDrag(tab("t1"), "dragend", { clientX: 400, clientY: 300 });
      // A second dragend trailing the finished drag must not fire either.
      fireDrag(tab("t1"), "dragend", {
        clientX: window.innerWidth - 2,
        clientY: 40,
      });
    });
    expect(onDragOut).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
  });
});
