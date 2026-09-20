import { describe, expect, it } from "vitest";
import {
  CLAUDE_MODEL_SLOTS,
  buildDefaultClaudeSettings,
  claudeTemplateJson,
} from "./providerPresets";

describe("claude channel template", () => {
  it("uses the env variable names the CLI reads", () => {
    const config = buildDefaultClaudeSettings();
    expect(config.env.HZKCODE_BASE_URL).toBe("");
    expect(config.env.HZKCODE_API_KEY).toBe("");
    // No leftover upstream spellings: the CLI reads none of them.
    for (const key of Object.keys(config.env)) {
      expect(key.startsWith("ANTHROPIC_")).toBe(false);
      expect(key.startsWith("CLAUDE_CODE_")).toBe(false);
    }

    const written = JSON.parse(claudeTemplateJson("https://relay.example", "sk-x")) as {
      env: Record<string, string>;
    };
    expect(written.env.HZKCODE_BASE_URL).toBe("https://relay.example");
    expect(written.env.HZKCODE_API_KEY).toBe("sk-x");
  });

  it("model slots point at the CLI's capability tiers", () => {
    expect(CLAUDE_MODEL_SLOTS).toEqual([
      { slot: "sonnet", envKey: "HZKCODE_DEFAULT_MID_MODEL" },
      { slot: "opus", envKey: "HZKCODE_DEFAULT_HIGH_MODEL" },
      { slot: "haiku", envKey: "HZKCODE_DEFAULT_LOW_MODEL" },
    ]);
  });
});
