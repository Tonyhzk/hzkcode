import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type AgentConfig } from "@/lib/ipc";

/**
 * Send-path identity semantics after session-control: every GUI custom
 * identity is registered with `--agents`, but the send never selects one with
 * `--agent` and never derives `--tools`/model/effort from the old per-thread
 * pick. Identity switching is an explicit session-control action.
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
    cloneSession: vi.fn(async () => ({
      sessionId: "s-2",
      title: null,
      cloned: true,
    })),
    getSessionAgentSetting: vi.fn(async () => null),
    interruptSession: vi.fn(async () => true),
    rememberSessionModel: vi.fn(async () => {}),
    rememberSessionEffort: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    loadSessionPage: vi.fn(async () => ({
      messages: [],
      nextBefore: null,
      subagentHistory: [],
    })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
    listAgents: vi.fn(async () => []),
    listBuiltInAgents: vi.fn(async () => ({ agents: [], divisions: [] })),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));

const { useChatStore } = await import("./store");
const { selectSelectedAgent } = await import("@/features/agents/selected-agent");
const { useAgentStore } = await import("@/features/agents/agent-store");
const { EMPTY_SESSION } = await import("./store/stream");
const { sessionKey } = await import("./store/persistence");

interface SentArgs {
  prompt: string;
  sessionId: string | null;
  model: string | null;
  effort: string | null;
  agentName: string | null;
  agentsJson: string | null;
  agentTools?: string[] | null;
}

const sentArgs = (call = 0): SentArgs =>
  vi.mocked(ipc.sendMessage).mock.calls[call]?.[0] as unknown as SentArgs;

let wsCounter = 0;
function nextWs(): string {
  wsCounter += 1;
  return `/tmp/ws-identity-${wsCounter}`;
}

function customAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "a1",
    name: "审查员",
    prompt: "严格审查。",
    ...overrides,
  };
}

describe("identity registration on send", () => {
  let WS = "";
  beforeEach(() => {
    WS = nextWs();
    vi.mocked(ipc.sendMessage).mockClear();
    vi.mocked(ipc.sendMessage).mockResolvedValue({
      runId: "run-1",
      sessionId: null,
    });
    vi.mocked(ipc.cloneSession).mockClear();
    vi.mocked(ipc.getSessionAgentSetting).mockClear();
    useAgentStore.setState({ agents: [], loaded: true });
    const tab = { engine: "claude", sessionId: "s-1", workspacePath: WS };
    useChatStore.setState({
      openTabs: [tab],
      active: tab,
      activeEngine: "claude",
      models: {},
      efforts: {},
      bySession: {
        [sessionKey("claude", "s-1", WS)]: {
          ...EMPTY_SESSION,
          messages: [],
        },
      },
      streamingByKey: {},
      controlBusyByKey: {},
      controlBusy: false,
      unseen: {},
      drafts: {},
      sessions: [],
    });
  });

  it("registers every custom identity but selects none", async () => {
    useAgentStore.setState({
      agents: [
        customAgent({ id: "a1", name: "审查员", prompt: "严格审查。" }),
        customAgent({ id: "a2", name: "新身份", prompt: "另一种风格。" }),
      ],
      loaded: true,
    });
    await useChatStore.getState().send("hi", []);

    const sent = sentArgs();
    expect(sent.agentName).toBeNull();
    expect(sent.agentTools).toBeNull();
    const defs = JSON.parse(sent.agentsJson ?? "{}") as Record<
      string,
      { prompt: string }
    >;
    expect(Object.keys(defs)).toEqual(["审查员", "新身份"]);
    expect(defs["审查员"]?.prompt).toBe("严格审查。");
  });

  it("does not turn built-in catalog picks into custom definitions", async () => {
    useAgentStore.setState({
      agents: [
        customAgent({
          id: "built-in-pick",
          name: "内置身份",
          prompt: "内置提示词",
          source: "builtIn",
        }),
      ],
      loaded: true,
    });
    await useChatStore.getState().send("hi", []);

    const sent = sentArgs();
    expect(sent.agentsJson).toBeNull();
    expect(sent.agentName).toBeNull();
  });

  it("falls back to a minimal prompt when a custom identity has none", async () => {
    useAgentStore.setState({
      agents: [customAgent({ prompt: undefined })],
      loaded: true,
    });
    await useChatStore.getState().send("hi", []);

    const defs = JSON.parse(sentArgs().agentsJson ?? "{}") as Record<
      string,
      { prompt: string }
    >;
    expect(defs["审查员"]?.prompt.length ?? 0).toBeGreaterThan(0);
  });

  it("keeps identity model/effort inside the definition, not on the send", async () => {
    useAgentStore.setState({
      agents: [
        customAgent({
          tools: ["Bash"],
          model: "haiku",
          effort: "high",
          context: ["claudemd"],
        }),
      ],
      loaded: true,
    });
    await useChatStore.getState().send("hi", []);

    const sent = sentArgs();
    expect(sent.agentTools).toBeNull();
    expect(sent.model).toBeNull();
    expect(sent.effort).toBeNull();
    const defs = JSON.parse(sent.agentsJson ?? "{}") as Record<
      string,
      { tools?: string[]; model?: string; effort?: string; context: string[] }
    >;
    expect(defs["审查员"]?.tools).toEqual(["Bash"]);
    expect(defs["审查员"]?.model).toBe("low");
    expect(defs["审查员"]?.effort).toBe("high");
    expect(defs["审查员"]?.context).toEqual(["claudemd"]);
  });

  it("no longer clones or reads the session file for an old identity pick", async () => {
    selectSelectedAgent(WS, "s-1", customAgent({ id: "a2", name: "新身份" }));
    await useChatStore.getState().send("hi", []);

    expect(vi.mocked(ipc.cloneSession)).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.getSessionAgentSetting)).not.toHaveBeenCalled();
    expect(sentArgs().sessionId).toBe("s-1");
    expect(sentArgs().agentName).toBeNull();
  });
});
