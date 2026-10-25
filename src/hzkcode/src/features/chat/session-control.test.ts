import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ipc,
  type SessionControlResult,
  type SessionControlState,
  type SessionMeta,
} from "@/lib/ipc";
import type { ActiveSession } from "./store/persistence";
import type { SessionState } from "./store/stream";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sessionControl: vi.fn(),
    resolveEnabledBuiltInAgent: vi.fn(async (id: string) => ({ id, name: "角色", prompt: "角色定义" })),
    sendMessage: vi.fn(async () => ({ runId: "run-1", sessionId: null })),
    loadSessionPage: vi.fn(async () => ({
      messages: [],
      nextBefore: null,
      subagentHistory: [],
    })),
    loadRemoteSessionPage: vi.fn(async () => ({
      messages: [],
      nextBefore: null,
      subagentHistory: [],
    })),
    listSessions: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => []),
    listEngines: vi.fn(async () => []),
    getAppSettings: vi.fn(async () => ({})),
    getCliConfig: vi.fn(async () => null),
    updateAppSettings: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
    rememberSessionProvider: vi.fn(async () => {}),
    rememberSessionModel: vi.fn(async () => {}),
    rememberSessionEffort: vi.fn(async () => {}),
    interruptSession: vi.fn(async () => true),
  },
}));

const listener = vi.hoisted(() => ({
  sessionsChanged: null as null | (() => void),
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async (callback: () => void) => {
    listener.sessionsChanged = callback;
    return () => {};
  }),
}));

const { useChatStore } = await import("./store");
const { useAgentStore } = await import("@/features/agents/agent-store");
const { EMPTY_SESSION } = await import("./store/stream");
const { sessionKey } = await import("./store/persistence");

const WS = "/tmp/ws-session-control";

function controlState(
  overrides: Partial<SessionControlState> = {},
): SessionControlState {
  return {
    hasConversation: true,
    availableApplyMethods: {
      identity: ["current", "clone", "append"],
      promptMode: ["current", "clone"],
    },
    identity: { base: null, extensions: [] },
    promptMode: { effective: "full", override: null, source: "startup" },
    interactionMode: { effective: "default", override: null, source: "startup" },
    apiMode: { effective: "anthropic", override: null, source: "startup" },
    model: { effective: "", override: null, source: "startup" },
    effort: { effective: null, override: null, source: "startup" },
    permission: { effective: "default", override: null, source: "startup" },
    ...overrides,
  };
}

function controlResult(
  overrides: Partial<SessionControlResult> = {},
): SessionControlResult {
  return {
    type: "result",
    operation: "catalog",
    schemaVersion: 1,
    sourceSessionId: null,
    targetSessionId: null,
    session_id: null,
    cloned: false,
    is_error: false,
    subtype: "success",
    error_code: null,
    revision: "r-1",
    state: controlState(),
    catalog: { identities: [], interactionModes: [] },
    ...overrides,
  };
}

function setActive(
  sessionId: string | null,
  options: {
    tab?: Partial<ActiveSession>;
    bySession?: Record<string, SessionState>;
    drafts?: Record<string, string>;
    providers?: Record<string, string>;
  } = {},
) {
  const tab = {
    engine: "claude",
    sessionId,
    workspacePath: WS,
    ...options.tab,
  };
  const key = sessionKey("claude", sessionId, WS);
  useChatStore.setState({
    openTabs: [tab],
    active: tab,
    activeEngine: "claude",
    providers: options.providers ?? {},
    models: {},
    efforts: {},
    channelDefaults: {},
    permission: "bypass",
    engines: [],
    bySession: options.bySession ?? {
      [key]: { ...EMPTY_SESSION, messages: [] },
    },
    drafts: options.drafts ?? {},
    streamingByKey: {},
    controlBusyByKey: {},
    controlBusy: false,
    sessions: [],
    actionError: null,
  });
  return { tab, key };
}

