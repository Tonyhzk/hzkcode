import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";

// Layout-level regression tests for the four-column workspace: real ChatPage,
// with the heavy leaves (conversation, terminal, status bar, panels, editor)
// stubbed. The editor dock's own tabs/close behavior is covered by
// EditorDock.test.tsx; these tests own the page-level composition — column
// order, width clamps, auto-expand, and dialog routes.
vi.mock("@/features/chat/components/ChatConversation", () => ({
  ChatConversation: () => React.createElement("div", { "data-testid": "conversation" }),
}));
vi.mock("@/features/terminal/TerminalDock", () => ({ TerminalDock: () => null }));
vi.mock("@/components/application/app-status-bar/app-status-bar", () => ({
  AppStatusBar: () => null,
}));
vi.mock("@/features/files/FilesPanel", () => ({ FilesPanel: () => null }));
vi.mock("@/features/git/ChangesPanel", () => ({ ChangesPanel: () => null }));
vi.mock("@/features/files/EditorPane", () => ({
  default: ({ path }: { path: string }) => React.createElement("div", null, "pane:" + path),
}));
vi.mock("@/features/git/DiffView", () => ({
  DiffView: () => React.createElement("div", { "data-testid": "diff" }),
}));
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ipc: new Proxy({}, { get: () => async () => undefined }) };
});

import ChatPage from "@/features/chat/ChatPage";
import { useChatStore } from "@/features/chat/store";
import { useFilesStore } from "@/features/files/store";
import { useGitStore } from "@/features/git/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver; the center row measures with it.
type ROCb = (entries: unknown[]) => void;
class ROStub {
  static instances: ROStub[] = [];
  targets: Element[] = [];
  cb: ROCb;
  constructor(cb: ROCb) {
    this.cb = cb;
    ROStub.instances.push(this);
  }
  observe(t: Element) {
    this.targets.push(t);
  }
  unobserve() {}
  disconnect() {}
}

function makeRect(width: number): DOMRect {
  return {
    width,
    height: 800,
    top: 0,
    left: 0,
    right: width,
    bottom: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

let ROW_WIDTH = 0;
let container: HTMLDivElement;
let root: Root;
const origGBCR = Element.prototype.getBoundingClientRect;
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function findCenterRow(): HTMLElement {
  const el = Array.from(document.querySelectorAll<HTMLElement>("div")).find((d) => {
    const c = typeof d.className === "string" ? d.className : "";
    return (
      c.includes("relative") &&
      c.includes("min-h-0") &&
      c.includes("flex-1") &&
      c.includes("overflow-hidden")
    );
  });
  if (!el) throw new Error("center row not found");
  return el;
}

/** Editor dock root: the tabpanel's grandparent (content column -> dock). */
function dockRoot(): HTMLElement {
  const tabpanel = container.querySelector("#editor-tabpanel");
  if (!tabpanel) throw new Error("editor tabpanel not found");
  return tabpanel.parentElement!.parentElement as HTMLElement;
}

/** File-list panel root, located through its resize separator. */
function panelRoot(): HTMLElement {
  const label = i18n.t("chat.resizePanel");
  const sep = Array.from(document.querySelectorAll<HTMLElement>('[role="separator"]')).find(
    (el) => el.getAttribute("aria-label") === label,
  );
  if (!sep) throw new Error("panel separator not found");
  return sep.parentElement as HTMLElement;
}

/** Push a width through the center row's ResizeObserver. */
function measure(width: number) {
  ROW_WIDTH = width;
  const row = findCenterRow();
  const inst = ROStub.instances.find((i) => i.targets.includes(row));
  if (!inst) throw new Error("center-row ResizeObserver not found");
  act(() => inst.cb([]));
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );
  });
}

function openFile(path: string, dirty = false) {
  useFilesStore.setState({
    openFiles: [path],
    fileStates: {
      [path]: { path, content: null, loading: true, error: null, loadNonce: 0 },
    },
    activeFilePath: path,
    dirtyPaths: dirty ? { [path]: true } : {},
  });
}

function openDiff() {
  useGitStore.setState({
    diffView: { workspacePath: "/ws", target: { file: "/ws/f.ts", staged: false } },
  });
}

