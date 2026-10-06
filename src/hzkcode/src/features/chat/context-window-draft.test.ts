import { describe, expect, it } from "vitest";
import { parseContextWindowDraft } from "./context-window-draft";

describe("parseContextWindowDraft (the CLI's /maxtokens validation)", () => {
  it("accepts positive integers, trimming surrounding space", () => {
    expect(parseContextWindowDraft("123456")).toBe(123456);
    expect(parseContextWindowDraft("  900000 ")).toBe(900000);
    expect(parseContextWindowDraft("9007199254740991")).toBe(9007199254740991);
  });

  it("rejects zero, negatives, fractions and non-numeric text", () => {
    for (const raw of [
      "0",
      "00",
      "-1",
      "+5",
      "1.5",
      "1e3",
      "007",
      "abc",
      "0x10",
      "１２３",
    ]) {
      expect(parseContextWindowDraft(raw)).toBeNull();
    }
  });

  it("rejects an empty draft", () => {
    expect(parseContextWindowDraft("")).toBeNull();
    expect(parseContextWindowDraft("   ")).toBeNull();
  });

  it("rejects integers beyond Number.MAX_SAFE_INTEGER", () => {
    expect(parseContextWindowDraft("9007199254740993")).toBeNull();
  });
});