const sentArgs = (call = 0) =>
  vi.mocked(ipc.sendMessage).mock.calls[call]?.[0] as unknown as {
    model: string | null;
    effort: string | null;
    permission: string | null;
    agentName: string | null;
    agentTools?: string[] | null;
    agentsJson: string | null;
    sessionId: string | null;
  };

beforeEach(() => {
  localStorage.clear();
  vi.mocked(ipc.sessionControl).mockReset();
  vi.mocked(ipc.sessionControl).mockResolvedValue(controlResult());
  vi.mocked(ipc.sendMessage).mockClear();
  vi.mocked(ipc.sendMessage).mockResolvedValue({
    runId: "run-1",
    sessionId: null,
  });
  vi.mocked(ipc.loadSessionPage).mockClear();
  vi.mocked(ipc.loadSessionPage).mockResolvedValue({
    messages: [],
    nextBefore: null,
    subagentHistory: [],
  });
  vi.mocked(ipc.rememberSessionProvider).mockClear();
  useAgentStore.setState({ agents: [], builtInAgents: [], loaded: true });
});

describe("refreshSessionControl", () => {
  it("reads the catalog for a draft without sending or creating a session", async () => {
    const { key } = setActive(null);
    const result = await useChatStore.getState().refreshSessionControl();

    expect(result).not.toBeNull();
    expect(vi.mocked(ipc.sessionControl)).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "claude",
        workspacePath: WS,
        sessionId: null,
        request: { operation: "catalog" },
      }),
    );
    expect(vi.mocked(ipc.sendMessage)).not.toHaveBeenCalled();
    expect(useChatStore.getState().bySession[key]?.sessionControl).toEqual(
      result,
    );
    expect(useChatStore.getState().controlBusy).toBe(false);
  });

  it("reads catalog plus state for an existing session", async () => {
    const { key } = setActive("s-1");
    const result = controlResult({
      operation: "catalog",
      sourceSessionId: "s-1",
      targetSessionId: "s-1",
      session_id: "s-1",
      state: controlState({ hasConversation: true }),
    });
    vi.mocked(ipc.sessionControl).mockResolvedValue(result);

    const returned = await useChatStore.getState().refreshSessionControl();
    expect(returned).toEqual(result);
    expect(vi.mocked(ipc.sessionControl)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s-1",
        request: { operation: "catalog" },
      }),
    );
    expect(useChatStore.getState().bySession[key]?.sessionControl).toEqual(
      result,
    );
  });

  it("does not write a stale result into the newly focused session", async () => {
    const first = setActive("s-1");
    const { promise, resolve } = Promise.withResolvers<SessionControlResult>();
    vi.mocked(ipc.sessionControl).mockReturnValueOnce(promise);

    const refreshing = useChatStore.getState().refreshSessionControl();
    // The user switches to another session while the offline read runs; the
    // original tab stays open in the background.
    const sourceTab = useChatStore.getState().active!;
    const other = {
      engine: "claude",
      sessionId: "s-2",
      workspacePath: WS,
    };
    useChatStore.setState((state) => ({
      active: other,
      openTabs: [sourceTab, other],
      bySession: {
        ...state.bySession,
        [sessionKey("claude", "s-2", WS)]: { ...EMPTY_SESSION, messages: [] },
      },
      controlBusy: false,
    }));
    resolve(
      controlResult({
        operation: "status",
        sourceSessionId: "s-1",
        targetSessionId: "s-1",
        state: controlState(),
      }),
    );
    await refreshing;

    const active = useChatStore.getState().active;
    expect(active?.sessionId).toBe("s-2");
    expect(useChatStore.getState().bySession[first.key]?.sessionControl).toEqual(
      expect.objectContaining({ sourceSessionId: "s-1" }),
    );
    expect(
      useChatStore.getState().bySession[sessionKey("claude", "s-2", WS)]
        ?.sessionControl,
    ).toBeFalsy();
  });
});

