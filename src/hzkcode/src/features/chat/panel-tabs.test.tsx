import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panelTabRegistry } from "@ccgui/plugin-sdk";
import { ChatSidePanel } from "./ChatSidePanel";
import type { ActiveSession } from "./store";
// Side-effect import: registers the builtin files/changes tabs (their panel
// components are mocked below so no IPC runs under jsdom).
import "./panel-tabs";

vi.mock("@/features/files/FilesPanel", () => ({
  FilesPanel: () => <div>files-panel-stub</div>,
}));
vi.mock("@/features/git/ChangesPanel", () => ({
  ChangesPanel: () => <div>changes-panel-stub</div>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const active: ActiveSession = {
  engine: "dsh",
  sessionId: null,
  workspacePath: "/tmp/ws",
};

describe("panel tabs registry integration (plan §4.2 #4)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(panelTab: string) {
    act(() => {
      root.render(
        <ChatSidePanel
          active={active}
          panelRef={{ current: null }}
          panelWidth={300}
          panelCollapsed={false}
          dragging={null}
          panelTab={panelTab}
          onResizeStart={() => {}}
        />,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a registered plugin tab's component; disposer removes it", () => {
    const dispose = panelTabRegistry.register({
      id: "plugin:demo:extra",
      label: () => "Extra",
      component: () => <div>plugin-panel-marker</div>,
    });
    render("plugin:demo:extra");
    // The plugin panel renders, and the builtin files panel stays mounted
    // (hidden) so tree state survives tab switches.
    expect(container.textContent).toContain("plugin-panel-marker");
    expect(container.textContent).toContain("files-panel-stub");
    act(() => dispose());
    expect(container.textContent).not.toContain("plugin-panel-marker");
    expect(container.textContent).toContain("files-panel-stub");
  });

  it("a crashing plugin tab is contained by PluginBoundary", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dispose = panelTabRegistry.register({
      id: "plugin:demo:crasher",
      label: () => "Crasher",
      component: () => {
        throw new Error("boom");
      },
    });
    render("plugin:demo:crasher");
    // The boundary swallows the crash; the host's other panels are intact.
    expect(container.textContent).toContain("files-panel-stub");
    act(() => dispose());
    vi.restoreAllMocks();
  });
});
