import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEventPayload } from "@/lib/events";
import { ipc } from "@/lib/ipc";
import { sessionKey, useChatStore } from "./store";
import { EMPTY_SESSION } from "./store/stream";

/** Captured by the mocked listener so a test can settle a turn the way the
 *  backend does: through the store's real wiring, queue drain included. */
let deliver: ((events: EngineEventPayload[]) => void) | null = null;

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listWorkspaces: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    listEngines: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ runId: `queued-run-${++runCounter}`, sessionId: null })),
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
    interruptSession: vi.fn(async () => true),
    rememberSessionModel: vi.fn(async () => {}),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
    getCliConfig: vi.fn(async () => ({})),
  },
}));

vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(
    async (cb: (events: EngineEventPayload[]) => void) => {
      deliver = cb;
      return () => {};
    },
  ),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));

const WS = "/tmp/ws";
const KEY = sessionKey("claude", "s-1", WS);
const TAB = { engine: "claude", sessionId: "s-1", workspacePath: WS };
let runCounter = 0;
let runId: string;

/** 发送前会异步读取会话状态，等待预检完成后再检查队列。 */
async function settle(kind: "done" | "error", interrupted = false) {
  useChatStore.setState((s) => ({
    bySession: {
      ...s.bySession,
      [KEY]: { ...s.bySession[KEY], interrupted },
    },
  }));
  deliver?.([
    {
      runId,
      sessionId: "s-1",
      engine: "claude",
      seq: 9,
      kind,
      data: kind === "done" ? { usage: null } : "400 upstream rejected the request",
    },
  ]);
  await vi.waitFor(() => expect(useChatStore.getState().controlBusyByKey[KEY]).toBeUndefined());
}

function queueOf(key = KEY) {
  return useChatStore.getState().bySession[key]?.queue ?? [];
}

describe("queued messages after a turn settles", () => {
  // The store wires `drainQueue` into the engine listener once, at init.
  beforeAll(async () => {
    await useChatStore.getState().init();
  });

  beforeEach(() => {
    runId = `queue-run-${++runCounter}`;
    vi.clearAllMocks();
    localStorage.clear();
    useChatStore.setState({
      active: TAB,
      activeEngine: "claude",
      openTabs: [TAB],
      models: { claude: "claude-sonnet-4" },
      streamingByKey: {},
      controlBusyByKey: {},
      controlBusy: false,
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          streaming: true,
          turnStartedAt: Date.now(),
          messages: [{ seq: 1, role: "user", text: "hi", ts: null }],
          queue: [{ id: "q-1", text: "继续", images: [], queuedAt: 0 }],
        },
      },
    });
  });

  it("sends the oldest queued message when the turn ends", async () => {
    await settle("done");

    expect(deliver, "engine listener registered").not.toBeNull();
    expect(ipc.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "继续" }),
    );
    expect(queueOf()).toHaveLength(0);
  });

  /** The reported bug: a turn that dies with an engine error is still over, so
   *  the messages typed behind it must go out instead of parking forever. */
  it("sends the oldest queued message when the turn fails", async () => {
    await settle("error");

    expect(deliver, "engine listener registered").not.toBeNull();
    expect(ipc.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "继续" }),
    );
    expect(queueOf()).toHaveLength(0);
  });

  it.each([false, true])("状态读取结束后遵守中断状态 %s", async (interrupted) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof ipc.sessionControl>>>();
    vi.mocked(ipc.sessionControl).mockReturnValueOnce(pending.promise);
    const reading = useChatStore.getState().refreshSessionControl();
    await vi.waitFor(() => expect(ipc.sessionControl).toHaveBeenCalledTimes(1));
    useChatStore.setState((s) => ({ bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], interrupted } } }));
    deliver?.([{ runId, sessionId: "s-1", engine: "claude", seq: 9, kind: "done", data: { usage: null } }]);
    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(queueOf()).toHaveLength(1);
    pending.resolve({
      type: "result", operation: "catalog", schemaVersion: 1,
      sourceSessionId: "s-1", targetSessionId: null, session_id: "s-1",
      cloned: false, is_error: false, subtype: "success", error_code: null,
      revision: "r1", state: null,
    });
    await reading;
    if (interrupted) {
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(queueOf()).toHaveLength(1);
    } else {
      await vi.waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "继续" })));
      expect(queueOf()).toHaveLength(0);
    }
  });

  it("keeps the queue parked when the user stopped the turn", async () => {
    await settle("error", true);

    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(queueOf()).toHaveLength(1);
  });

  /** Jumping the queue: the chosen row goes first, and the turn in flight is
   *  stopped because an engine takes one prompt at a time. */
  it("sends the chosen row now and stops the running turn", async () => {
    useChatStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [KEY]: {
          ...s.bySession[KEY],
          queue: [
            { id: "q-1", text: "继续", images: [], queuedAt: 0 },
            { id: "q-2", text: "再看一遍", images: [], queuedAt: 1 },
          ],
        },
      },
    }));

    await useChatStore.getState().sendQueuedNow("q-2");

    expect(ipc.interruptSession).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(ipc.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "再看一遍" }),
      ),
    );
    expect(queueOf().map((item) => item.text)).toEqual(["继续"]);
  });

  it("sends without stopping when no turn is running", async () => {
    useChatStore.setState((s) => ({
      bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], streaming: false } },
    }));

    await useChatStore.getState().sendQueuedNow("q-1");

    expect(ipc.interruptSession).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(ipc.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "继续" }),
      ),
    );
  });

  /** A send that never becomes a turn reports no engine event, so the queue
   *  has to keep moving on its own or the rest waits forever. */
  it("keeps draining when the send itself fails", async () => {
    vi.mocked(ipc.sendMessage).mockRejectedValueOnce(new Error("spawn failed"));
    useChatStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [KEY]: {
          ...s.bySession[KEY],
          queue: [
            { id: "q-1", text: "继续", images: [], queuedAt: 0 },
            { id: "q-2", text: "再看一遍", images: [], queuedAt: 1 },
          ],
        },
      },
    }));

    await settle("error");

    await vi.waitFor(() =>
      expect(ipc.sendMessage).toHaveBeenCalledTimes(2),
    );
    expect(ipc.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: "再看一遍" }),
    );
    expect(queueOf()).toHaveLength(0);
  });
});
