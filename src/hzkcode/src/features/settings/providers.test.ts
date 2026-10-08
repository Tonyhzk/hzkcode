import { describe, expect, it } from "vitest";
import {
  mergeCustomModels,
  migrateChannelEnv,
  normalizeTierAlias,
  providerCustomModels,
  providerModel,
  stripContextSuffix,
} from "./providers";

describe("provider custom models", () => {
  it("reads string ids off the channel record, trimming and deduping", () => {
    expect(
      providerCustomModels({ customModels: ["a", " b ", "a", "", 7, null] }),
    ).toEqual(["a", "b"]);
  });

  it("returns an empty list for records without the key", () => {
    expect(providerCustomModels(undefined)).toEqual([]);
    expect(providerCustomModels({ customModels: "a,b" })).toEqual([]);
  });

  it("appends a comma-separated batch in one go", () => {
    expect(mergeCustomModels(["a"], "b, c，d")).toEqual(["a", "b", "c", "d"]);
  });

  it("drops empties and ids already present", () => {
    expect(mergeCustomModels(["a"], " a , , b ")).toEqual(["a", "b"]);
    expect(mergeCustomModels([], ",，  ")).toEqual([]);
  });
});

describe("retired context suffix", () => {
  it("strips [1m] and [2m] suffixes, case-insensitively", () => {
    expect(stripContextSuffix("model-x[1m]")).toBe("model-x");
    expect(stripContextSuffix("model-x[2m]")).toBe("model-x");
    expect(stripContextSuffix("model-x[1M]")).toBe("model-x");
    expect(stripContextSuffix(" model-x[1m] ")).toBe("model-x");
    expect(stripContextSuffix("model-x")).toBe("model-x");
    expect(stripContextSuffix("model[1m][2m]")).toBe("model");
  });
});

describe("tier alias normalization", () => {
  it("maps the pre-3.1.1 family aliases to their tier spell", () => {
    expect(normalizeTierAlias("opus")).toBe("high");
    expect(normalizeTierAlias("sonnet")).toBe("mid");
    expect(normalizeTierAlias("haiku")).toBe("low");
    expect(normalizeTierAlias(" Sonnet ")).toBe("mid");
  });

  it("lowercases tier spells and passes other ids through", () => {
    expect(normalizeTierAlias("HIGH")).toBe("high");
    expect(normalizeTierAlias("Mid")).toBe("mid");
    // Real ids that merely contain a family word stay untouched.
    expect(normalizeTierAlias("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeTierAlias("deepseek-v4-pro")).toBe("deepseek-v4-pro");
  });
});

describe("providerModel fallbacks", () => {
  it("falls back to the legacy top-level settingsConfig.model", () => {
    expect(
      providerModel("claude", { settingsConfig: { model: "legacy-model[1m]" } }),
    ).toBe("legacy-model");
    // Env models outrank the legacy field (the backend reads the same order).
    expect(
      providerModel("claude", {
        settingsConfig: {
          model: "legacy-model",
          env: { HZKCODE_MODEL: "env-model" },
        },
      }),
    ).toBe("env-model");
  });

  it("reads conflicting spellings in the backend's injection order", () => {
    // settingsConfig.env > env > flat model, matching channel_env.
    expect(
      providerModel("claude", {
        model: "flat-model",
        env: { HZKCODE_MODEL: "env-model" },
        settingsConfig: { env: { HZKCODE_MODEL: "sc-env-model" } },
      }),
    ).toBe("sc-env-model");
    expect(
      providerModel("claude", {
        model: "flat-model",
        env: { HZKCODE_MODEL: "env-model" },
      }),
    ).toBe("env-model");
    // The flat field only stands when both env maps are silent.
    expect(providerModel("claude", { model: "flat-model", env: {} })).toBe(
      "flat-model",
    );
  });
});

describe("migrateChannelEnv", () => {
  it("strips suffixes, lands the implied 1M window, and normalizes the default model", () => {
    const env: Record<string, unknown> = {
      HZKCODE_MODEL: "sonnet",
      HZKCODE_DEFAULT_HIGH_MODEL: "deepseek-v4-pro[1m]",
      HZKCODE_DEFAULT_MID_MODEL: "deepseek-v4.1-flash[1m]",
      HZKCODE_READ_MODEL: "reader[1m]",
    };
    const out = migrateChannelEnv(env);
    expect(out.HZKCODE_MODEL).toBe("mid");
    expect(out.HZKCODE_DEFAULT_HIGH_MODEL).toBe("deepseek-v4-pro");
    expect(out.HZKCODE_DEFAULT_MID_MODEL).toBe("deepseek-v4.1-flash");
    expect(out.HZKCODE_READ_MODEL).toBe("reader");
    // A main-loop suffix lands the 1M window in the config, so editing the
    // model later cannot drop it back to the default.
    expect(out.HZKCODE_MAX_CONTEXT_TOKENS).toBe("1000000");
    // The input object is not mutated.
    expect(env.HZKCODE_MODEL).toBe("sonnet");
  });

  it("keeps an explicitly configured window (string or number)", () => {
    const explicit = migrateChannelEnv({
      HZKCODE_DEFAULT_LOW_MODEL: "low-x[1m]",
      HZKCODE_MAX_CONTEXT_TOKENS: "500000",
    });
    expect(explicit.HZKCODE_MAX_CONTEXT_TOKENS).toBe("500000");
    const numeric = migrateChannelEnv({
      HZKCODE_DEFAULT_LOW_MODEL: "low-x[1m]",
      HZKCODE_MAX_CONTEXT_TOKENS: 500000,
    });
    expect(numeric.HZKCODE_MAX_CONTEXT_TOKENS).toBe(500000);
  });

  it("an auxiliary-only suffix strips without adding a window", () => {
    const out = migrateChannelEnv({ HZKCODE_READ_MODEL: "reader[1m]" });
    expect(out.HZKCODE_READ_MODEL).toBe("reader");
    expect("HZKCODE_MAX_CONTEXT_TOKENS" in out).toBe(false);
  });

  it("returns the same object when nothing changes", () => {
    const env: Record<string, unknown> = { HZKCODE_MODEL: "glm-5.2" };
    expect(migrateChannelEnv(env)).toBe(env);
  });
});
