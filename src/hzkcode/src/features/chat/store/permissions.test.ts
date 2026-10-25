import { beforeEach, describe, expect, it } from "vitest";
import { PERMISSION_MODES } from "@/components/application/ai-chat/permission-modes";
import { readPermissionPref } from "./permissions";
import {
  LEGACY_PERMISSION_PREF_KEY,
  PERMISSION_PREF_KEY,
} from "./persistence";

describe("permission preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to Auto Continue", () => {
    expect(readPermissionPref()).toBe("autoContinue");
    expect(localStorage.getItem(PERMISSION_PREF_KEY)).toBe("autoContinue");
  });

  it("keeps every legal stored mode instead of resetting it", () => {
    for (const mode of PERMISSION_MODES) {
      localStorage.setItem(PERMISSION_PREF_KEY, mode);
      expect(readPermissionPref()).toBe(mode);
      expect(localStorage.getItem(PERMISSION_PREF_KEY)).toBe(mode);
    }
  });

  it("migrates the legacy four-mode manual id", () => {
    localStorage.setItem(LEGACY_PERMISSION_PREF_KEY, "manual");
    expect(readPermissionPref()).toBe("default");
    expect(localStorage.getItem(PERMISSION_PREF_KEY)).toBe("default");
    expect(localStorage.getItem(LEGACY_PERMISSION_PREF_KEY)).toBeNull();
  });

  it("keeps a legal legacy value and removes the old key", () => {
    localStorage.setItem(LEGACY_PERMISSION_PREF_KEY, "readonly");
    expect(readPermissionPref()).toBe("readonly");
    expect(localStorage.getItem(PERMISSION_PREF_KEY)).toBe("readonly");
    expect(localStorage.getItem(LEGACY_PERMISSION_PREF_KEY)).toBeNull();
  });

  it("falls back to Auto Continue for an unknown value", () => {
    localStorage.setItem(PERMISSION_PREF_KEY, "manual");
    expect(readPermissionPref()).toBe("autoContinue");
    expect(localStorage.getItem(PERMISSION_PREF_KEY)).toBe("autoContinue");
  });
});
