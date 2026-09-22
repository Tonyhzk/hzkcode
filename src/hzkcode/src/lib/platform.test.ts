import { describe, expect, it } from "vitest";
import { formatAppVersion } from "./platform";

describe("formatAppVersion", () => {
  it("turns the stored pre-release segment into a fourth segment", () => {
    expect(formatAppVersion("3.0.0-1")).toBe("3.0.0.1");
    expect(formatAppVersion("3.0.1-12")).toBe("3.0.1.12");
  });

  it("leaves plain semver and non-numeric pre-releases alone", () => {
    expect(formatAppVersion("3.0.0")).toBe("3.0.0");
    expect(formatAppVersion("0.1.0")).toBe("0.1.0");
    expect(formatAppVersion("3.0.0-beta.1")).toBe("3.0.0-beta.1");
  });
});
