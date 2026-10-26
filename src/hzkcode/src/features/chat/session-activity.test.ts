import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ipc,
  type Message,
  type SessionControlCatalog,
  type SessionControlIdentity,
  type SessionControlResult,
  type SessionControlState,
} from "@/lib/ipc";
import type { EngineEventPayload } from "@/lib/events";
import { useChatStore } from "./store";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION, runRouting } from "./store/stream";
import { handleEngineEvents, settledRuns, type EngineEventDeps } from "./store/engine-events";
import {
  getSessionActivities,
  mergeSessionActivities,
  type SessionActivity,
} from "./store/session-activity";
import type { ActiveSession } from "./store/persistence";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sessionControl: vi.fn(),
    sendMessage: vi.fn(async () => ({ runId: "run-1", sessionId: null })),
    resolveEnabledBuiltInAgent: vi.fn(async (id: string) => ({
      id,
      name: "角色",
      prompt: "角色定义",
    })),
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
    deleteSession: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));

const { useAgentStore } = await import("@/features/agents/agent-store");

function state(overrides: Partial<SessionControlState> = {}): SessionControlState {
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

function reviewer(): SessionControlIdentity {
  return {
    id: "reviewer",
    name: "审查员",
    description: "",
    source: "userSettings",
    tools: null,
    disallowedTools: [],
    model: null,
    effort: null,
    permissionMode: null,
  };
}

function catalog(overrides: Partial<SessionControlCatalog> = {}): SessionControlCatalog {
  return { identities: [reviewer()], interactionModes: [], ...overrides };
}

function result(overrides: Partial<SessionControlResult> = {}): SessionControlResult {
  return {
    type: "result",
    operation: "identity",
    schemaVersion: 1,
    sourceSessionId: null,
    targetSessionId: null,
    session_id: null,
    cloned: false,
    is_error: false,
    subtype: "success",
    error_code: null,
    revision: "r-1",
    state: state(),
    catalog: catalog(),
    ...overrides,
  };
}

let counter = 0;
function freshWorkspace(name: string): string {
  counter += 1;
  return `/tmp/ws-activity-${name}-${counter}`;
}

function setActive(
  sessionId: string | null,
  workspacePath: string,
): { key: string; tab: ActiveSession } {
  const tab: ActiveSession = { engine: "claude", sessionId, workspacePath };
  const key = sessionKey("claude", sessionId, workspacePath);
  useChatStore.setState({
    openTabs: [tab],
    active: tab,
    activeEngine: "claude",
    sessions: [],
    bySession: { [key]: { ...EMPTY_SESSION, sessionControl: null } },
    streamingByKey: {},
    controlBusyByKey: {},
    controlBusy: false,
    drafts: {},
    actionError: null,
    permission: "default",
    models: {},
    efforts: {},
    providers: {},
    channelDefaults: {},
    unseen: {},
  });
  useAgentStore.setState({ agents: [], builtInAgents: [], loaded: true });
  return { key, tab };
}

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  runRouting.clear();
  settledRuns.clear();
});

