import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./store";
import { handleEngineEvents, type EngineEventDeps } from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION } from "./store/stream";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async () => ({ runId: "run-1", sessionId: null })),
    rememberSessionModel: vi.fn(async () => {}),
    rememberSessionEffort: vi.fn(async () => {}),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));

const KEY = sessionKey("claude", "s-1", "/tmp/ws");

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

describe("command catalog and output events", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useChatStore.setState({
      openTabs: [],
      active: null,
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [{ seq: 1, role: "user", text: "跑个命令", ts: null }],
        },
      },
      streamingByKey: {},
    });
  });

  it("a commands event stores the announced command names", () => {
    handleEngineEvents(
      [
        {
          runId: "run-1",
          sessionId: "s-1",
          engine: "claude",
          seq: 1,
          kind: "commands" as const,
          data: { commands: ["compact", "cost", "", 42] },
        },
      ],
      deps(),
    );
    expect(useChatStore.getState().bySession[KEY]?.availableCommands).toEqual([
      "compact",
      "cost",
    ]);
  });

  it("a command_output event appends a settled assistant row", () => {
    handleEngineEvents(
      [
        {
          runId: "run-1",
          sessionId: "s-1",
          engine: "claude",
          seq: 1,
          kind: "command_output" as const,
          data: "Total cost: $0.0000",
        },
      ],
      deps(),
    );
    const messages = useChatStore.getState().bySession[KEY]?.messages ?? [];
    const row = messages[messages.length - 1];
    expect(row.role).toBe("assistant");
    expect(row.text).toBe("Total cost: $0.0000");
    expect(row.live).toBeUndefined();
  });

  it("empty command output is ignored", () => {
    handleEngineEvents(
      [
        {
          runId: "run-1",
          sessionId: "s-1",
          engine: "claude",
          seq: 1,
          kind: "command_output" as const,
          data: "   ",
        },
      ],
      deps(),
    );
    expect(useChatStore.getState().bySession[KEY]?.messages).toHaveLength(1);
  });
});
