import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { interruptActiveRun } from "./use-chat-page-effects";
import { sessionKey, useChatStore } from "./store";
import { EMPTY_SESSION } from "./store/stream";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    interruptSession: vi.fn(async () => true),
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
    getAppSettings: vi.fn(async () => ({})),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenSettingsChanged: vi.fn(async () => () => {}),
}));

const WS = "/tmp/ws";

function seed(streaming: boolean) {
  const key = sessionKey("claude", "sess-1", WS);
  useChatStore.setState({
    active: { engine: "claude", sessionId: "sess-1", workspacePath: WS },
    openTabs: [],
    bySession: { [key]: { ...EMPTY_SESSION, streaming } },
  });
  return key;
}

describe("interruptActiveRun", () => {
  beforeEach(() => {
    vi.mocked(ipc.interruptSession).mockClear();
    useChatStore.setState({ active: null, openTabs: [], bySession: {} });
  });

  it("stops the active run while it is streaming", async () => {
    const key = seed(true);
    interruptActiveRun();
    await vi.waitFor(() =>
      expect(vi.mocked(ipc.interruptSession)).toHaveBeenCalledWith("sess-1"),
    );
    expect(useChatStore.getState().bySession[key]?.interrupted).toBe(true);
  });

  it("does nothing when the session is idle", async () => {
    const key = seed(false);
    interruptActiveRun();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(ipc.interruptSession)).not.toHaveBeenCalled();
    expect(useChatStore.getState().bySession[key]?.interrupted).toBe(false);
  });

  it("does nothing without an active session", async () => {
    interruptActiveRun();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(ipc.interruptSession)).not.toHaveBeenCalled();
  });
});