describe("session activity records", () => {
  it("records a successful identity change with target, effective value and apply method", async () => {
    const workspacePath = freshWorkspace("identity");
    const { key } = setActive("s-1", workspacePath);
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      result({
        operation: "identity",
        sourceSessionId: "s-1",
        targetSessionId: "s-1",
        state: state({ identity: { base: "reviewer", extensions: [] } }),
      }),
    );

    const ok = await useChatStore.getState().applySessionControl({
      operation: "identity",
      value: "reviewer",
      apply: "current",
    });

    expect(ok).toBe(true);
    expect(getSessionActivities(key)).toEqual([
      expect.objectContaining({
        kind: "identity",
        status: "success",
        value: "审查员",
        effective: "审查员",
        apply: "current",
      }),
    ]);
  });

  it("resolves an app built-in identity id to its display name", async () => {
    const workspacePath = freshWorkspace("builtin");
    const { key } = setActive("s-builtin", workspacePath);
    useAgentStore.setState({
      agents: [],
      builtInAgents: [
        {
          id: "agency-agents:reviewer",
          divisionId: "engineering",
          name: "审查角色",
          description: "",
          icon: null,
          enabled: true,
        },
      ],
      loaded: true,
    });
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      result({
        operation: "identity",
        sourceSessionId: "s-builtin",
        targetSessionId: "s-builtin",
        state: state({ identity: { base: "agency-agents:reviewer", extensions: [] } }),
        catalog: { identities: [], interactionModes: [] },
      }),
    );

    await useChatStore.getState().applySessionControl({
      operation: "identity",
      value: "agency-agents:reviewer",
      apply: "current",
    });

    expect(getSessionActivities(key)).toEqual([
      expect.objectContaining({
        kind: "identity",
        value: "审查角色",
        effective: "审查角色",
      }),
    ]);
  });

  it("records prompt-mode, interaction-mode and api-mode changes with their effective values", async () => {
    const workspacePath = freshWorkspace("modes");
    const { key } = setActive("s-modes", workspacePath);
    vi.mocked(ipc.sessionControl)
      .mockResolvedValueOnce(
        result({
          operation: "prompt-mode",
          sourceSessionId: "s-modes",
          targetSessionId: "s-modes",
          state: state({
            promptMode: { effective: "compact", override: "compact", source: "session" },
          }),
        }),
      )
      .mockResolvedValueOnce(
        result({
          operation: "interaction-mode",
          sourceSessionId: "s-modes",
          targetSessionId: "s-modes",
          state: state({
            interactionMode: { effective: "plan", override: "plan", source: "session" },
          }),
          catalog: catalog({
            interactionModes: [
              { slug: "plan", name: "计划模式", description: "" },
            ],
          }),
        }),
      )
      .mockResolvedValueOnce(
        result({
          operation: "api-mode",
          sourceSessionId: "s-modes",
          targetSessionId: "s-modes",
          state: state({
            apiMode: { effective: "responses", override: "responses", source: "session" },
          }),
        }),
      );

    await useChatStore.getState().applySessionControl({
      operation: "prompt-mode",
      value: "compact",
      apply: "current",
    });
    await useChatStore.getState().applySessionControl({
      operation: "interaction-mode",
      value: "plan",
    });
    await useChatStore.getState().applySessionControl({
      operation: "api-mode",
      value: "responses",
    });

    expect(getSessionActivities(key)).toEqual([
      expect.objectContaining({
        kind: "prompt-mode",
        value: "compact",
        effective: "compact",
        apply: "current",
      }),
      expect.objectContaining({
        kind: "interaction-mode",
        value: "计划模式",
        effective: "计划模式",
      }),
      expect.objectContaining({
        kind: "api-mode",
        value: "responses",
        effective: "responses",
      }),
    ]);
  });

  it("恢复默认但实际协议不变时仍记录覆盖值变化", async () => {
    const { key } = setActive("s-reset", freshWorkspace("reset"));
    const previous = result({
      operation: "api-mode",
      targetSessionId: "s-reset",
      state: state({ apiMode: { effective: "responses", override: "responses", source: "session" } }),
    });
    useChatStore.setState((s) => ({
      bySession: { ...s.bySession, [key]: { ...s.bySession[key], sessionControl: previous } },
    }));
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(result({
      operation: "api-mode",
      targetSessionId: "s-reset",
      state: state({ apiMode: { effective: "responses", override: null, source: "startup" } }),
    }));
    expect(await useChatStore.getState().applySessionControl({ operation: "api-mode", value: "reset" })).toBe(true);
    expect(getSessionActivities(key)).toEqual([
      expect.objectContaining({ kind: "api-mode", status: "success", value: "reset", effective: "responses" }),
    ]);
  });

  it("存储被另一个窗口更新或清除时不使用陈旧缓存", () => {
    const { key } = setActive("s-storage", freshWorkspace("storage"));
    useChatStore.getState().setSessionProxy(key, true);
    const first = getSessionActivities(key)[0];
    const changed = { ...first, id: "another-window", value: "off" };
    localStorage.setItem(`hzkcode.sessionActivity:v1:${key}`, JSON.stringify([changed]));
    expect(getSessionActivities(key)).toEqual([changed]);
    useChatStore.getState().setSessionSecondBrain(key, true);
    expect(getSessionActivities(key)).toHaveLength(2);
    expect(getSessionActivities(key)[0]).toEqual(changed);
    localStorage.removeItem(`hzkcode.sessionActivity:v1:${key}`);
    expect(getSessionActivities(key)).toHaveLength(0);
  });

  it("删除会话成功后清除其活动记录", async () => {
    const { key } = setActive("s-delete", freshWorkspace("delete"));
    useChatStore.getState().setSessionProxy(key, true);
    expect(getSessionActivities(key)).toHaveLength(1);
    await useChatStore.getState().deleteSession("claude", "s-delete");
    expect(ipc.deleteSession).toHaveBeenCalledWith("claude", "s-delete");
    expect(getSessionActivities(key)).toHaveLength(0);
    expect(localStorage.getItem(`hzkcode.sessionActivity:v1:${key}`)).toBeNull();
  });

  it("does not add a success record when the submitted value did not change", async () => {
    const workspacePath = freshWorkspace("unchanged");
    const { key } = setActive("s-2", workspacePath);
    const unchanged = result({
      operation: "identity",
      sourceSessionId: "s-2",
      targetSessionId: "s-2",
      state: state({ identity: { base: "reviewer", extensions: [] } }),
    });
    vi.mocked(ipc.sessionControl)
      .mockResolvedValueOnce(unchanged)
      .mockResolvedValueOnce(unchanged);

    await useChatStore.getState().applySessionControl({
      operation: "identity",
      value: "reviewer",
      apply: "current",
    });
    await useChatStore.getState().applySessionControl({
      operation: "identity",
      value: "reviewer",
      apply: "current",
    });

    expect(getSessionActivities(key)).toHaveLength(1);
    // 局部开关原地重复提交同一个值同样不算操作。
    useChatStore.getState().setSessionProxy(key, null);
    useChatStore.getState().setSessionAutoCompactWindow(key, null);
    expect(getSessionActivities(key)).toHaveLength(1);
  });

  it("records a failed operation as an error and never as success", async () => {
    const workspacePath = freshWorkspace("failure");
    const { key } = setActive("s-3", workspacePath);
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      result({
        operation: "interaction-mode",
        sourceSessionId: "s-3",
        targetSessionId: null,
        is_error: true,
        subtype: "error_during_execution",
        error_code: "file_changed",
        state: null,
        errors: ["transcript changed"],
      }),
    );

    const ok = await useChatStore.getState().applySessionControl({
      operation: "interaction-mode",
      value: "default",
    });

    expect(ok).toBe(false);
    expect(getSessionActivities(key)).toEqual([
      expect.objectContaining({
        kind: "interaction-mode",
        status: "error",
        error: "transcript changed",
      }),
    ]);
    expect(useChatStore.getState().actionError).toContain("transcript changed");
  });

  it("does not record read-only reads, menu closes or untouched switches", async () => {
    const workspacePath = freshWorkspace("read");
    const { key } = setActive("s-4", workspacePath);
    // 关闭菜单只是本地收起，不调用任何写入动作，因此没有记录。
    expect(getSessionActivities(key)).toHaveLength(0);
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      result({ operation: "status", targetSessionId: "s-4", state: state() }),
    );

    await useChatStore.getState().refreshSessionControl();

    expect(getSessionActivities(key)).toHaveLength(0);
    // 打开/关闭面板没有提交动作，不产生记录。
    useChatStore.getState().setSessionProxy(key, null);
    expect(getSessionActivities(key)).toHaveLength(0);
  });

  it("migrates draft records when a first control change creates the session id", async () => {
    const workspacePath = freshWorkspace("draft-control");
    const { key: draftKey } = setActive(null, workspacePath);
    useChatStore.getState().setSessionProxy(draftKey, true);
    expect(getSessionActivities(draftKey)).toHaveLength(1);

    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      result({
        operation: "identity",
        sourceSessionId: null,
        targetSessionId: "s-meta",
        state: state({ identity: { base: "reviewer", extensions: [] } }),
      }),
    );
    await useChatStore.getState().applySessionControl({
      operation: "identity",
      value: "reviewer",
      apply: "current",
    });

    const targetKey = sessionKey("claude", "s-meta", workspacePath);
    expect(getSessionActivities(draftKey)).toHaveLength(0);
    expect(getSessionActivities(targetKey).map((activity) => activity.kind)).toEqual([
      "proxy",
      "identity",
    ]);
  });

  it("migrates draft records when the engine announces the session id", () => {
    const workspacePath = freshWorkspace("draft-event");
    const { key: draftKey } = setActive(null, workspacePath);
    useChatStore.getState().setSessionSecondBrain(draftKey, false);
    runRouting.set("run-mig", draftKey);

    const event: EngineEventPayload = {
      runId: "run-mig",
      sessionId: null,
      engine: "claude",
      seq: 1,
      kind: "session",
      data: "s-native",
    };
    handleEngineEvents([event], deps());

    const targetKey = sessionKey("claude", "s-native", workspacePath);
    expect(getSessionActivities(draftKey)).toHaveLength(0);
    expect(getSessionActivities(targetKey)).toEqual([
      expect.objectContaining({ kind: "second-brain", value: "off" }),
    ]);
  });

  it("keeps a late result on its own session when the user switched tabs", async () => {
    const workspacePath = freshWorkspace("switch");
    const a = setActive("s-a", workspacePath);
    const bTab: ActiveSession = {
      engine: "claude",
      sessionId: "s-b",
      workspacePath,
    };
    const bKey = sessionKey("claude", "s-b", workspacePath);
    const pending = Promise.withResolvers<SessionControlResult>();
    vi.mocked(ipc.sessionControl).mockReturnValueOnce(pending.promise);

    const applying = useChatStore.getState().applySessionControl({
      operation: "identity",
      value: "reviewer",
      apply: "current",
    });
    // 请求发出后切到另一个会话；旧结果只能落在它自己的会话上。
    useChatStore.setState((s) => ({
      openTabs: [...s.openTabs, bTab],
      bySession: { ...s.bySession, [bKey]: { ...EMPTY_SESSION } },
      active: bTab,
    }));
    pending.resolve(
      result({
        operation: "identity",
        sourceSessionId: "s-a",
        targetSessionId: "s-a",
        state: state({ identity: { base: "reviewer", extensions: [] } }),
      }),
    );
    await applying;

    expect(getSessionActivities(a.key)).toHaveLength(1);
    expect(getSessionActivities(bKey)).toHaveLength(0);
    expect(useChatStore.getState().active?.sessionId).toBe("s-b");
  });

  it("records a clone against the target only", async () => {
    const workspacePath = freshWorkspace("clone");
    const source = setActive("s-source", workspacePath);
    useChatStore.getState().setSessionProxy(source.key, true);
    vi.mocked(ipc.sessionControl).mockResolvedValueOnce(
      result({
        operation: "identity",
        sourceSessionId: "s-source",
        targetSessionId: "s-clone",
        cloned: true,
        state: state({ identity: { base: "reviewer", extensions: [] } }),
      }),
    );

    await useChatStore.getState().applySessionControl({
      operation: "identity",
      value: "reviewer",
      apply: "clone",
    });

    const targetKey = sessionKey("claude", "s-clone", workspacePath);
    expect(getSessionActivities(targetKey)).toEqual([
      expect.objectContaining({ kind: "identity", apply: "clone" }),
    ]);
    expect(getSessionActivities(source.key)).toEqual([
      expect.objectContaining({ kind: "proxy" }),
    ]);
  });

  it("keeps activity records through a history reload", async () => {
    const workspacePath = freshWorkspace("reload");
    const { key } = setActive("s-reload", workspacePath);
    useChatStore.getState().setSessionAutoCompactWindow(key, 180000);
    useChatStore.setState((s) => ({
      bySession: { ...s.bySession, [key]: { ...s.bySession[key], error: "previous lookup failed" } },
    }));
    const history: Message[] = [
      { seq: 1, role: "user", text: "hello", ts: "2026-01-01T00:00:00.000Z" },
    ];
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({
      messages: history,
      nextBefore: null,
      subagentHistory: [],
    });

    await useChatStore.getState().reloadSession(key);

    const messages = useChatStore.getState().bySession[key]?.messages ?? [];
    expect(messages).toEqual(history);
    expect(messages).toHaveLength(1);
    expect(useChatStore.getState().bySession[key]?.error).toBeNull();
    const merged = mergeSessionActivities(messages, getSessionActivities(key));
    expect(merged).toHaveLength(2);
    expect(merged.some((message) => message.seq < 0)).toBe(true);
  });

  it("persists records for a reopened window", async () => {
    const workspacePath = freshWorkspace("persist");
    const { key } = setActive("s-persist", workspacePath);
    useChatStore.getState().setSessionProxy(key, true);
    const recorded = getSessionActivities(key);
    expect(recorded).toHaveLength(1);

    vi.resetModules();
    const fresh = await import("./store/session-activity");

    expect(fresh.getSessionActivities(key)).toEqual(recorded);
  });

  it("does not change the first-send payload or append activity rows to messages", async () => {
    const workspacePath = freshWorkspace("send");
    const { key } = setActive(null, workspacePath);
    useChatStore.getState().setSessionProxy(key, true);
    useChatStore.getState().setSessionSecondBrain(key, false);
    useChatStore.getState().setSessionAutoCompactWindow(key, 180000);

    const ok = await useChatStore.getState().send("hello", []);

    expect(ok).toBe(true);
    const payload = vi.mocked(ipc.sendMessage).mock.calls[0][0];
    expect(payload).toMatchObject({
      prompt: "hello",
      proxyEnabled: true,
      secondBrainEnabled: false,
      autoCompactWindow: 180000,
    });
    expect("activities" in payload).toBe(false);
    expect("sessionActivity" in payload).toBe(false);
    const messages = useChatStore.getState().bySession[key]?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(getSessionActivities(key)).toHaveLength(3);
  });
});

