import { describe, expect, it } from "vitest";
import { isDragOutPosition } from "./editor-tab-drag";

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
