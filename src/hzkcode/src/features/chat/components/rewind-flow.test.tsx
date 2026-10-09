import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { ipc, type Message } from "@/lib/ipc";
import { useChatStore } from "../store";
import {
  compactedKeys,
  handleEngineEvents,
  settledRuns,
  type EngineEventDeps,
} from "../store/engine-events";
import { EMPTY_SESSION, lastRowIndexByUuid, pendingRewindByRun, runRouting, runsWithContent } from "../store/stream";
import { MessageRow } from "./MessageTimeline";
import { RewindDialog } from "./RewindDialog";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async () => ({ runId: "run-1", sessionId: null })),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    rememberSessionModel: vi.fn(async () => {}),
    rememberSessionEffort: vi.fn(async () => {}),
    rememberSessionProvider: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    rescanSessions: vi.fn(async () => {}),
    usageRecord: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => "ok"),
    sessionFileHistoryAvailable: vi.fn(async () => true),
    sessionRewindableUuids: vi.fn(async () => null),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const WS = "/ws";
const SID = "s-1";
const KEY = `claude/${SID}`;
const ANCHORS_KEY = "hzkcode.rewindAnchors:v1";

function msg(role: string, text: string, uuid?: string): Message {
  return { seq: 0, role, text, ts: null, uuid };
}

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
    refreshSessionUuids: (key) => useChatStore.getState().refreshSessionUuids(key),
    refreshRewindable: (key) => useChatStore.getState().refreshRewindable(key),
  };
}

