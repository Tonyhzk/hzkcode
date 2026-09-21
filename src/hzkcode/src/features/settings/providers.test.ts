import { describe, expect, it } from "vitest";
import { has1mSuffix, with1mSuffix, without1mSuffix } from "./providers";

describe("1M context suffix", () => {
  it("appends the suffix when absent", () => {
    expect(with1mSuffix("deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash[1m]");
  });

  it("keeps an existing [1m] suffix", () => {
    expect(with1mSuffix("deepseek-v4-pro[1m]")).toBe("deepseek-v4-pro[1m]");
  });

  it("replaces any other trailing bracket suffix with [1m]", () => {
    expect(with1mSuffix("model-x[2m]")).toBe("model-x[1m]");
  });

  it("leaves empty input empty", () => {
    expect(with1mSuffix("   ")).toBe("");
  });

  it("removes only the [1m] suffix, keeping other suffixes", () => {
    expect(without1mSuffix("model-x[1m]")).toBe("model-x");
    expect(without1mSuffix("model-x[2m]")).toBe("model-x[2m]");
    expect(without1mSuffix("model-x")).toBe("model-x");
  });

  it("detects the suffix on trimmed values only", () => {
    expect(has1mSuffix(" model-x[1m] ")).toBe(true);
    expect(has1mSuffix("model-x")).toBe(false);
    expect(has1mSuffix("")).toBe(false);
    // The CLI reads exactly "[1m]" — other casings are not recognized.
    expect(has1mSuffix("model-x[1M]")).toBe(false);
  });
});
