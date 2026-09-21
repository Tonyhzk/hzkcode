import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable knob: which window this test "is".
const env = vi.hoisted(() => ({ label: "main" }));

vi.mock("./ipc", () => ({ ipc: {} }));
vi.mock("./transport", () => ({ isWeb: false }));
vi.mock("./window-context", () => ({ windowLabel: () => env.label }));

import { claimMovedOutEditorTab, rememberEditorTabMovedOut } from "./window-actions";

describe("moved-out editor tabs", () => {
  beforeEach(() => {
    env.label = "main";
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("lets the source window claim its tab back", () => {
    rememberEditorTabMovedOut("/tmp/a.ts");
    expect(claimMovedOutEditorTab("/tmp/a.ts")).toBe(true);
  });

  it("keeps other windows from claiming the tab", () => {
    rememberEditorTabMovedOut("/tmp/a.ts");
    env.label = "chat-1";
    expect(claimMovedOutEditorTab("/tmp/a.ts")).toBe(false);
    // The close event reaches every window in no particular order; a
    // non-owner pass must not consume the record the owner still needs.
    env.label = "main";
    expect(claimMovedOutEditorTab("/tmp/a.ts")).toBe(true);
  });

  it("consumes the record so a file is claimed once", () => {
    rememberEditorTabMovedOut("/tmp/a.ts");
    expect(claimMovedOutEditorTab("/tmp/a.ts")).toBe(true);
    expect(claimMovedOutEditorTab("/tmp/a.ts")).toBe(false);
  });

  it("returns false when nothing was moved out", () => {
    expect(claimMovedOutEditorTab("/tmp/b.ts")).toBe(false);
  });
});
