import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { useGitStore } from "@/features/git/store";
import { EditorDock } from "./EditorDock";
import { useFilesStore } from "./store";

vi.mock("./EditorPane", () => ({
  default: ({ path }: { path: string }) => <div>editor-pane:{path}</div>,
}));
vi.mock("@/features/git/DiffView", () => ({
  DiffView: () => <div>diff-view-stub</div>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom omits scrollIntoView; the strip calls it to keep the active tab visible.
Element.prototype.scrollIntoView ??= () => {};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function fileState(path: string) {
  return { path, content: null, loading: true, error: null, loadNonce: 0 };
}

function resetStores() {
  useFilesStore.setState({
    openFiles: [],
    fileStates: {},
    activeFilePath: null,
    dirtyPaths: {},
  });
  useGitStore.setState({ diffView: null });
}

describe("EditorDock", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function render(onDirtyClose = vi.fn(), onDragOut = vi.fn()) {
    await act(async () => {
      root.render(
        <EditorDock
          width={420}
          collapsed={false}
          dragging={null}
          dockRef={{ current: null }}
          onResizeStart={() => {}}
          onDirtyClose={onDirtyClose}
          onDragOut={onDragOut}
        />,
      );
    });
    return { onDirtyClose, onDragOut };
  }

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    resetStores();
  });

  it("shows the empty state when nothing is open", async () => {
    await render();
    expect(container.textContent).toContain(i18n.t("files.editorEmpty"));
  });

  it("renders a tab per open file, the active pane in front, others mounted hidden", async () => {
    act(() => {
      useFilesStore.setState({
        openFiles: ["/tmp/a.ts", "/tmp/b.ts"],
        fileStates: {
          "/tmp/a.ts": fileState("/tmp/a.ts"),
          "/tmp/b.ts": fileState("/tmp/b.ts"),
        },
        activeFilePath: "/tmp/b.ts",
      });
    });
    await render();
    expect(container.querySelectorAll("[data-tab-key]")).toHaveLength(2);
    // Both panes stay mounted (drafts survive tab switches); the inactive one
    // is hidden, not unmounted.
    expect(container.textContent).toContain("editor-pane:/tmp/b.ts");
    const inactive = container.querySelector(".invisible");
    expect(inactive?.textContent).toContain("editor-pane:/tmp/a.ts");
  });

  it("routes dirty tab closes through onDirtyClose and keeps the tab", async () => {
    act(() => {
      useFilesStore.setState({
        openFiles: ["/tmp/a.ts"],
        fileStates: { "/tmp/a.ts": fileState("/tmp/a.ts") },
        activeFilePath: "/tmp/a.ts",
        dirtyPaths: { "/tmp/a.ts": true },
      });
    });
    const { onDirtyClose } = await render();
    const closeButton = container
      .querySelector('[data-tab-key="file:/tmp/a.ts"]')
      ?.querySelector("button");
    expect(closeButton).not.toBeNull();
    act(() => (closeButton as HTMLButtonElement).click());
    expect(onDirtyClose).toHaveBeenCalledWith("/tmp/a.ts");
    expect(useFilesStore.getState().openFiles).toEqual(["/tmp/a.ts"]);
  });

  it("closes clean tabs directly", async () => {
    act(() => {
      useFilesStore.setState({
        openFiles: ["/tmp/a.ts"],
        fileStates: { "/tmp/a.ts": fileState("/tmp/a.ts") },
        activeFilePath: "/tmp/a.ts",
      });
    });
    await render();
    const closeButton = container
      .querySelector('[data-tab-key="file:/tmp/a.ts"]')
      ?.querySelector("button");
    act(() => (closeButton as HTMLButtonElement).click());
    expect(useFilesStore.getState().openFiles).toEqual([]);
  });
});
