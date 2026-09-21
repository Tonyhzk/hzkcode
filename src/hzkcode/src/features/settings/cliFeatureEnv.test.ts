import { describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { CLI_FEATURE_GROUPS, CLI_FEATURE_KEYS } from "./cliFeatureEnv";

// The card renders group titles and field labels by key, so a missing
// translation shows the raw key in the settings UI — the data table has no
// type-level way to catch that.
describe("CLI feature switches", () => {
  it("resolves every group title, label and hint in both languages", () => {
    const keys = CLI_FEATURE_GROUPS.flatMap((group) => [
      group.titleKey,
      ...group.fields.flatMap((field) => [
        field.labelKey,
        field.hintKey,
        field.placeholderKey,
      ]),
    ]).filter((key): key is string => Boolean(key));

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(i18n.exists(key, { lng: "zh" }), `zh missing ${key}`).toBe(true);
      expect(i18n.exists(key, { lng: "en" }), `en missing ${key}`).toBe(true);
    }
  });

  it("carries provider-safe HZKCODE_* names with no duplicates", () => {
    // The names are injected as process env at spawn and filtered by the
    // backend's env-name check; a stray character would silently drop them.
    expect(CLI_FEATURE_KEYS.every((key) => /^HZKCODE_[A-Z0-9_]+$/.test(key))).toBe(true);
    expect(new Set(CLI_FEATURE_KEYS).size).toBe(CLI_FEATURE_KEYS.length);
  });
});
