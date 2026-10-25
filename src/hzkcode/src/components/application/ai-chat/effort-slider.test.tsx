import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { EffortSlider } from "./effort-slider";
import { isFlameLevel } from "./effort-flame";
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

  it("does not report a change on mount", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<EffortSlider value="medium" onChange={onChange} />);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders a flame layer at every burning stop, not just max (regression)", () => {
    for (const level of EFFORT_LEVELS) {
      act(() => {
        root.render(<EffortSlider value={level} onChange={() => {}} />);
      });
      // jsdom 没有 WebGL，因此燃烧档位会走像素噪声回退——无论哪条路径，
      // 火焰层都必须存在，而不是只在最高档出现。off 与 none 没有可燃烧的内容。
      const canvas = container.querySelector("canvas");
      if (isFlameLevel(level)) {
        expect(canvas, level).not.toBeNull();
      } else {
        expect(canvas, level).toBeNull();
      }
    }
  });
});
