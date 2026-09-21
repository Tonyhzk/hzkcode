import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { EffortSlider } from "./effort-slider";
import { EFFORT_LEVELS } from "./effort-levels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("EffortSlider flame", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    // jsdom's canvas has no contexts; make "no WebGL" explicit instead of
    // letting the not-implemented noise hit the console.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders a flame layer at every stop, not just max (regression)", () => {
    for (const level of EFFORT_LEVELS) {
      act(() => {
        root.render(<EffortSlider value={level} onChange={() => {}} />);
      });
      // jsdom has no WebGL, so this exercises the pixel-noise fallback —
      // either way the flame layer must be present at every level, not
      // only at the top stop.
      expect(container.querySelector("canvas")).not.toBeNull();
    }
  });
});
