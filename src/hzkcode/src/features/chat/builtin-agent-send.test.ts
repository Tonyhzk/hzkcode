import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type AgentConfig } from "@/lib/ipc";

/**
 * Built-in identities are the engine catalog's business. The send path must
 * not resolve them, fake them as custom `--agents` definitions, or select one
 * with `--agent`.
 */

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async () => ({ runId: "run-1", sessionId: null })),
    sessionControl: vi.fn(async () => ({
      type: "result",
      operation: "status",
      schemaVersion: 1,
      sourceSessionId: null,
      targetSessionId: null,
      session_id: null,
      cloned: false,
      is_error: false,
      subtype: "success",
      error_code: null,
      revision: null,
      state: null,
    })),
    resolveEnabledBuiltInAgent: vi.fn(async () => ({
      id: "agency-agents:design/design-ui-designer",
      name: "UI 设计师",
      icon: "🎨",
      prompt: "你是 UI 设计师。",
      promptHash: "hash",
    })),
    interruptSession: vi.fn(async () => true),
    rememberSessionModel: vi.fn(async () => {}),
    rememberSessionEffort: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    loadRemoteSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));

const WS = "/tmp/ws";
const BUILT_IN_PICK: AgentConfig = {
  id: "agency-agents:design/design-ui-designer",
  name: "UI 设计师",
  icon: "🎨",
  source: "builtIn",
};

const { useChatStore } = await import("./store");
const { selectSelectedAgent } = await import("@/features/agents/selected-agent");
const { useAgentStore } = await import("@/features/agents/agent-store");
const { EMPTY_SESSION } = await import("./store/stream");
const { sessionKey } = await import("./store/persistence");

interface SentArgs {
  prompt: string;
  agentName: string | null;
  agentsJson: string | null;
}

const sentArgs = (): SentArgs =>
  vi.mocked(ipc.sendMessage).mock.calls[0]?.[0] as unknown as SentArgs;

describe("sendPrompt ignores the legacy built-in pin", () => {
  beforeEach(() => {
    vi.mocked(ipc.sendMessage).mockClear();
    vi.mocked(ipc.resolveEnabledBuiltInAgent).mockClear();
    useAgentStore.setState({ agents: [], builtInAgents: [], loaded: true });
    const tab = { engine: "claude", sessionId: "s-1", workspacePath: WS };
    useChatStore.setState({
      openTabs: [tab],
      active: tab,
      activeEngine: "claude",
      models: {},
      efforts: {},
      bySession: {
        [sessionKey("claude", "s-1", WS)]: { ...EMPTY_SESSION, messages: [] },
      },
      streamingByKey: {},
      controlBusyByKey: {},
      controlBusy: false,
      unseen: {},
      drafts: {},
      sessions: [],
    });
    selectSelectedAgent(WS, "s-1", BUILT_IN_PICK);
  });

  it("does not resolve or send a built-in selection", async () => {
    await useChatStore.getState().send("hi", []);

    expect(vi.mocked(ipc.resolveEnabledBuiltInAgent)).not.toHaveBeenCalled();
    const sent = sentArgs();
    expect(sent.prompt).toBe("hi");
    expect(sent.agentName).toBeNull();
    expect(sent.agentsJson).toBeNull();
  });
});