beforeEach(() => {
  localStorage.clear();
  ROStub.instances = [];
  ROW_WIDTH = 0;
  vi.stubGlobal("ResizeObserver", ROStub);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
  Element.prototype.getBoundingClientRect = function () {
    const el = this as HTMLElement;
    if (el.dataset && "tabKey" in el.dataset) {
      const all = Array.from(document.querySelectorAll<HTMLElement>("[data-tab-key]"));
      const i = all.indexOf(el);
      return { ...makeRect(100), left: i * 100, right: i * 100 + 100, x: i * 100 } as DOMRect;
    }
    return makeRect(ROW_WIDTH);
  };
  (
    document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
  ).elementFromPoint = (x: number) => {
    const all = Array.from(document.querySelectorAll<HTMLElement>("[data-tab-key]"));
    return all[Math.floor(x / 100)] ?? null;
  };
  useChatStore.setState({
    init: async () => {},
    active: { engine: "claude", sessionId: null, workspacePath: "/ws/demo" },
    sessions: [],
    engines: [],
    workspaces: [],
    actionError: null,
  });
  useGitStore.setState({ refresh: async () => {}, diffView: null });
  useFilesStore.setState({ openFiles: [], fileStates: {}, activeFilePath: null, dirtyPaths: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Element.prototype.getBoundingClientRect = origGBCR;
  vi.unstubAllGlobals();
});

describe("ChatPage four-column layout", () => {
  it("renders conversation, file panel and editor dock in order inside the center row", async () => {
    await mount();
    measure(1600);
    const row = findCenterRow();
    const children = Array.from(row.children) as HTMLElement[];
    expect(children).toHaveLength(3);
    expect(children[0].querySelector('[data-testid="conversation"]')).not.toBeNull();
    expect(children[1]).toBe(panelRoot());
    expect(children[2]).toBe(dockRoot());
    // The conversation column never cedes its space to editor content.
    expect(children[0].querySelector("#editor-tabpanel")).toBeNull();
  });

  it("renders the editor empty state and the dock toggle in the top bar", async () => {
    await mount();
    measure(1600);
    expect(container.textContent).toContain(i18n.t("files.editorEmpty"));
    const toggles = Array.from(document.querySelectorAll("button")).map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(toggles).toContain(i18n.t("chat.hideFileEditor"));
  });

  it("clamps the dock against row width minus chat-min minus panel", async () => {
    localStorage.setItem("hzkcode.panelWidth", "480");
    localStorage.setItem("hzkcode.editorWidth", "720");
    await mount();
    measure(900);
    expect(panelRoot().style.width).toBe("480px");
    expect(dockRoot().style.width).toBe("100px");
    measure(1400);
    expect(dockRoot().style.width).toBe("600px");
    measure(4000);
    expect(dockRoot().style.width).toBe("720px");
  });

  it("clamps the panel first and yields zero dock width when space runs out", async () => {
    localStorage.setItem("hzkcode.panelWidth", "480");
    localStorage.setItem("hzkcode.editorWidth", "720");
    await mount();
    measure(700);
    expect(panelRoot().style.width).toBe("380px");
    expect(dockRoot().style.width).toBe("0px");
  });

  it("opening a file expands a collapsed dock and reclaims space from the panel", async () => {
    localStorage.setItem("hzkcode.panelWidth", "480");
    localStorage.setItem("hzkcode.editorCollapsed", "1");
    await mount();
    measure(740);
    expect(dockRoot().style.width).toBe("0px");
    const path = "/tmp/chatpage-layout.ts";
    await act(async () => {
      openFile(path);
    });
    expect(localStorage.getItem("hzkcode.editorCollapsed")).toBe("0");
    expect(localStorage.getItem("hzkcode.panelCollapsed")).toBe("1");
    expect(panelRoot().style.width).toBe("0px");
    expect(dockRoot().style.width).toBe("420px");
    expect(container.textContent).toContain("pane:" + path);
  });

  it("opening a diff expands a collapsed dock too (regression)", async () => {
    localStorage.setItem("hzkcode.editorCollapsed", "1");
    await mount();
    measure(1600);
    expect(dockRoot().style.width).toBe("0px");
    await act(async () => {
      openDiff();
    });
    expect(localStorage.getItem("hzkcode.editorCollapsed")).toBe("0");
    expect(dockRoot().style.width).toBe("420px");
    expect(container.querySelector('[data-testid="diff"]')).not.toBeNull();
  });

  it("switching to another diff while collapsed expands the dock (regression)", async () => {
    await mount();
    measure(1600);
    await act(async () => {
      openDiff();
    });
    expect(dockRoot().style.width).toBe("420px");
    // The user collapses the dock, then clicks another changed file — the
    // diff target swaps inside an already-set diffView.
    const btn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === i18n.t("chat.hideFileEditor"),
    );
    act(() => (btn as HTMLButtonElement).click());
    expect(dockRoot().style.width).toBe("0px");
    await act(async () => {
      useGitStore.setState({
        diffView: { workspacePath: "/ws", target: { file: "/ws/other.ts", staged: false } },
      });
    });
    expect(localStorage.getItem("hzkcode.editorCollapsed")).toBe("0");
    expect(dockRoot().style.width).toBe("420px");
    expect(container.querySelector('[data-testid="diff"]')).not.toBeNull();
  });

  it("the top bar toggle hides the dock and persists the flag", async () => {
    localStorage.setItem("hzkcode.editorWidth", "420");
    await mount();
    measure(1600);
    expect(dockRoot().style.width).toBe("420px");
    const btn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === i18n.t("chat.hideFileEditor"),
    );
    expect(btn).toBeTruthy();
    act(() => (btn as HTMLButtonElement).click());
    expect(dockRoot().style.width).toBe("0px");
    expect(localStorage.getItem("hzkcode.editorCollapsed")).toBe("1");
  });

  it("dragging a dirty file tab to the window edge asks for confirmation instead of moving", async () => {
    await mount();
    measure(1600);
    const path = "/tmp/chatpage-dirty.ts";
    await act(async () => {
      openFile(path, true);
    });
    const tab = Array.from(document.querySelectorAll<HTMLElement>("[data-tab-key]")).find(
      (el) => el.dataset.tabKey === "file:" + path,
    );
    expect(tab).toBeTruthy();
    // HTML5 drag-and-drop: dragstart on the tab, then dragend against the
    // window edge (jsdom needs dataTransfer attached by hand).
    const fireDrag = (type: string, init: MouseEventInit) => {
      const e = new MouseEvent(type, { bubbles: true, ...init });
      Object.defineProperty(e, "dataTransfer", {
        value: {
          effectAllowed: "none",
          dropEffect: "none",
          setData: () => {},
          getData: () => "",
          setDragImage: () => {},
        },
      });
      return e;
    };
    act(() => {
      tab!.dispatchEvent(fireDrag("dragstart", {}));
    });
    act(() => {
      tab!.dispatchEvent(
        fireDrag("dragend", { clientX: window.innerWidth - 2, clientY: 300 }),
      );
    });
    expect(document.body.textContent).toContain(
      i18n.t("files.confirmDragOut", { name: "chatpage-dirty.ts" }),
    );
    // Nothing moves until the dialog is confirmed.
    expect(useFilesStore.getState().openFiles).toEqual([path]);
    expect(useFilesStore.getState().dirtyPaths[path]).toBe(true);
  });

  it("closing a dirty tab shows the confirm dialog; cancel keeps it, confirm closes it", async () => {
    await mount();
    measure(1600);
    const path = "/tmp/chatpage-close.ts";
    await act(async () => {
      openFile(path, true);
    });
    const tab = Array.from(document.querySelectorAll<HTMLElement>("[data-tab-key]")).find(
      (el) => el.dataset.tabKey === "file:" + path,
    );
    expect(tab).toBeTruthy();
    const closeBtn = tab!.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      closeBtn.click();
    });
    expect(document.body.textContent).toContain(
      i18n.t("files.confirmCloseDirty", { name: "chatpage-close.ts" }),
    );
    expect(useFilesStore.getState().openFiles).toEqual([path]);
    const findDialogButton = (label: string) =>
      Array.from(document.body.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").trim() === label,
      );
    await act(async () => {
      (findDialogButton(i18n.t("common.cancel")) as HTMLButtonElement).click();
    });
    expect(useFilesStore.getState().openFiles).toEqual([path]);
    await act(async () => {
      closeBtn.click();
    });
    await act(async () => {
      (findDialogButton(i18n.t("common.confirm")) as HTMLButtonElement).click();
    });
    expect(useFilesStore.getState().openFiles).toEqual([]);
    expect(useFilesStore.getState().dirtyPaths[path]).toBeUndefined();
  });

  it("resizes the editor dock by dragging its separator and persists the width", async () => {
    await mount();
    measure(3000);
    const label = i18n.t("chat.resizeFileEditor");
    const sep = Array.from(document.querySelectorAll<HTMLElement>('[role="separator"]')).find(
      (el) => el.getAttribute("aria-label") === label,
    );
    expect(sep).toBeTruthy();
    const drag = (toX: number) => {
      act(() => {
        sep!.dispatchEvent(
          new MouseEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 1000,
            clientY: 100,
          }),
        );
      });
      act(() => {
        window.dispatchEvent(
          new MouseEvent("pointermove", { bubbles: true, clientX: toX, clientY: 100 }),
        );
      });
      act(() => {
        window.dispatchEvent(
          new MouseEvent("pointerup", { bubbles: true, clientX: toX, clientY: 100 }),
        );
      });
    };
    drag(900);
    expect(localStorage.getItem("hzkcode.editorWidth")).toBe("520");
    expect(dockRoot().style.width).toBe("520px");
    drag(2000);
    expect(localStorage.getItem("hzkcode.editorWidth")).toBe("320");
    expect(dockRoot().style.width).toBe("320px");
    drag(0);
    expect(localStorage.getItem("hzkcode.editorWidth")).toBe("720");
    expect(dockRoot().style.width).toBe("720px");
  });
});
