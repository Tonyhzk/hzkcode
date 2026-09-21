import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./store";
import { handleEngineEvents, type EngineEventDeps } from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION, runRouting } from "./store/stream";
import type { EngineEventPayload } from "@/lib/events";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    rescanSessions: vi.fn(async () => {}),
    usageRecord: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));

const KEY = sessionKey("claude", "s-notice", "/tmp/ws");
let runCounter = 0;
let runId: string;

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

function ev(kind: EngineEventPayload["kind"], seq: number, data: unknown) {
  return { runId, sessionId: "s-notice", engine: "claude", seq, kind, data };
}

const notice = (seq: number, level: string, text: string) =>
  ev("notice", seq, { level, text });

describe("CLI system notices", () => {
  beforeEach(() => {
    runId = `notice-${++runCounter}`;
    localStorage.clear();
    vi.clearAllMocks();
    runRouting.clear();
    useChatStore.setState({
      openTabs: [],
      active: null,
      unseen: {},
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          streaming: true,
          messages: [{ seq: 1, role: "user", text: "go", ts: null }],
        },
      },
      streamingByKey: { [KEY]: true },
    });
  });

  it("appends the CLI's notice as its own timeline row", () => {
    handleEngineEvents(
      [notice(2, "warning", "[第二大脑] 指导意见：先核对测试覆盖")],
      deps(),
    );

    const s = useChatStore.getState().bySession[KEY]!;
    expect(s.messages.map((m) => [m.role, m.text, m.level])).toEqual([
      ["user", "go", undefined],
      ["notice", "[第二大脑] 指导意见：先核对测试覆盖", "warning"],
    ]);
    // Progress, not failure: the turn keeps running.
    expect(s.streaming).toBe(true);
    expect(s.error).toBeNull();
  });

  it("keeps error-level notices in order with the streamed text around them", async () => {
    handleEngineEvents([ev("delta", 2, "上一段回复")], deps());
    handleEngineEvents([notice(3, "error", "第二大脑调用失败：502")], deps());
    handleEngineEvents([ev("delta", 4, "继续输出")], deps());
    // Deltas ride the buffered flush (~100ms fallback when rAF is idle).
    await new Promise((resolve) => setTimeout(resolve, 150));

    const s = useChatStore.getState().bySession[KEY]!;
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "go"],
      ["assistant", "上一段回复"],
      ["notice", "第二大脑调用失败：502"],
      ["assistant", "继续输出"],
    ]);
    expect(s.messages[2]!.level).toBe("error");
  });

  it("survives the turn settling", () => {
    handleEngineEvents([notice(2, "warning", "个人记忆提示")], deps());
    handleEngineEvents([ev("done", 3, { usage: null })], deps());

    const s = useChatStore.getState().bySession[KEY]!;
    expect(s.streaming).toBe(false);
    expect(s.messages.some((m) => m.role === "notice" && m.text === "个人记忆提示")).toBe(true);
  });

  it("drops a notice with no text", () => {
    handleEngineEvents([notice(2, "warning", "   ")], deps());

    const s = useChatStore.getState().bySession[KEY]!;
    expect(s.messages).toHaveLength(1);
  });
});