describe("applySessionControl", () => {
  it("adopts the metadata-only session created by a first change", async () => {
    const { key } = setActive(null, {
      drafts: { [sessionKey("claude", null, WS)]: "draft text" },
      providers: { claude: "channel-a" },
      bySession: {
        [sessionKey("claude", null, WS)]: {
          ...EMPTY_SESSION,
          messages: [],
          proxyEnabled: true,
          secondBrainEnabled: false,
          autoCompactWindow: 1234,
        },
      },
    });
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      controlResult({
        operation: "identity",
        sourceSessionId: null,
        targetSessionId: "s-new",
        session_id: "s-new",
        state: controlState({
          hasConversation: false,
          identity: { base: "审查员", extensions: [] },
        }),
      }),
    );

    const ok = await useChatStore
      .getState()
      .applySessionControl({ operation: "identity", value: "审查员", apply: "current" });

    expect(ok).toBe(true);
    const state = useChatStore.getState();
    expect(state.active?.sessionId).toBe("s-new");
    expect(state.openTabs).toHaveLength(1);
    expect(state.openTabs[0]?.sessionId).toBe("s-new");
    const targetKey = sessionKey("claude", "s-new", WS);
    expect(state.bySession[targetKey]?.sessionControl).toEqual(
      expect.objectContaining({ targetSessionId: "s-new" }),
    );
    expect(state.bySession[targetKey]?.proxyEnabled).toBe(true);
    expect(state.bySession[targetKey]?.secondBrainEnabled).toBe(false);
    expect(state.bySession[targetKey]?.autoCompactWindow).toBe(1234);
    expect(state.drafts[targetKey]).toBe("draft text");
    expect(state.drafts[key]).toBeUndefined();
    expect(vi.mocked(ipc.rememberSessionProvider)).toHaveBeenCalledWith(
      "claude",
      "s-new",
      "channel-a",
    );
    expect(vi.mocked(ipc.sendMessage)).not.toHaveBeenCalled();
  });

  it("keeps the source session when a change clones", async () => {
    const { key } = setActive("s-1", {
      drafts: { [sessionKey("claude", "s-1", WS)]: "next message" },
      bySession: {
        [sessionKey("claude", "s-1", WS)]: {
          ...EMPTY_SESSION,
          messages: [],
          proxyEnabled: true,
          secondBrainEnabled: true,
          autoCompactWindow: 900,
          activeProvider: "channel-a",
        },
      },
    });
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      controlResult({
        operation: "identity",
        sourceSessionId: "s-1",
        targetSessionId: "s-2",
        session_id: "s-2",
        cloned: true,
        state: controlState({ identity: { base: "新身份", extensions: [] } }),
      }),
    );

    const ok = await useChatStore
      .getState()
      .applySessionControl({ operation: "identity", value: "新身份", apply: "clone" });

    expect(ok).toBe(true);
    const state = useChatStore.getState();
    const targetKey = sessionKey("claude", "s-2", WS);
    expect(state.active?.sessionId).toBe("s-2");
    expect(state.openTabs.map((tab) => tab.sessionId).sort()).toEqual([
      "s-1",
      "s-2",
    ]);
    expect(state.bySession[key]?.messages).toEqual([]);
    expect(state.bySession[key]?.proxyEnabled).toBe(true);
    expect(state.bySession[targetKey]?.proxyEnabled).toBe(true);
    expect(state.bySession[targetKey]?.secondBrainEnabled).toBe(true);
    expect(state.bySession[targetKey]?.autoCompactWindow).toBe(900);
    expect(state.drafts[targetKey]).toBe("next message");
    expect(state.drafts[key]).toBe("next message");
    expect(vi.mocked(ipc.rememberSessionProvider)).toHaveBeenCalledWith(
      "claude",
      "s-2",
      "channel-a",
    );
  });

  it("leaves the session and draft untouched when the engine rejects the change", async () => {
    const draftKey = sessionKey("claude", null, WS);
    setActive(null, { drafts: { [draftKey]: "keep me" } });
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      controlResult({
        operation: "identity",
        sourceSessionId: null,
        targetSessionId: null,
        is_error: true,
        subtype: "error_during_execution",
        error_code: "file_changed",
        state: null,
        errors: ["会话文件已变化"],
      }),
    );

    const ok = await useChatStore
      .getState()
      .applySessionControl({ operation: "identity", value: "审查员", apply: "current" });

    expect(ok).toBe(false);
    const state = useChatStore.getState();
    expect(state.active?.sessionId).toBeNull();
    expect(state.drafts[draftKey]).toBe("keep me");
    expect(state.actionError).toContain("会话文件已变化");
    expect(vi.mocked(ipc.loadSessionPage)).not.toHaveBeenCalled();
    expect(state.controlBusy).toBe(false);
  });

  it("blocks a second change and a send while busy", async () => {
    const { key } = setActive("s-1");
    const { promise, resolve } = Promise.withResolvers<SessionControlResult>();
    vi.mocked(ipc.sessionControl).mockReturnValueOnce(promise);

    const first = useChatStore
      .getState()
      .applySessionControl({ operation: "prompt-mode", value: "compact", apply: "current" });
    const second = await useChatStore
      .getState()
      .applySessionControl({ operation: "prompt-mode", value: "full", apply: "current" });
    expect(second).toBe(false);
    await vi.waitFor(() => expect(ipc.sessionControl).toHaveBeenCalledTimes(1));
    expect(useChatStore.getState().controlBusy).toBe(true);

    await useChatStore.getState().send("hello", []);
    expect(vi.mocked(ipc.sendMessage)).not.toHaveBeenCalled();
    expect(useChatStore.getState().bySession[key]?.error).toBeTruthy();

    resolve(
      controlResult({
        operation: "prompt-mode",
        sourceSessionId: "s-1",
        targetSessionId: "s-1",
        state: controlState({
          promptMode: { effective: "compact", override: "compact", source: "session" },
        }),
      }),
    );
    await expect(first).resolves.toBe(true);
    expect(useChatStore.getState().controlBusy).toBe(false);
  });

  it("does not send a revision when a draft creates a session", async () => {
    setActive(null);
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      controlResult({
        operation: "prompt-mode",
        sourceSessionId: null,
        targetSessionId: "s-new",
        session_id: "s-new",
        state: controlState({ hasConversation: false }),
      }),
    );

    await useChatStore
      .getState()
      .applySessionControl({ operation: "prompt-mode", value: "compact", apply: "current" });

    const request = vi.mocked(ipc.sessionControl).mock.calls[0]?.[0].request;
    expect(request).not.toHaveProperty("expectedRevision");
  });

  it("guards an existing session with the last successful revision", async () => {
    const { key } = setActive("s-1");
    useChatStore.setState((state) => ({
      bySession: {
        ...state.bySession,
        [key]: {
          ...state.bySession[key]!,
          sessionControl: controlResult({ revision: "r-9" }),
        },
      },
    }));
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      controlResult({
        operation: "prompt-mode",
        sourceSessionId: "s-1",
        targetSessionId: "s-1",
        revision: "r-10",
        state: controlState(),
      }),
    );

    await useChatStore
      .getState()
      .applySessionControl({ operation: "prompt-mode", value: "compact", apply: "current" });

    expect(vi.mocked(ipc.sessionControl)).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ expectedRevision: "r-9" }),
      }),
    );
  });

  it("does not steal focus when the result lands after a session switch", async () => {
    setActive("s-1");
    const { promise, resolve } = Promise.withResolvers<SessionControlResult>();
    vi.mocked(ipc.sessionControl).mockReturnValueOnce(promise);

    const applying = useChatStore
      .getState()
      .applySessionControl({ operation: "identity", value: "新身份", apply: "clone" });
    const other = {
      engine: "claude",
      sessionId: "s-9",
      workspacePath: WS,
    };
    useChatStore.setState((state) => ({
      active: other,
      openTabs: [...state.openTabs, other],
      bySession: {
        ...state.bySession,
        [sessionKey("claude", "s-9", WS)]: { ...EMPTY_SESSION, messages: [] },
      },
      controlBusy: false,
    }));

    resolve(
      controlResult({
        operation: "identity",
        sourceSessionId: "s-1",
        targetSessionId: "s-2",
        session_id: "s-2",
        cloned: true,
        state: controlState(),
      }),
    );
    await applying;

    const state = useChatStore.getState();
    expect(state.active?.sessionId).toBe("s-9");
    expect(state.openTabs.some((tab) => tab.sessionId === "s-2")).toBe(true);
    expect(state.controlBusy).toBe(false);
  });
});

