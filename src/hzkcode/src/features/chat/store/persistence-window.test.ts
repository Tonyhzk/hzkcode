import { afterEach, describe, expect, it, vi } from "vitest";

// Simulate living in an extra (non-main) window; the suffix namespaces every
// tab-persistence key so windows never overwrite each other's state.
vi.mock("@/lib/window-context", () => ({
  windowStorageSuffix: () => ":w:chat-1",
}));

import { OPEN_TABS_KEY, persistTabs, readPersistedTabs } from "./persistence";

describe("window-scoped tab persistence", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("namespaces the tab keys for extra windows", () => {
    expect(OPEN_TABS_KEY).toBe("hzkcode.openTabs:v1:w:chat-1");
  });

  it("round-trips tabs under the scoped key", () => {
    persistTabs(
      [{ engine: "claude", sessionId: "s1", workspacePath: "/tmp/ws" }],
      null,
    );
    expect(localStorage.getItem("hzkcode.openTabs:v1:w:chat-1")).toContain("s1");
    expect(localStorage.getItem("hzkcode.openTabs:v1")).toBeNull();
    expect(readPersistedTabs()).toEqual([
      { engine: "claude", sessionId: "s1", workspacePath: "/tmp/ws" },
    ]);
  });

  it("does not adopt the legacy (main-window) keys", () => {
    localStorage.setItem(
      "hzkcode.openTabs",
      JSON.stringify([{ engine: "claude", sessionId: "legacy", workspacePath: "/tmp/ws" }]),
    );
    expect(readPersistedTabs()).toEqual([]);
    // Untouched: the legacy key still belongs to the main window.
    expect(localStorage.getItem("hzkcode.openTabs")).not.toBeNull();
  });
});
