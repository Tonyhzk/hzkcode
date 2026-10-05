import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { PermissionCard } from "./components/PermissionCard";
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
    answerPermission: vi.fn(async () => {}),
    // The agent store's module-level refresh runs when the chat store (and
    // through it this test's imports) loads its catalog.
    listAgents: vi.fn(async () => []),
    listBuiltInAgents: vi.fn(async () => ({ agents: [], divisions: [] })),
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

function permissionEvent(requestId = "req-1") {
  return {
    runId: "run-1",
    sessionId: "s-1",
    engine: "claude",
    seq: 1,
    kind: "permission" as const,
    data: {
      requestId,
      toolName: "Bash",
      toolUseId: "call_1",
      title: "运行命令",
      input: { command: "rm -rf x" },
    },
  };
}

function settledEvent(requestId = "req-1") {
  return {
    runId: "run-1",
    sessionId: "s-1",
    engine: "claude",
    seq: 2,
    kind: "question_settled" as const,
    data: { requestId },
  };
}

function cardRows() {
  return (useChatStore.getState().bySession[KEY]?.messages ?? []).filter(
    (m) => m.role === "permission",
  );
}

describe("tool-permission ask flow", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useChatStore.setState({
      openTabs: [],
      active: null,
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [{ seq: 1, role: "user", text: "干活", ts: null }],
        },
      },
      streamingByKey: {},
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("a permission event appends one pending card", () => {
    handleEngineEvents([permissionEvent()], deps());
    const rows = cardRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].permission?.status).toBe("pending");
    expect(rows[0].permission?.requestId).toBe("req-1");
    expect(rows[0].permission?.toolName).toBe("Bash");
    expect(rows[0].permission?.title).toBe("运行命令");
    expect(rows[0].permission?.input).toEqual({ command: "rm -rf x" });
  });

  it("replayed frames for the same request id collapse into one card", () => {
    handleEngineEvents([permissionEvent(), permissionEvent()], deps());
    expect(cardRows()).toHaveLength(1);
  });

  it("approving sends allow and flips the card", async () => {
    handleEngineEvents([permissionEvent()], deps());
    const seq = cardRows()[0].seq;
    await useChatStore.getState().respondToPermission(KEY, seq, "allow");
    expect(vi.mocked(ipc.answerPermission)).toHaveBeenCalledWith("run-1", "req-1", "allow");
    expect(cardRows()[0].permission?.status).toBe("allowed");
  });

  it("denying sends deny and flips the card", async () => {
    handleEngineEvents([permissionEvent()], deps());
    const seq = cardRows()[0].seq;
    await useChatStore.getState().respondToPermission(KEY, seq, "deny");
    expect(vi.mocked(ipc.answerPermission)).toHaveBeenCalledWith("run-1", "req-1", "deny");
    expect(cardRows()[0].permission?.status).toBe("denied");
  });

  it("a settled event cancels a pending card", () => {
    handleEngineEvents([permissionEvent()], deps());
    handleEngineEvents([settledEvent()], deps());
    expect(cardRows()[0].permission?.status).toBe("cancelled");
  });

  it("card buttons answer through the store", async () => {
    const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    void i18n.changeLanguage("zh");
    handleEngineEvents([permissionEvent()], deps());
    useChatStore.setState({
      active: { engine: "claude", sessionId: "s-1", workspacePath: "/tmp/ws" },
    });
    const row = cardRows()[0];
    await act(async () => {
      root.render(<PermissionCard message={row} />);
    });
    const allowButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("允许一次"),
    )!;
    await act(async () => {
      allowButton.click();
    });
    expect(vi.mocked(ipc.answerPermission)).toHaveBeenCalledWith("run-1", "req-1", "allow");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
