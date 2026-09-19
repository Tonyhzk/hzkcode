import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listWorkspaces: vi.fn(async () => [
      { id: "w1", path: "/ws", name: "ws", lastOpenedAt: 1, sortOrder: null, groupId: null },
    ]),
    listSessions: vi.fn(async () => []),
    listEngines: vi.fn(async () => [
      { id: "claude", available: true, enabled: true, supportsImages: true, permissions: ["auto"] },
    ]),
    getAppSettings: vi.fn(async () => ({})),
    getCliConfig: vi.fn(async () => ({ claude: { providers: {}, current: null } })),
    rescanSessions: vi.fn(async () => {}),
  },
}));

vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));

import { useChatStore } from "./store";

/** Keys written by store/persistence.ts (OPEN_TABS_KEY / active-session key). */
const OPEN_TABS_KEY = "hzkcode.openTabs:v1";
const ACTIVE_SESSION_KEY = "hzkcode.activeSession:v1";

/** Restore path of `init()`: persisted tabs left over from CLI engines that
 *  no longer exist must not come back — a resurrected stale tab would show
 *  the removed engine in the picker and rewrite the engine pref. */
describe("persisted tab restore filters removed engines", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("drops tabs of removed engines, keeps claude tabs and re-targets the active tab", async () => {
    localStorage.setItem(
      OPEN_TABS_KEY,
      JSON.stringify([
        { engine: "codex", sessionId: null, workspacePath: "/ws" },
        { engine: "claude", sessionId: null, workspacePath: "/ws" },
      ]),
    );
    // The persisted active tab points at the removed engine: it must fall
    // back to the first (only) restorable tab instead of activating it.
    localStorage.setItem(
      ACTIVE_SESSION_KEY,
      JSON.stringify({ engine: "codex", sessionId: null, workspacePath: "/ws" }),
    );
    // Stale engine pref from the removed engine; ensureUsableEngine must
    // correct it to the surviving engine. The store's initial state is
    // evaluated at module import — before this test can seed localStorage —
    // so mirror what a launch with that pref on disk would have read.
    localStorage.setItem("hzkcode.enginePref", "codex");
    useChatStore.setState({ activeEngine: "codex" });

    await useChatStore.getState().init();

    const state = useChatStore.getState();
    expect(state.openTabs.map((t) => t.engine)).toEqual(["claude"]);
    expect(state.active?.engine).toBe("claude");
    expect(state.activeEngine).toBe("claude");
    expect(localStorage.getItem("hzkcode.enginePref")).toBe("claude");
  });
});
