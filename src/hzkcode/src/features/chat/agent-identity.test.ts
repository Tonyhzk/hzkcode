import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type AgentConfig } from "@/lib/ipc";

/**
 * Identity editor behavior on the send path: the definition carries the
 * identity's tools/model/effort/context, the launch flags override the
 * session picks, an empty prompt gets a minimal fallback (the engine rejects
 * empty ones), and switching the identity on a conversation that already has
 * messages clones it (the CLI's /agents semantics) — the original keeps its
 * identity, the clone continues.
 */

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async () => ({ runId: "run-1", sessionId: null })),
    cloneSession: vi.fn(async () => ({
      sessionId: "s-2",
      title: null,
      cloned: true,
    })),
    getSessionAgentSetting: vi.fn(async () => null),
    resolveEnabledBuiltInAgent: vi.fn(async () => ({
      id: "catalog:built-in",
      name: "内置身份",
      icon: "🎨",
      prompt: "内置提示词",
      promptHash: "hash",
    })),
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
const { selectSelectedAgent, getSelectedAgent, getRecordedAgent } = await import(
  "@/features/agents/selected-agent"
);
const { useAgentStore } = await import("@/features/agents/agent-store");
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

/** A fresh workspace per test keeps the module-level selection store clean. */
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

describe("identity send path", () => {
  let WS = "";
  beforeEach(() => {
    WS = nextWs();
    vi.mocked(ipc.sendMessage).mockClear();
    vi.mocked(ipc.sendMessage).mockResolvedValue({ runId: "run-1", sessionId: null });
    vi.mocked(ipc.cloneSession).mockClear();
    vi.mocked(ipc.cloneSession).mockResolvedValue({
      sessionId: "s-2",
      title: null,
      cloned: true,
    });
    vi.mocked(ipc.getSessionAgentSetting).mockClear();
    vi.mocked(ipc.getSessionAgentSetting).mockResolvedValue(null);
    useAgentStore.setState({ agents: [], loaded: true });
    useChatStore.setState({
      openTabs: [],
      active: null,
      activeEngine: "claude",
      models: {},
      efforts: {},
      bySession: {},
      streamingByKey: {},
      unseen: {},
      drafts: {},
      sessions: [],
    });
  });

  it("sends the identity's tools/model/effort/context with the definition", async () => {
    selectSelectedAgent(
      WS,
      null,
      customAgent({
        tools: ["Bash", "Read"],
        model: "haiku",
        context: ["claudemd"],
        effort: "high",
      }),
    );
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("hi", []);

    const sent = sentArgs();
    expect(sent.agentTools).toEqual(["Bash", "Read"]);
    expect(sent.model).toBe("haiku");
    expect(sent.effort).toBe("high");
    const defs = JSON.parse(sent.agentsJson ?? "{}") as Record<
      string,
      { prompt: string; tools?: string[]; model?: string; effort?: string; context: string[] }
    >;
    expect(defs["审查员"]?.tools).toEqual(["Bash", "Read"]);
    expect(defs["审查员"]?.model).toBe("haiku");
    expect(defs["审查员"]?.effort).toBe("high");
    expect(defs["审查员"]?.context).toEqual(["claudemd"]);
  });

  it("keeps an explicitly empty tool list (disable every tool)", async () => {
    selectSelectedAgent(WS, null, customAgent({ tools: [] }));
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("hi", []);

    const sent = sentArgs();
    expect(sent.agentTools).toEqual([]);
    const defs = JSON.parse(sent.agentsJson ?? "{}") as Record<
      string,
      { tools?: string[] }
    >;
    expect(defs["审查员"]?.tools).toEqual([]);
  });

  it("falls back to a minimal prompt when the identity has none", async () => {
    selectSelectedAgent(WS, null, customAgent({ prompt: undefined }));
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("hi", []);

    const sent = sentArgs();
    // Without the fallback the definition would be skipped entirely and the
    // identity (tools, model) would silently not apply.
    expect(sent.agentName).toBe("审查员");
    const defs = JSON.parse(sent.agentsJson ?? "{}") as Record<
      string,
      { prompt: string }
    >;
    expect(defs["审查员"]?.prompt.length ?? 0).toBeGreaterThan(0);
  });

  it("clones the conversation when the identity changes after messages", async () => {
    // First send adopts a real session id (the backend reports one).
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({
      runId: "run-1",
      sessionId: "s-1",
    });
    selectSelectedAgent(WS, null, customAgent());
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("hi", []);
    expect(getRecordedAgent(WS, "s-1")).toBe("审查员");

    // Switch the identity and send again: the send path must clone first.
    selectSelectedAgent(WS, "s-1", customAgent({ id: "a2", name: "新身份" }));
    await useChatStore.getState().send("again", []);

    expect(vi.mocked(ipc.cloneSession)).toHaveBeenCalledWith("claude", "s-1", WS);
    const last = sentArgs(vi.mocked(ipc.sendMessage).mock.calls.length - 1);
    expect(last.sessionId).toBe("s-2");
    const defs = JSON.parse(last.agentsJson ?? "{}") as Record<string, unknown>;
    expect(Object.keys(defs)).toEqual(["新身份"]);
    // The clone keeps the freshly recorded identity for the next compare.
    expect(getRecordedAgent(WS, "s-2")).toBe("新身份");
    // The source session goes back to its own identity — here its
    // definition is not in the catalog, so the pick is cleared and the
    // record follows (the source stays identity-less, as the CLI restores).
    expect(getSelectedAgent(WS, "s-1")).toBeNull();
    expect(getRecordedAgent(WS, "s-1")).toBeNull();
  });

  it("does not clone when the identity is unchanged", async () => {
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({
      runId: "run-1",
      sessionId: "s-1",
    });
    selectSelectedAgent(WS, null, customAgent());
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("hi", []);
    await useChatStore.getState().send("again", []);

    expect(vi.mocked(ipc.cloneSession)).not.toHaveBeenCalled();
    const last = sentArgs(vi.mocked(ipc.sendMessage).mock.calls.length - 1);
    expect(last.sessionId).toBe("s-1");
  });

  it("blocks the send and surfaces an error when cloning fails", async () => {
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({
      runId: "run-1",
      sessionId: "s-1",
    });
    selectSelectedAgent(WS, null, customAgent());
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("hi", []);

    vi.mocked(ipc.sendMessage).mockClear();
    vi.mocked(ipc.cloneSession).mockRejectedValueOnce(new Error("boom"));
    selectSelectedAgent(WS, "s-1", customAgent({ id: "a2", name: "新身份" }));
    await useChatStore.getState().send("again", []);

    expect(vi.mocked(ipc.sendMessage)).not.toHaveBeenCalled();
    const key = sessionKey("claude", "s-1", WS);
    expect(useChatStore.getState().bySession[key]?.error).toBeTruthy();
  });

  it("falls back to the identity recorded in the session file", async () => {
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({
      runId: "run-1",
      sessionId: "s-1",
    });
    selectSelectedAgent(WS, null, customAgent());
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("hi", []);

    // Simulate "no local record" (a CI-era file, or a cleared store): wipe
    // the record store and let the file answer instead.
    localStorage.removeItem("hzkcode.sessionAgentByThread:v1");
    vi.mocked(ipc.sendMessage).mockClear();

    // Same identity in the file and in the picker: no clone.
    vi.mocked(ipc.getSessionAgentSetting).mockResolvedValueOnce("审查员");
    await useChatStore.getState().send("again", []);
    expect(vi.mocked(ipc.getSessionAgentSetting)).toHaveBeenCalledWith(
      "claude",
      "s-1",
    );
    expect(vi.mocked(ipc.cloneSession)).not.toHaveBeenCalled();
    expect(
      sentArgs(vi.mocked(ipc.sendMessage).mock.calls.length - 1).sessionId,
    ).toBe("s-1");

    // A different identity in the file: clone.
    localStorage.removeItem("hzkcode.sessionAgentByThread:v1");
    vi.mocked(ipc.getSessionAgentSetting).mockResolvedValueOnce("别的身份");
    await useChatStore.getState().send("third", []);
    expect(vi.mocked(ipc.cloneSession)).toHaveBeenCalledWith("claude", "s-1", WS);
  });

  it("keeps the record empty when the send fails", async () => {
    vi.mocked(ipc.sendMessage).mockRejectedValueOnce(new Error("spawn failed"));
    selectSelectedAgent(WS, null, customAgent());
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("hi", []);

    // The failed send must not mark the thread as "already sent with this
    // identity": the retry has to clone.
    expect(getRecordedAgent(WS, null)).toBeUndefined();
    expect(getRecordedAgent(WS, "s-1")).toBeUndefined();
  });

  it("does not clone when the pinned built-in agent fails to resolve", async () => {
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({
      runId: "run-1",
      sessionId: "s-1",
    });
    selectSelectedAgent(WS, null, customAgent());
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("hi", []);

    // The built-in pick stops resolving (catalog entry disabled): the send
    // must fall back in place — the identity did not change by user choice.
    vi.mocked(ipc.sendMessage).mockClear();
    vi.mocked(
      ipc.resolveEnabledBuiltInAgent,
    ).mockRejectedValueOnce(new Error("disabled"));
    selectSelectedAgent(WS, "s-1", {
      id: "catalog:built-in",
      name: "内置身份",
      source: "builtIn",
    });
    await useChatStore.getState().send("again", []);

    expect(vi.mocked(ipc.cloneSession)).not.toHaveBeenCalled();
    const last = sentArgs(vi.mocked(ipc.sendMessage).mock.calls.length - 1);
    expect(last.sessionId).toBe("s-1");
    expect(last.agentName).toBeNull();
  });

  it("restores the source session's identity when its definition exists", async () => {
    useAgentStore.setState({ agents: [customAgent()], loaded: true });
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({
      runId: "run-1",
      sessionId: "s-1",
    });
    selectSelectedAgent(WS, null, customAgent());
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("hi", []);
    expect(getRecordedAgent(WS, "s-1")).toBe("审查员");

    // Switch identity: the send clones, and the source regains its own pick
    // while the clone carries the new one.
    selectSelectedAgent(WS, "s-1", customAgent({ id: "a2", name: "新身份" }));
    await useChatStore.getState().send("again", []);
    expect(getSelectedAgent(WS, "s-1")?.name).toBe("审查员");
    expect(getSelectedAgent(WS, "s-2")?.name).toBe("新身份");

    // Returning to the source and sending again must not clone a second
    // time — it resumes under the source identity.
    const cloneCalls = vi.mocked(ipc.cloneSession).mock.calls.length;
    await useChatStore.getState().selectSession("claude", "s-1", WS);
    await useChatStore.getState().send("back", []);
    expect(vi.mocked(ipc.cloneSession).mock.calls.length).toBe(cloneCalls);
    const last = sentArgs(vi.mocked(ipc.sendMessage).mock.calls.length - 1);
    expect(last.sessionId).toBe("s-1");
    expect(last.agentName).toBe("审查员");
  });
});