function readAnchors(): Record<string, string> {
  const raw = localStorage.getItem(ANCHORS_KEY);
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

describe("lastRowIndexByUuid", () => {
  it("finds the LAST row of an entry's uuid", () => {
    const rows = [msg("user", "q", "u1"), msg("assistant", "t", "a1"), msg("tool", "x", "a1")];
    expect(lastRowIndexByUuid(rows, "a1")).toBe(2);
    expect(lastRowIndexByUuid(rows, "u1")).toBe(0);
    expect(lastRowIndexByUuid(rows, "nope")).toBe(-1);
  });
});

describe("a rewinded send", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    pendingRewindByRun.clear();
    runsWithContent.clear();
    // Per-run bookkeeping would otherwise survive between cases (a settled
    // run-1 from one case makes the next case's events no-ops).
    settledRuns.clear();
    runRouting.clear();
    compactedKeys.clear();
    useChatStore.setState({
      openTabs: [],
      active: null,
      unseen: {},
      sessions: [],
      models: {},
      channelDefaults: {},
      providers: {},
      bySession: {},
      streamingByKey: {},
    });
  });

  it("carries the anchor, trims the in-memory tail, and keeps the anchor until settle", async () => {
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [
            msg("user", "第一问", "u1"),
            msg("assistant", "第一答", "a1"),
            msg("user", "被撤回", "u2"),
            msg("assistant", "被撤答", "a2"),
          ],
        },
      },
    });
    act(() => {
      useChatStore.getState().setRewindAnchor(KEY, "u1");
    });
    expect(readAnchors()).toEqual({ [KEY]: "u1" });

    await useChatStore.getState().send("继续", []);

    expect(vi.mocked(ipc.sendMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ rewindTo: "u1" }),
    );
    const state = useChatStore.getState().bySession[KEY]!;
    expect(state.messages.some((m) => m.uuid === "u2" || m.uuid === "a2")).toBe(false);
    expect(state.messages[state.messages.length - 1]?.text).toBe("继续");
    // Display anchor gone (the list itself is the range); the persisted
    // anchor stays until the run settles.
    expect(state.rewindAnchor).toBeNull();
    expect(readAnchors()).toEqual({ [KEY]: "u1" });
  });

  it("spends the persisted anchor when the run settles", async () => {
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: { [KEY]: { ...EMPTY_SESSION, messages: [msg("user", "一问", "u1"), msg("user", "二问", "u2")] } },
    });
    act(() => {
      useChatStore.getState().setRewindAnchor(KEY, "u1");
    });
    await useChatStore.getState().send("继续", []);
    handleEngineEvents(
      [{ runId: "run-1", sessionId: SID, engine: "claude", seq: 1, kind: "done", data: { usage: null } }],
      deps(),
    );
    expect(readAnchors()).toEqual({});
  });

  it("keeps the anchor for the retry when the CLI fails before producing anything", async () => {
    // A failed resume (the CLI exits before its main loop runs) writes no
    // new chain: the error must not spend the anchor, and the retry still
    // carries the rewind uuid.
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: { [KEY]: { ...EMPTY_SESSION, messages: [msg("user", "一问", "u1"), msg("user", "二问", "u2")] } },
    });
    act(() => {
      useChatStore.getState().setRewindAnchor(KEY, "u1");
    });
    await useChatStore.getState().send("继续", []);
    handleEngineEvents(
      [
        {
          runId: "run-1",
          sessionId: SID,
          engine: "claude",
          seq: 1,
          kind: "error",
          data: "对话加载失败",
        },
      ],
      deps(),
    );
    expect(useChatStore.getState().bySession[KEY]?.error).toBe(
      "对话加载失败",
    );
    expect(readAnchors()).toEqual({ [KEY]: "u1" });
    // The finished run's provisional registration is gone (it must not pile
    // up across retries), while the persisted anchor survives.
    expect(pendingRewindByRun.has("run-1")).toBe(false);
    // The withdrawn tail stays gone in memory, and the retry resends the
    // prompt whose send failed (not the surviving prompt behind it) while
    // still carrying the rewind uuid.
    expect(
      useChatStore.getState().bySession[KEY]?.messages.some((m) => m.text === "二问"),
    ).toBe(false);
    await useChatStore.getState().resendLastUser(KEY);
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ rewindTo: "u1", prompt: "继续" }),
    );
  });

  it("drops the anchor when the CLI rejects it as unresolvable", async () => {
    // 「未找到 message.uuid 为 …」 means the point is not in the chain the
    // CLI will load (e.g. an unanswered tail prompt after a failed turn):
    // keeping it would fail every retry forever, so the anchor is spent and
    // the next send goes through as a plain resume.
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: { [KEY]: { ...EMPTY_SESSION, messages: [msg("user", "一问", "u1"), msg("user", "二问", "u2")] } },
    });
    act(() => {
      useChatStore.getState().setRewindAnchor(KEY, "u1");
    });
    await useChatStore.getState().send("继续", []);
    handleEngineEvents(
      [
        {
          runId: "run-1",
          sessionId: SID,
          engine: "claude",
          seq: 1,
          kind: "error",
          data: "未找到 message.uuid 为 u1 的消息",
        },
      ],
      deps(),
    );
    expect(readAnchors()).toEqual({});
    await useChatStore.getState().resendLastUser(KEY);
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ rewindTo: null, prompt: "继续" }),
    );
  });

  it("after an edit's resumable refresh a stale anchor no longer rides the next send", async () => {
    // The edit-save flow refreshes the resumable set (ChatConversation →
    // refreshRewindable); when the anchor is outside the engine's true set
    // it is dropped, so a prompt continue/retry afterwards must send
    // without `--resume-session-at`.
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: { [KEY]: { ...EMPTY_SESSION, messages: [msg("user", "一问", "u1"), msg("user", "二问", "u2")] } },
    });
    act(() => {
      useChatStore.getState().setRewindAnchor(KEY, "u1");
    });
    vi.mocked(ipc.sessionRewindableUuids).mockResolvedValueOnce(["u2"]);
    await useChatStore.getState().refreshRewindable(KEY);
    expect(readAnchors()).toEqual({});
    await useChatStore.getState().send("继续", []);
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ rewindTo: null }),
    );
  });

  it("retry rewinds to the node before the last prompt and re-asks it", async () => {
    // 普通末轮「重试」= 撤回该轮后重问：锚点=该提问之前的最后一个可定位
    // 节点（不含提问本身），重发的提问成为该轮唯一的一份，旧回复不在
    // 截断后的链上。
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [
            msg("user", "一问", "u1"),
            msg("assistant", "答一", "a1"),
            msg("user", "二问", "u2"),
            msg("assistant", "答二", "a2"),
          ],
        },
      },
    });
    await useChatStore.getState().retryLastTurn(KEY);
    expect(readAnchors()).toEqual({ [KEY]: "a1" });
    // 内存侧同步截断：发送时按锚点裁掉旧回合（旧回复不会再出现在时间线，
    // 只保留锚点之前的「一问/答一」与刚重发的「二问」）。
    const msgs = useChatStore.getState().bySession[KEY]?.messages ?? [];
    expect(msgs.some((m) => m.text === "答二")).toBe(false);
    expect(msgs.some((m) => m.text === "答一")).toBe(true);
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ rewindTo: "a1", prompt: "二问" }),
    );
  });

  it("retry still rewinds when the last prompt has no uuid yet", async () => {
    // 回合刚 settle、uuid 回填（400ms 定时器）之前的窗口内点重试：提问行
    // 还是本地回显（无 uuid），锚点仍必须落在其前方的节点上，否则就会
    // 退化成「再发一遍」——正是用户报告的现象。
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [
            msg("user", "一问", "u1"),
            msg("assistant", "答一", "a1"),
            msg("user", "二问"),
            msg("assistant", "答二", "a2"),
          ],
        },
      },
    });
    await useChatStore.getState().retryLastTurn(KEY);
    expect(readAnchors()).toEqual({ [KEY]: "a1" });
    const msgs = useChatStore.getState().bySession[KEY]?.messages ?? [];
    expect(msgs.some((m) => m.text === "答二")).toBe(false);
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ rewindTo: "a1", prompt: "二问" }),
    );
  });

  it("retry of a session's first prompt starts a fresh session", async () => {
    // 首条提问没有可截断的前置节点（`--resume-session-at` 无法表达
    // 「截断到空」）：改用新会话重问，避免同一转录里留下两份相同提问。
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [msg("user", "首问", "u1"), msg("assistant", "首答", "a1")],
        },
      },
    });
    await useChatStore.getState().retryLastTurn(KEY);
    // 新会话承接这次重问；旧会话不留待回退点。
    expect(readAnchors()).toEqual({});
    expect(useChatStore.getState().active?.sessionId).toBeNull();
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: "首问" }),
    );
  });

  it("spends the anchor once the run produced output before an error", async () => {
    // The CLI persists the user message before entering its query loop
    // (QueryEngine), so any content event proves the new chain was written:
    // the error settles the rewind like done does.
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: { [KEY]: { ...EMPTY_SESSION, messages: [msg("user", "一问", "u1"), msg("user", "二问", "u2")] } },
    });
    act(() => {
      useChatStore.getState().setRewindAnchor(KEY, "u1");
    });
    await useChatStore.getState().send("继续", []);
    handleEngineEvents(
      [
        { runId: "run-1", sessionId: SID, engine: "claude", seq: 1, kind: "delta", data: "半个回答" },
        { runId: "run-1", sessionId: SID, engine: "claude", seq: 2, kind: "error", data: "boom" },
      ],
      deps(),
    );
    expect(useChatStore.getState().bySession[KEY]?.error).toBe("boom");
    expect(readAnchors()).toEqual({});
  });

  it("withdraws rewind entries and a staged anchor when the session compacts", async () => {
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [msg("user", "一问", "u1"), msg("assistant", "一答", "a1")],
        },
      },
    });
    act(() => {
      useChatStore.getState().setRewindAnchor(KEY, "u1");
    });
    handleEngineEvents(
      [
        {
          runId: "run-1",
          sessionId: SID,
          engine: "claude",
          seq: 1,
          kind: "compacted",
          data: null,
        },
      ],
      deps(),
    );
    // Every row predates the new boundary now, and the staged anchor pointed
    // into that history (its run had not been sent yet).
    const messages = useChatStore.getState().bySession[KEY]!.messages;
    expect(messages.every((m) => m.archived === true)).toBe(true);
    expect(readAnchors()).toEqual({});
  });

  it("re-reads the resumable set at settle and restores the kept slice", async () => {
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [msg("user", "保留问", "u1"), msg("user", "压缩后问", "u2")],
        },
      },
    });
    handleEngineEvents(
      [
        {
          runId: "run-1",
          sessionId: SID,
          engine: "claude",
          seq: 1,
          kind: "compacted",
          data: null,
        },
      ],
      deps(),
    );
    expect(
      useChatStore.getState().bySession[KEY]!.messages.every((m) => m.archived === true),
    ).toBe(true);
    // The preserved slice is still resumable: the re-read at settle returns
    // it, and only it.
    vi.mocked(ipc.sessionRewindableUuids).mockResolvedValue(["u1"]);
    handleEngineEvents(
      [
        {
          runId: "run-1",
          sessionId: SID,
          engine: "claude",
          seq: 2,
          kind: "done",
          data: { usage: null },
        },
      ],
      deps(),
    );
    await vi.waitFor(
      () => {
        const messages = useChatStore.getState().bySession[KEY]!.messages;
        expect(messages.find((m) => m.uuid === "u1")?.archived).toBe(false);
        expect(messages.find((m) => m.uuid === "u2")?.archived).toBe(true);
      },
      { timeout: 2000 },
    );
  });

  it("leaves newer rows and anchors alone when a stale read returns", async () => {
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: {
        [KEY]: { ...EMPTY_SESSION, messages: [msg("user", "旧问", "u1")] },
      },
    });
    let resolveQuery: (uuids: string[] | null) => void = () => {};
    vi.mocked(ipc.sessionRewindableUuids).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        }),
    );
    const refreshing = useChatStore.getState().refreshRewindable(KEY);
    // A newer turn lands while the read is in flight, with its own anchor.
    useChatStore.setState((s) => {
      const cur = s.bySession[KEY]!;
      return {
        bySession: {
          ...s.bySession,
          [KEY]: { ...cur, messages: [...cur.messages, msg("user", "新问", "u9")] },
        },
      };
    });
    act(() => {
      useChatStore.getState().setRewindAnchor(KEY, "u9");
    });
    resolveQuery(["u1"]);
    await refreshing;
    const messages = useChatStore.getState().bySession[KEY]!.messages;
    expect(messages.find((m) => m.uuid === "u1")?.archived).toBe(false);
    // The row that appeared after the read started is not judged by it, and
    // the anchor it staged survives.
    expect(messages.find((m) => m.uuid === "u9")?.archived).toBeUndefined();
    expect(readAnchors()).toEqual({ [KEY]: "u9" });
  });

  it("restores the rewind entry of a kept prompt once its uuid backfills", async () => {
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          // The prompt is still unbound locally: its uuid only lands with the
          // settle-time backfill.
          messages: [{ seq: 1, role: "user", text: "保留问", ts: null }],
        },
      },
    });
    handleEngineEvents(
      [
        {
          runId: "run-1",
          sessionId: SID,
          engine: "claude",
          seq: 1,
          kind: "compacted",
          data: null,
        },
      ],
      deps(),
    );
    expect(useChatStore.getState().bySession[KEY]!.messages[0].archived).toBe(true);
    // The settle-time backfill binds the uuid; the resumable-set re-read runs
    // after it and restores the entry (the prompt sits in the kept slice).
    vi.mocked(ipc.loadSessionPage).mockResolvedValue({
      messages: [{ seq: 0, role: "user", text: "保留问", ts: null, uuid: "u1" }],
      nextBefore: null,
      subagentHistory: [],
    } as never);
    vi.mocked(ipc.sessionRewindableUuids).mockResolvedValue(["u1"]);
    handleEngineEvents(
      [
        {
          runId: "run-1",
          sessionId: SID,
          engine: "claude",
          seq: 2,
          kind: "done",
          data: { usage: null },
        },
      ],
      deps(),
    );
    await vi.waitFor(
      () => {
        const row = useChatStore.getState().bySession[KEY]!.messages[0];
        expect(row.uuid).toBe("u1");
        expect(row.archived).toBe(false);
      },
      { timeout: 2500 },
    );
  });

  it("keeps a next turn's compaction flag while a settled turn's refresh waits", async () => {
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: { [KEY]: { ...EMPTY_SESSION, messages: [msg("user", "一问", "u1")] } },
    });
    vi.mocked(ipc.sessionRewindableUuids).mockResolvedValue(["u1"]);
    handleEngineEvents(
      [
        {
          runId: "run-1",
          sessionId: SID,
          engine: "claude",
          seq: 1,
          kind: "done",
          data: { usage: null },
        },
      ],
      deps(),
    );
    // The next turn compacts before the settled turn's 400ms refresh runs.
    handleEngineEvents(
      [
        {
          runId: "run-2",
          sessionId: SID,
          engine: "claude",
          seq: 1,
          kind: "compacted",
          data: null,
        },
      ],
      deps(),
    );
    expect(compactedKeys.has(KEY)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The first turn's callback has run, but it did not consume the next
    // turn's flag.
    expect(compactedKeys.has(KEY)).toBe(true);
    handleEngineEvents(
      [
        {
          runId: "run-2",
          sessionId: SID,
          engine: "claude",
          seq: 2,
          kind: "done",
          data: { usage: null },
        },
      ],
      deps(),
    );
    // The second turn's own settle consumed it and re-read the set.
    expect(compactedKeys.has(KEY)).toBe(false);
    await vi.waitFor(
      () => {
        expect(vi.mocked(ipc.sessionRewindableUuids)).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000 },
    );
  });

  it("retry in a pending rewind resends the surviving prompt", async () => {
    const tab = { engine: "claude", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [
            msg("user", "第一问", "u1"),
            msg("assistant", "第一答", "a1"),
            msg("user", "被撤回", "u2"),
          ],
        },
      },
    });
    act(() => {
      useChatStore.getState().setRewindAnchor(KEY, "u1");
    });
    await useChatStore.getState().resendLastUser(KEY);
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "第一问" }),
    );
  });

  it("loads older pages until a pending anchor is located on reopen", async () => {
    act(() => {
      useChatStore.getState().setRewindAnchor(KEY, "u1");
    });
    vi.mocked(ipc.loadSessionPage)
      .mockResolvedValueOnce({
        messages: [msg("user", "新问", "u9")],
        nextBefore: 5,
        subagentHistory: [],
      } as never)
      .mockResolvedValueOnce({
        messages: [msg("user", "旧问", "u1")],
        nextBefore: null,
        subagentHistory: [],
      } as never);
    await useChatStore.getState().selectSession("claude", SID, WS);
    const state = useChatStore.getState().bySession[KEY]!;
    expect(state.messages.map((m) => m.uuid)).toEqual(["u1", "u9"]);
    expect(state.rewindAnchor).toBe("u1");
  });
});