describe("send parameters after session control", () => {
  it("omits model/effort/permission when the session already saved them", async () => {
    const { key } = setActive("s-1");
    useChatStore.setState({
      models: { claude: "old-default" },
      efforts: { claude: "low" },
      permission: "bypass",
    });
    useChatStore.setState((state) => ({
      bySession: {
        ...state.bySession,
        [key]: {
          ...state.bySession[key]!,
          sessionControl: controlResult({
            operation: "status",
            sourceSessionId: "s-1",
            targetSessionId: "s-1",
            state: controlState({
              model: { effective: "saved-model", override: "saved-model", source: "session" },
              effort: { effective: "high", override: "high", source: "session" },
              permission: { effective: "plan", override: "plan", source: "session" },
            }),
          }),
        },
      },
    }));
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      controlResult({
        operation: "status",
        sourceSessionId: "s-1",
        targetSessionId: "s-1",
        state: controlState({
          model: { effective: "saved-model", override: "saved-model", source: "session" },
          effort: { effective: "high", override: "high", source: "session" },
          permission: { effective: "plan", override: "plan", source: "session" },
        }),
      }),
    );

    await useChatStore.getState().send("hi", []);

    const sent = sentArgs();
    expect(sent.model).toBeNull();
    expect(sent.effort).toBeNull();
    expect(sent.permission).toBeNull();
  });

  it("omits session-sourced values even when the override is null", async () => {
    const { key } = setActive("s-1");
    useChatStore.setState({
      models: { claude: "old-default" },
      efforts: { claude: "low" },
      permission: "bypass",
    });
    const saved = controlState({
      model: { effective: "saved-model", override: null, source: "session" },
      effort: { effective: "off", override: null, source: "session" },
      permission: { effective: "plan", override: null, source: "session" },
    });
    useChatStore.setState((state) => ({
      bySession: {
        ...state.bySession,
        [key]: {
          ...state.bySession[key]!,
          sessionControl: controlResult({
            operation: "status",
            sourceSessionId: "s-1",
            targetSessionId: "s-1",
            state: saved,
          }),
        },
      },
    }));
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      controlResult({
        operation: "status",
        sourceSessionId: "s-1",
        targetSessionId: "s-1",
        state: saved,
      }),
    );

    await useChatStore.getState().send("hi", []);

    const sent = sentArgs();
    expect(sent.model).toBeNull();
    expect(sent.effort).toBeNull();
    expect(sent.permission).toBeNull();
  });

  it("passes explicit composer choices even when the session saved others", async () => {
    const { key } = setActive("s-1");
    const saved = controlState({
      model: { effective: "saved-model", override: "saved-model", source: "session" },
      effort: { effective: "low", override: "low", source: "session" },
      permission: { effective: "plan", override: "plan", source: "session" },
    });    useChatStore.setState((state) => ({
      bySession: {
        ...state.bySession,
        [key]: {
          ...state.bySession[key]!,
          sessionControl: controlResult({
            operation: "status",
            sourceSessionId: "s-1",
            targetSessionId: "s-1",
            state: saved,
          }),
        },
      },
    }));
    vi.mocked(ipc.sessionControl).mockResolvedValue(
      controlResult({
        operation: "status",
        sourceSessionId: "s-1",
        targetSessionId: "s-1",
        state: saved,
      }),
    );

    await useChatStore.getState().setModel("claude", "new-model");
    await useChatStore.getState().setEffort("claude", "max");
    useChatStore.getState().setPermission("acceptEdits");
    await useChatStore.getState().send("hi", []);

    const sent = sentArgs();
    expect(sent.model).toBe("new-model");
    expect(sent.effort).toBe("max");
    expect(sent.permission).toBe("acceptEdits");
  });

  it("skips the control bridge for remote (plugin-fed) sessions", async () => {
    setActive("s-1");
    useChatStore.setState({
      sessions: [
        {
          engine: "claude",
          sessionId: "s-1",
          workspacePath: WS,
          filePath: "",
          remote: true,
          remotePath: "/remote/session.jsonl",
        } as SessionMeta,
      ],
    });

    await useChatStore.getState().send("hi", []);

    expect(vi.mocked(ipc.sessionControl)).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenCalledTimes(1);
  });

  it("blocks a send when the pre-send status cannot be read", async () => {
    setActive("s-1");
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      controlResult({
        operation: "status",
        sourceSessionId: "s-1",
        targetSessionId: "s-1",
        is_error: true,
        subtype: "error_during_execution",
        error_code: "invalid_session",
        state: null,
        errors: ["会话不存在"],
      }),
    );

    await useChatStore.getState().send("hi", []);

    expect(vi.mocked(ipc.sendMessage)).not.toHaveBeenCalled();
    expect(useChatStore.getState().actionError).toContain("会话不存在");
  });

  it("restores the user's draft when a pre-send read blocks the turn", async () => {
    const { key } = setActive("s-1");
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      controlResult({
        operation: "status",
        sourceSessionId: "s-1",
        targetSessionId: "s-1",
        is_error: true,
        subtype: "error_during_execution",
        error_code: "invalid_session",
        state: null,
        errors: ["会话不存在"],
      }),
    );

    await useChatStore.getState().send("keep this draft", []);

    expect(vi.mocked(ipc.sendMessage)).not.toHaveBeenCalled();
    expect(useChatStore.getState().drafts[key]).toBe("keep this draft");
  });

  it("settles explicit picks made while the pre-send read is in flight", async () => {
    const { key } = setActive("s-1");
    const { promise, resolve } = Promise.withResolvers<SessionControlResult>();
    vi.mocked(ipc.sessionControl).mockReturnValueOnce(promise);

    const sending = useChatStore.getState().send("hi", []);
    await useChatStore.getState().setModel("claude", "during-read");
    await useChatStore.getState().setEffort("claude", "max");
    useChatStore.getState().setPermission("acceptEdits");
    resolve(
      controlResult({
        operation: "status",
        sourceSessionId: "s-1",
        targetSessionId: "s-1",
        state: controlState(),
      }),
    );
    await sending;

    const sent = sentArgs();
    expect(sent.model).toBe("during-read");
    expect(sent.effort).toBe("max");
    expect(sent.permission).toBe("acceptEdits");
    expect(useChatStore.getState().bySession[key]?.sessionControl).toEqual(
      expect.objectContaining({ sourceSessionId: "s-1" }),
    );
  });

  it("refreshes status read-only before the send and registers only custom identities", async () => {
    setActive("s-1");
    useAgentStore.setState({
      agents: [
        { id: "a1", name: "审查员", prompt: "严格审查。" },
        { id: "b1", name: "内置", prompt: "内置", source: "builtIn" },
      ],
      loaded: true,
    });

    await useChatStore.getState().send("hi", []);

    expect(vi.mocked(ipc.sessionControl)).toHaveBeenCalledWith(
      expect.objectContaining({ request: { operation: "status" } }),
    );
    const sent = sentArgs();
    expect(sent.agentName).toBeNull();
    expect(sent.agentTools).toBeNull();
    const defs = JSON.parse(sent.agentsJson ?? "{}") as Record<string, unknown>;
    expect(Object.keys(defs)).toEqual(["审查员"]);
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenCalledTimes(1);
  });

  it("reloads after append without inventing a user message", async () => {
    const { key } = setActive("s-1");
    useChatStore.setState((state) => ({
      bySession: {
        ...state.bySession,
        [key]: {
          ...state.bySession[key]!,
          messages: [
            {
              seq: 1,
              role: "user",
              text: "hi",
              ts: new Date().toISOString(),
            },
          ],
        },
      },
    }));
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      controlResult({
        operation: "identity",
        sourceSessionId: "s-1",
        targetSessionId: "s-1",
        state: controlState({ identity: { base: null, extensions: [] } }),
      }),
    );
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({
      messages: [
        { seq: 1, role: "user", text: "hi", ts: new Date().toISOString() },
        { seq: 2, role: "assistant", text: "ok", ts: new Date().toISOString() },
      ],
      nextBefore: null,
      subagentHistory: [],
    });

    const ok = await useChatStore
      .getState()
      .applySessionControl({ operation: "identity", value: "审查员", apply: "append" });

    expect(ok).toBe(true);
    expect(
      useChatStore.getState().bySession[key]?.messages.map((message) => message.role),
    ).toEqual(["user", "assistant"]);
  });
});

