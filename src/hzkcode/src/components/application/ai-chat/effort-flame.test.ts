import { describe, expect, it } from "vitest";
import { FLAME_SPECS, nozzleForFraction } from "./effort-flame";
import { EFFORT_LEVELS } from "./effort-levels";

describe("FLAME_SPECS", () => {
  it("covers every effort stop", () => {
    expect(Object.keys(FLAME_SPECS).sort()).toEqual([...EFFORT_LEVELS].sort());
  });

  it("throttles up monotonically with the level, full burn at max", () => {
    const powers = EFFORT_LEVELS.map((level) => FLAME_SPECS[level].power);
    for (let i = 1; i < powers.length; i++) {
      expect(powers[i]).toBeGreaterThan(powers[i - 1]);
    }
    expect(powers[powers.length - 1]).toBe(1);
  });

  it("runs from a yellow campfire to blue exhaust", () => {
    // Yellow flame: the red channel dominates at the gentlest level.
    const low = FLAME_SPECS.low.mid;
    expect(low[0]).toBeGreaterThan(low[2]);
    // Blue exhaust: the blue channel dominates at max.
    const max = FLAME_SPECS.max.mid;
    expect(max[2]).toBeGreaterThan(max[0]);
  });

  it("keeps each palette ordered toward the hot core", () => {
    for (const level of EFFORT_LEVELS) {
      const { deep, mid, bright } = FLAME_SPECS[level];
      const sum = (c: readonly [number, number, number]) => c[0] + c[1] + c[2];
      // The hot-core tone is the brightest of the three.
      expect(sum(bright)).toBeGreaterThan(sum(mid));
      expect(sum(mid)).toBeGreaterThan(sum(deep));
    }
  });

  it("keeps a per-level vertical footprint that grows with the level", () => {
    const scales = EFFORT_LEVELS.map((level) => FLAME_SPECS[level].vscale);
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]).toBeGreaterThan(scales[i - 1]);
    }
    expect(scales[scales.length - 1]).toBe(1);
  });

  it("keeps a per-level starfield rush that grows with the level", () => {
    const rushes = EFFORT_LEVELS.map((level) => FLAME_SPECS[level].rush);
    for (let i = 1; i < rushes.length; i++) {
      expect(rushes[i]).toBeGreaterThan(rushes[i - 1]);
    }
    expect(rushes[rushes.length - 1]).toBe(3);
  });

  it("keeps a per-level flame span that grows with the level", () => {
    // The flame's own length: a stubby lick at the gentlest stop, the whole
    // burnt stretch at max.
    const spans = EFFORT_LEVELS.map((level) => FLAME_SPECS[level].span);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]).toBeGreaterThan(spans[i - 1]);
    }
    expect(spans[spans.length - 1]).toBe(1);
  });
});

describe("nozzleForFraction", () => {
  it("puts the plume under the thumb, travelling edge to edge", () => {
    // 400px track: the thumb centre travels 10.5px → 389.5px.
    expect(nozzleForFraction(0.25, 400)).toBeCloseTo((10.5 + 0.25 * 379) / 400, 3);
    expect(nozzleForFraction(0.5, 400)).toBeCloseTo(0.5, 3);
    expect(nozzleForFraction(1, 400)).toBeCloseTo(389.5 / 400, 3);
  });

  it("keeps a sliver of space at the gentlest level and survives a 0 width", () => {
    // Clamped below so the shader never divides by (almost) zero.
    expect(nozzleForFraction(0, 400)).toBe(0.03);
    expect(nozzleForFraction(-1, 400)).toBe(0.03);
    expect(nozzleForFraction(0, 0)).toBe(1);
  });
});