describe("rewind affordances", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("hands the row's uuid and role to the rewind callback", async () => {
    const onRewind = vi.fn();
    await act(async () => {
      root.render(
        <MessageRow
          message={{ seq: 2, role: "assistant", text: "done", ts: null, uuid: "a1" }}
          workspacePath="/ws"
          turnFinal
          branchTarget="a1"
          onBranch={() => {}}
          onRewind={onRewind}
        />,
      );
    });
    // [copy, rewind, branch] — the rewind button sits before the branch one.
    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons).toHaveLength(3);
    await act(async () => buttons[1].click());
    expect(onRewind).toHaveBeenCalledWith({ uuid: "a1", role: "assistant" });
  });

  it("hides the rewind affordance on archived rows", async () => {
    // Rows read from a pre-compaction segment cannot be rewound (the CLI's
    // --resume-session-at resolves the active segment only): no button.
    const onRewind = vi.fn();
    await act(async () => {
      root.render(
        <MessageRow
          message={{
            seq: 2,
            role: "assistant",
            text: "done",
            ts: null,
            uuid: "a1",
            archived: true,
          }}
          workspacePath="/ws"
          turnFinal
          branchTarget="a1"
          onBranch={() => {}}
          onRewind={onRewind}
        />,
      );
    });
    // [copy, branch] — the rewind button is gone.
    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons).toHaveLength(2);
  });

  it("offers the file options only when the snapshot probe says so", async () => {
    const onPick = vi.fn();
    vi.mocked(ipc.sessionFileHistoryAvailable).mockResolvedValue(true);
    await act(async () => {
      root.render(
        <RewindDialog
          engine="claude"
          sessionId={SID}
          target={{ uuid: "u1", role: "user" }}
          onPick={onPick}
          onClose={() => {}}
        />,
      );
    });
    const buttons = () => container.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons()).toHaveLength(4); // conversation / files / both / cancel
    await act(async () => buttons()[1].click());
    expect(onPick).toHaveBeenCalledWith("files");
    expect(vi.mocked(ipc.sessionFileHistoryAvailable)).toHaveBeenCalledWith(
      "claude",
      SID,
      "u1",
    );
  });

  it("omits the file options when no snapshot exists", async () => {
    vi.mocked(ipc.sessionFileHistoryAvailable).mockResolvedValue(false);
    await act(async () => {
      root.render(
        <RewindDialog
          engine="claude"
          sessionId={SID}
          target={{ uuid: "u1", role: "user" }}
          onPick={() => {}}
          onClose={() => {}}
        />,
      );
    });
    expect(container.querySelectorAll<HTMLButtonElement>("button")).toHaveLength(2); // conversation / cancel
  });

  it("omits the file options for assistant rows without probing", async () => {
    await act(async () => {
      root.render(
        <RewindDialog
          engine="claude"
          sessionId={SID}
          target={{ uuid: "a1", role: "assistant" }}
          onPick={() => {}}
          onClose={() => {}}
        />,
      );
    });
    expect(container.querySelectorAll<HTMLButtonElement>("button")).toHaveLength(2);
    expect(vi.mocked(ipc.sessionFileHistoryAvailable)).not.toHaveBeenCalled();
  });
});