describe("session activity timeline merge", () => {
  const message = (seq: number, role: string, ts: string): Message => ({
    seq,
    role,
    text: `m${seq}`,
    ts,
  });

  const activity = (
    id: string,
    at: string,
    overrides: Partial<SessionActivity> = {},
  ): SessionActivity => ({
    id,
    kind: "proxy",
    status: "success",
    value: "on",
    at: Date.parse(at),
    ...overrides,
  });

  it("inserts an activity between messages without reordering real rows", () => {
    const messages = [
      message(1, "user", "2026-01-01T00:00:00.000Z"),
      message(2, "assistant", "2026-01-01T00:10:00.000Z"),
    ];
    const merged = mergeSessionActivities(messages, [
      activity("a1", "2026-01-01T00:05:00.000Z"),
    ]);

    expect(merged.map((row) => row.seq)).toEqual([1, -1, 2]);
    expect(merged[0]).toBe(messages[0]);
    expect(merged[2]).toBe(messages[1]);
    expect(messages).toHaveLength(2);
  });

  it("keeps an activity older than the loaded page at the top, not the tail", () => {
    const messages = [message(1, "user", "2026-01-01T00:10:00.000Z")];
    const merged = mergeSessionActivities(messages, [
      activity("old", "2026-01-01T00:00:00.000Z"),
    ]);

    expect(merged.map((row) => row.seq)).toEqual([-1, 1]);
  });

  it("更早历史未加载时不显示旧活动，加载后恢复原位置", () => {
    const messages = [message(2, "user", "2026-01-01T00:10:00.000Z")];
    const activities = [activity("old", "2026-01-01T00:05:00.000Z")];
    expect(mergeSessionActivities(messages, activities, true)).toEqual(messages);
    const older = message(1, "user", "2026-01-01T00:00:00.000Z");
    const all = mergeSessionActivities([older, ...messages], activities, false);
    expect(all.map((row) => row.seq)).toEqual([1, -1, 2]);
  });

  it("同一毫秒的记录按提交顺序排列，流式更新复用活动行", () => {
    const activities = [
      activity("z-first", "2026-01-01T00:05:00.000Z"),
      activity("a-second", "2026-01-01T00:05:00.000Z"),
    ];
    const first = mergeSessionActivities([], activities);
    const next = mergeSessionActivities([
      message(1, "assistant", "2026-01-01T00:10:00.000Z"),
    ], activities);
    expect(first.map((row) => (row as Message & { sessionActivity: SessionActivity }).sessionActivity.id))
      .toEqual(["z-first", "a-second"]);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
  });

  it("appends activities newer than every loaded message at the tail", () => {
    const messages = [message(1, "user", "2026-01-01T00:00:00.000Z")];
    const merged = mergeSessionActivities(messages, [
      activity("new", "2026-01-01T01:00:00.000Z"),
    ]);

    expect(merged.map((row) => row.seq)).toEqual([1, -1]);
  });
});
