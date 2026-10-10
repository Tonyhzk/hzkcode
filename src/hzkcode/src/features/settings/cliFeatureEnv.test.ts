import { describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import {
  CLI_FEATURE_GROUPS,
  CLI_FEATURE_KEYS,
  cliFeatureGroup,
} from "./cliFeatureEnv";

// The cards render group titles, descriptions, labels, option labels and hints
// by key, so a missing translation shows the raw key in the settings UI — the
// data table has no type-level way to catch that.
describe("CLI feature switches", () => {
  it("resolves every group title, description, label and hint in both languages", () => {
    const keys = CLI_FEATURE_GROUPS.flatMap((group) => [
      group.titleKey,
      group.descKey,
      ...(group.tabs ?? []).map((tab) => tab.labelKey),
      ...group.fields.flatMap((field) => [
        field.labelKey,
        field.hintKey,
        field.placeholderKey,
        ...Object.values(field.optionLabelKeys ?? {}),
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

  it("addresses every group by a unique id with at most one master switch", () => {
    const ids = CLI_FEATURE_GROUPS.map((group) => group.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of CLI_FEATURE_GROUPS) {
      expect(cliFeatureGroup(group.id)).toBe(group);
      const masters = group.fields.filter((field) => field.master);
      expect(masters.length).toBeLessThanOrEqual(1);
      for (const master of masters) expect(master.kind).toBe("toggle");
    }
  });

  it("labels every select option and points showWhen/tabKey at real siblings", () => {
    for (const group of CLI_FEATURE_GROUPS) {
      const keys = new Set(group.fields.map((field) => field.envKey));
      const tabIds = new Set((group.tabs ?? []).map((tab) => tab.id));
      for (const field of group.fields) {
        if (field.optionLabelKeys) {
          for (const option of field.options ?? []) {
            expect(
              field.optionLabelKeys[option],
              `${field.envKey} has no label for "${option}"`,
            ).toBeTruthy();
          }
        }
        if (field.showWhen) {
          expect(keys.has(field.showWhen.envKey), `${field.envKey} showWhen`).toBe(true);
        }
        if (field.tabKey) {
          expect(tabIds.has(field.tabKey), `${field.envKey} tabKey`).toBe(true);
        }
      }
    }
  });
});
