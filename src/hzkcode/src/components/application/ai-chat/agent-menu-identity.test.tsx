import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMenu, type AgentMenuSelection } from "./agent-menu";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { useChatStore } from "@/features/chat/store";
import { useAgentStore } from "@/features/agents/agent-store";
import { ipc, type SessionControlResult } from "@/lib/ipc";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "zh" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    listAgents: vi.fn(async () => []),
    listBuiltInAgents: vi.fn(async () => ({
      provider: {
        id: "p",
        displayName: "p",
        sourceUrl: "",
        sourceRevision: "",
        license: "",
      },
      divisions: [],
      agents: [],
    })),
  },
}));
Element.prototype.scrollIntoView ??= () => {};

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/ws";
const SID = "s-1";
const KEY = `claude/${SID}`;

function control(): SessionControlResult {
  return {
    type: "result",
    operation: "catalog",
    schemaVersion: 1,
    sourceSessionId: SID,
    targetSessionId: SID,
    session_id: SID,
    cloned: false,
    is_error: false,
    subtype: "success",
    error_code: null,
    revision: "r1",
    state: {
      hasConversation: true,
      availableApplyMethods: {
        identity: ["current", "clone", "append"],
        promptMode: ["current", "clone"],
      },
      identity: { base: null, extensions: [] },
      promptMode: { effective: "full", override: null, source: "startup" },
      interactionMode: { effective: "default", override: null, source: "startup" },
      apiMode: { effective: "anthropic", override: null, source: "startup" },
      model: { effective: "high", override: null, source: "startup" },
      effort: { effective: null, override: null, source: "startup" },
      permission: { effective: "default", override: null, source: "startup" },
    },
    catalog: {
      identities: [
        {
          id: "simple-internal",
          name: "精简",
          description: "轻量任务",
          source: "built-in",
          tools: null,
          disallowedTools: [],
          model: null,
          effort: null,
          permissionMode: null,
        },
      ],
      interactionModes: [],
    },
  };
}

const CUSTOM_AGENT = {
  id: "custom-1",
  name: "我的审查",
  prompt: "审查代码",
};

const AGENCY_ROLE = {
  id: "agency-agents:design/design-ui-designer",
  divisionId: "design",
  name: "UI 设计师",
  description: "设计界面",
  icon: "🎨",
  enabled: true,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(ipc.listAgents).mockResolvedValue([CUSTOM_AGENT]);
  vi.mocked(ipc.listBuiltInAgents).mockResolvedValue({
    provider: {
      id: "p",
      displayName: "p",
      sourceUrl: "",
      sourceRevision: "",
      license: "",
    },
    divisions: [],
    agents: [AGENCY_ROLE],
  });
  const active = { engine: "claude", sessionId: SID, workspacePath: WS };
  useChatStore.setState({
    active,
    openTabs: [active],
    bySession: {
      [KEY]: { ...EMPTY_SESSION, sessionControl: control() },
    },
    refreshSessionControl: vi.fn(async () => control()),
  });
  useAgentStore.setState({
    agents: [CUSTOM_AGENT],
    // app 自带角色用稳定目录 id 应用，与引擎身份分组区分。
    builtInAgents: [AGENCY_ROLE],
    builtInDivisions: [],
    loaded: true,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderMenu(query = ""): Promise<AgentMenuSelection[]> {
  const picked: AgentMenuSelection[] = [];
  await act(async () => {
    root.render(
      <AgentMenu
        query={query}
        left={0}
        onSelect={(selection) => picked.push(selection)}
        onClose={() => {}}
      />,
    );
  });
  return picked;
}

function options(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="option"]')];
}

describe("AgentMenu identity picker", () => {
  it("lists default, engine catalog, app roles and GUI custom identities", async () => {
    await renderMenu();
    const text = options().map((option) => option.textContent);
    expect(text[0]).toContain("chat.sessionIdentityDefault");
    expect(text.some((line) => line?.includes("精简"))).toBe(true);
    expect(text.some((line) => line?.includes("我的审查"))).toBe(true);
    expect(text.some((line) => line?.includes("UI 设计师"))).toBe(true);
  });

  it("selects an engine identity for the shared apply dialog", async () => {
    const picked = await renderMenu();
    const engine = options().find((option) =>
      option.textContent?.includes("精简"),
    )!;
    await act(async () => {
      engine.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({
      kind: "identity",
      identity: { value: "simple-internal", group: "builtin" },
    });
  });

  it("selects an app role by its stable catalog id", async () => {
    const picked = await renderMenu();
    const role = options().find((option) =>
      option.textContent?.includes("UI 设计师"),
    )!;
    await act(async () => {
      role.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({
      kind: "identity",
      identity: {
        value: "agency-agents:design/design-ui-designer",
        name: "UI 设计师",
        group: "agency",
      },
    });
  });

  it("filters by query and keeps the create row", async () => {
    await renderMenu("审查");
    const text = options().map((option) => option.textContent);
    expect(text.some((line) => line?.includes("我的审查"))).toBe(true);
    expect(text.some((line) => line?.includes("chat.agentCreate"))).toBe(true);
  });
});
