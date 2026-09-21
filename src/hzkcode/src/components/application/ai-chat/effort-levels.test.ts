import { describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { EFFORT_LEVELS, EFFORT_LABEL_KEYS } from "./effort-levels";

describe("effort ladder", () => {
  it("offers exactly the five CLI-aligned stops, max last", () => {
    // The last stop drives the slider's max-effort celebration — keeping
    // "max" last is what puts the flame on the highest real level.
    expect([...EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("has a label key per stop, translated in both languages", () => {
    for (const level of EFFORT_LEVELS) {
      const key = EFFORT_LABEL_KEYS[level];
      expect(key).toBeTruthy();
      expect(i18n.exists(key, { lng: "zh" }), `zh missing ${key}`).toBe(true);
      expect(i18n.exists(key, { lng: "en" }), `en missing ${key}`).toBe(true);
    }
  });
});