describe("会话控制的异步边界", () => {
  it("接受发送时只清理该会话已提交的草稿", async () => {
    const key = sessionKey("claude", null, WS);
    const other = sessionKey("claude", "other", WS);
    setActive(null, { drafts: { [key]: "hi", [other]: "hi" } });
    vi.mocked(ipc.sendMessage).mockImplementationOnce(async () => {
      expect(useChatStore.getState().drafts[key]).toBe("");
      expect(useChatStore.getState().drafts[other]).toBe("hi");
      useChatStore.getState().setDraft(key, "next input");
      return { runId: "native-run", sessionId: "native-session" };
    });
    expect(await useChatStore.getState().send("hi", [])).toBe(true);
    expect(useChatStore.getState().drafts[key]).toBe("next input");
    expect(useChatStore.getState().drafts[other]).toBe("hi");
  });

  it("按稳定 ID 注册新选择的应用自带角色", async () => {
    setActive(null);
    const id = "agency-agents:design/design-ui-designer";
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(controlResult({
      operation: "identity", targetSessionId: "s-new", session_id: "s-new",
      state: controlState({ identity: { base: id, extensions: [] } }),
    }));
    expect(await useChatStore.getState().applySessionControl({
      operation: "identity", value: id, apply: "current",
    })).toBe(true);
    const params = vi.mocked(ipc.sessionControl).mock.calls[0]![0];
    expect(params.engine).toBe("claude");
    expect(params.workspacePath).toBe(WS);
    expect(Object.keys(JSON.parse(params.agentsJson!))).toEqual([id]);
    expect(ipc.resolveEnabledBuiltInAgent).toHaveBeenCalledWith(id);
  });

  it("发送同时恢复基础角色和追加角色的定义", async () => {
    setActive("s-1");
    const base = "agency-agents:design/base";
    const extension = "agency-agents:design/extension";
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(controlResult({
      operation: "status", sourceSessionId: "s-1",
      state: controlState({ identity: { base, extensions: [{ agentType: extension }] } }),
    }));
    expect(await useChatStore.getState().send("hi", [])).toBe(true);
    expect(Object.keys(JSON.parse(sentArgs().agentsJson!)).sort()).toEqual([base, extension].sort());
    expect(sentArgs().agentName).toBeNull();
    expect(sentArgs().agentTools).toBeNull();
  });

  it("角色定义不可用时拒绝发送且保留草稿", async () => {
    const { key } = setActive("s-1");
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(controlResult({
      operation: "status", sourceSessionId: "s-1",
      state: controlState({ identity: { base: "agency-agents:gone", extensions: [] } }),
    }));
    vi.mocked(ipc.resolveEnabledBuiltInAgent).mockRejectedValueOnce(new Error("unavailable"));
    expect(await useChatStore.getState().send("keep", ["/image.png"])).toBe(false);
    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().drafts[key]).toBe("keep");
    expect(useChatStore.getState().controlBusy).toBe(false);
  });

  it("状态预检等待期间不能重复发送或修改会话", async () => {
    setActive("s-1");
    const pending = Promise.withResolvers<SessionControlResult>();
    vi.mocked(ipc.sessionControl).mockReturnValueOnce(pending.promise);
    const first = useChatStore.getState().send("first", []);
    expect(await useChatStore.getState().send("second", [])).toBe(false);
    expect(await useChatStore.getState().applySessionControl({
      operation: "api-mode", value: "responses",
    })).toBe(false);
    pending.resolve(controlResult({ operation: "status", sourceSessionId: "s-1" }));
    expect(await first).toBe(true);
    expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("完整身份切换结算旧选择并采纳新身份设置", async () => {
    const { key } = setActive("s-1");
    await useChatStore.getState().setModel("claude", "old-model");
    await useChatStore.getState().setEffort("claude", "low");
    useChatStore.getState().setPermission("bypass");
    const saved = controlState({
      model: { effective: "identity-model", override: "identity-model", source: "session" },
      effort: { effective: "max", override: "max", source: "session" },
      permission: { effective: "plan", override: "plan", source: "session" },
    });
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(controlResult({
      operation: "identity", sourceSessionId: "s-1", targetSessionId: "s-1", state: saved,
    })).mockResolvedValueOnce(controlResult({ operation: "status", sourceSessionId: "s-1", state: saved }));
    expect(await useChatStore.getState().applySessionControl({
      operation: "identity", value: "reviewer", apply: "current",
    })).toBe(true);
    expect(useChatStore.getState().bySession[key]).toMatchObject({
      controlModelChosen: false, controlEffortChosen: false, controlPermissionChosen: false,
    });
    expect(useChatStore.getState().active?.model).toBe("identity-model");
    await useChatStore.getState().send("hi", []);
    expect(sentArgs()).toMatchObject({ model: null, effort: null, permission: null });
  });

  it("旧发送回调不消费之后的新选择", async () => {
    const { key } = setActive("s-1");
    await useChatStore.getState().setModel("claude", "first-model");
    await useChatStore.getState().setEffort("claude", "low");
    useChatStore.getState().setPermission("default");
    const pending = Promise.withResolvers<{ runId: string; sessionId: string | null }>();
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(pending.promise);
    const sending = useChatStore.getState().send("hi", []);
    await vi.waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledTimes(1));
    await useChatStore.getState().setModel("claude", "next-model");
    await useChatStore.getState().setEffort("claude", "max");
    useChatStore.getState().setPermission("acceptEdits");
    pending.resolve({ runId: "run-race", sessionId: "s-1" });
    expect(await sending).toBe(true);
    expect(useChatStore.getState().bySession[key]).toMatchObject({
      controlModelChosen: true, controlEffortChosen: true,
      controlPermissionChosen: true, controlPermissionValue: "acceptEdits",
    });
    expect(sentArgs()).toMatchObject({ model: "first-model", effort: "low", permission: "default" });
  });
});

describe("sessions changed", () => {
  it("re-reads the active session control state from another window", async () => {
    setActive("s-1");
    await useChatStore.getState().init();
    setActive("s-1");
    expect(listener.sessionsChanged).not.toBeNull();

    vi.mocked(ipc.sessionControl).mockClear();
    vi.mocked(ipc.sessionControl).mockResolvedValue(
      controlResult({
        operation: "status",
        sourceSessionId: "s-1",
        targetSessionId: "s-1",
        state: controlState({
          identity: { base: "另一窗口身份", extensions: [] },
        }),
      }),
    );
    listener.sessionsChanged!();
    await vi.waitFor(() => {
      expect(vi.mocked(ipc.sessionControl)).toHaveBeenCalledWith(
        expect.objectContaining({ request: { operation: "catalog" } }),
      );
    });
  });
});
