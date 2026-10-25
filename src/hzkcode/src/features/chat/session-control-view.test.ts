import { describe, expect, it } from "vitest";
import type {
  BuiltInAgentView,
  SessionControlCatalog,
  SessionControlIdentity,
} from "@/lib/ipc";
import {
  LARGE_PROMPT_TOKENS,
  identityDisplayName,
  permissionModeForDisplay,
  promptSizeFromUsage,
  sessionControlErrorKey,
  sessionIdentityOptions,
} from "./session-control-view";

function identity(
  id: string,
  name: string,
  source = "built-in",
): SessionControlIdentity {
  return {
    id,
    name,
    description: "",
    source,
    tools: null,
    disallowedTools: [],
    model: null,
    effort: null,
    permissionMode: null,
  };
}

const CATALOG: SessionControlCatalog = {
  identities: [
    identity("simple-internal", "精简"),
    identity("reviewer", "审查", "userSettings"),
  ],
  interactionModes: [],
};

const AGENCY: BuiltInAgentView = {
  id: "agency-agents:design/design-ui-designer",
  divisionId: "design",
  name: "UI 设计师",
  description: "设计界面",
  icon: "🎨",
  enabled: true,
};

describe("sessionIdentityOptions", () => {
  it("puts the default first and keeps engine, agency and custom groups apart", () => {
    const options = sessionIdentityOptions({
      catalog: CATALOG,
      agents: [
        { id: "custom-1", name: "自定义", prompt: "做这件事" },
        { id: "custom-2", name: "simple-internal", prompt: "重名" },
      ],
      builtInAgents: [AGENCY],
      defaultName: "默认",
    });
    expect(options.map((option) => option.value)).toEqual([
      null,
      "simple-internal",
      "reviewer",
      "agency-agents:design/design-ui-designer",
      "自定义",
    ]);
    expect(options[1]!.group).toBe("builtin");
    expect(options[2]!.group).toBe("external");
    expect(options[3]!.group).toBe("agency");
    expect(options[3]!.name).toBe("UI 设计师");
    expect(options[3]!.builtIn).toBe(AGENCY);
    expect(options[4]!.group).toBe("custom");
    expect(options[4]!.agent?.name).toBe("自定义");
  });

  it("does not duplicate a legacy built-in agent record as a custom identity", () => {
    const options = sessionIdentityOptions({
      catalog: undefined,
      agents: [
        { id: "legacy", name: "UI 设计师", prompt: "旧记录", source: "builtIn" },
      ],
      builtInAgents: [AGENCY],
      defaultName: "默认",
    });
    expect(options).toHaveLength(2);
    expect(options[1]!.value).toBe(AGENCY.id);
    expect(options[1]!.group).toBe("agency");
  });

  it("keeps the agency stable id as the apply value", () => {
    const options = sessionIdentityOptions({
      catalog: undefined,
      agents: [],
      builtInAgents: [AGENCY],
      defaultName: "默认",
    });
    expect(options[1]!.value).toBe(
      "agency-agents:design/design-ui-designer",
    );
  });

  it("resolves display names by value", () => {
    const options = sessionIdentityOptions({
      catalog: CATALOG,
      agents: [],
      defaultName: "默认",
    });
    expect(identityDisplayName("simple-internal", options)).toBe("精简");
    expect(identityDisplayName("gone", options)).toBe("gone");
    expect(identityDisplayName(null, options)).toBeNull();
  });
});

describe("permissionModeForDisplay", () => {
  it("maps the engine's bypassPermissions to the GUI bypass", () => {
    expect(permissionModeForDisplay("bypassPermissions")).toBe("bypass");
    expect(permissionModeForDisplay("acceptEdits")).toBe("acceptEdits");
    expect(permissionModeForDisplay("default")).toBe("default");
  });

  it("returns null for values the GUI does not understand", () => {
    expect(permissionModeForDisplay("some-engine-mode")).toBeNull();
    expect(permissionModeForDisplay(null)).toBeNull();
    expect(permissionModeForDisplay(undefined)).toBeNull();
  });
});

describe("promptSizeFromUsage", () => {
  it("sums the input side across cache buckets", () => {
    const size = promptSizeFromUsage({
      input_tokens: 1200,
      output_tokens: 30,
      cache_read_input_tokens: 99000,
      cache_creation_input_tokens: 500,
    });
    expect(size).toEqual({
      promptTokens: 100700,
      cacheRead: 99000,
      cacheWrite: 500,
    });
    expect(size!.promptTokens).toBeGreaterThan(LARGE_PROMPT_TOKENS);
  });

  it("returns null without a usage report", () => {
    expect(promptSizeFromUsage(null)).toBeNull();
    expect(promptSizeFromUsage({})).toBeNull();
  });
});

describe("sessionControlErrorKey", () => {
  it("maps known engine error codes and falls back", () => {
    expect(sessionControlErrorKey("session_live")).toBe(
      "chat.sessionErrSessionLive",
    );
    expect(sessionControlErrorKey("file_changed")).toBe(
      "chat.sessionErrFileChanged",
    );
    expect(sessionControlErrorKey(null)).toBe("chat.sessionErrUnknown");
  });
});
