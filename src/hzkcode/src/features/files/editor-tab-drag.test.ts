import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDragOutPosition, useEditorTabDrag } from "./editor-tab-drag";

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

describe("useEditorTabDrag ghost", () => {
  let container: HTMLDivElement;
  let root: Root;
  let ghost: { key: string; x: number; y: number; width: number } | null;

  /** One tab wired to the hook, mirroring EditorTab's pointerdown wiring. */
  function Harness() {
    const { dragGhost, handleTabPointerDown } = useEditorTabDrag({});
    ghost = dragGhost;
    return createElement(
      "div",
      { "data-tab-key": "t1", onPointerDown: handleTabPointerDown("t1") },
      "label",
    );
  }

  beforeEach(async () => {
    ghost = null;
    // jsdom has no layout: elementFromPoint is missing and rects are zero.
    document.elementFromPoint = () => null;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 80,
      top: 30,
      width: 120,
      height: 28,
      right: 200,
      bottom: 58,
      x: 80,
      y: 30,
      toJSON: () => ({}),
    } as DOMRect);
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

  it("floats a ghost that tracks the pointer once past the threshold", () => {
    const tab = container.querySelector('[data-tab-key="t1"]') as HTMLElement;
    act(() => {
      tab.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 40 }));
    });
    // No ghost while it is still a plain click.
    expect(ghost).toBeNull();

    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 103, clientY: 40 }));
    });
    expect(ghost).toBeNull();

    // Past 5px: the ghost keeps the press's grip (20, 10) inside the tab.
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 140, clientY: 60 }));
    });
    expect(ghost).toEqual({ key: "t1", x: 120, y: 50, width: 120 });

    // A later move keeps tracking.
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 160, clientY: 70 }));
    });
    expect(ghost).toEqual({ key: "t1", x: 140, y: 60, width: 120 });

    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 160, clientY: 70 }));
    });
    expect(ghost).toBeNull();
  });
});
