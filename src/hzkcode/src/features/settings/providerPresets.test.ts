import { describe, expect, it } from "vitest";
import {
  CLAUDE_ENV_FIELD_KEYS,
  CLAUDE_ENV_GROUPS,
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

  it("channel controls edit the CLI's own variables", () => {
    expect(CLAUDE_ENV_FIELD_KEYS).toEqual([
      "HZKCODE_API_MODE",
      "HZKCODE_MAX_CONTEXT_TOKENS",
      "HZKCODE_AUTO_COMPACT_WINDOW",
      "HZKCODE_MODEL",
      "HZKCODE_DEFAULT_HIGH_MODEL",
      "HZKCODE_DEFAULT_MID_MODEL",
      "HZKCODE_DEFAULT_LOW_MODEL",
      "HZKCODE_READ_MODEL",
    ]);
    const apiMode = CLAUDE_ENV_GROUPS[0].fields[0];
    expect(apiMode.kind).toBe("select");
    expect(apiMode.options).toEqual([
      "",
      "anthropic",
      "responses",
      "chat_completions",
    ]);
  });
});
