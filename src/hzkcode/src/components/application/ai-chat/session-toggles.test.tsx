import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionControls } from "./session-toggles";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { useChatStore } from "@/features/chat/store";
import { usePendingIdentityStore } from "@/features/agents/pending-identity";
import type {
  SessionControlResult,
  SessionControlState,
} from "@/lib/ipc";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  const t = (key: string) => key;
  return {
    ...actual,
    useTranslation: () => ({ t }),
  };
});

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getAppSettings: vi.fn(async () => ({
      cliEnv: { HZKCODE_PROXY_URL: "http://127.0.0.1:7890" },
    })),
    listAgents: vi.fn(async () => []),
    listBuiltInAgents: vi.fn(async () => ({
      provider: {
        id: "p",
        displayName: "p",
        sourceUrl: "",
        sourceRevision: "",
        license: "",
      },
      divisions: [],
      agents: [],
    })),
  },
}));

vi.mock("@/lib/events", () => ({
  listenSettingsChanged: vi.fn(async () => () => {}),
}));

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/ws";
const SID = "s-1";
const KEY = `claude/${SID}`;
const SID2 = "s-2";
const KEY2 = `claude/${SID2}`;
const ACTIVE_1 = { engine: "claude", sessionId: SID, workspacePath: WS };
const ACTIVE_2 = { engine: "claude", sessionId: SID2, workspacePath: WS };

function state(
  overrides: Partial<SessionControlState> = {},
): SessionControlState {
  return {
    hasConversation: true,
    availableApplyMethods: {
      identity: ["current", "clone", "append"],
      promptMode: ["current", "clone"],
    },
    identity: { base: "simple-internal", extensions: [] },
    promptMode: { effective: "full", override: null, source: "startup" },
    interactionMode: { effective: "default", override: null, source: "startup" },
    apiMode: { effective: "anthropic", override: null, source: "startup" },
    model: { effective: "high", override: null, source: "startup" },
    effort: { effective: null, override: null, source: "startup" },
    permission: { effective: "default", override: null, source: "startup" },
    ...overrides,
  };
}

function result(
  overrides: Partial<SessionControlResult> = {},
): SessionControlResult {
  return {
    type: "result",
    operation: "status",
    schemaVersion: 1,
    sourceSessionId: SID,
    targetSessionId: SID,
    session_id: SID,
    cloned: false,
    is_error: false,
    subtype: "success",
    error_code: null,
    revision: "r1",
    state: state(),
    catalog: {
      identities: [
        {
          id: "simple-internal",
          name: "精简",
          description: "",
          source: "built-in",
          tools: null,
          disallowedTools: [],
          model: null,
          effort: null,
          permissionMode: null,
        },
      ],
      interactionModes: [
        { slug: "default", name: "默认", description: "" },
        { slug: "lead", name: "领队", description: "" },
      ],
    },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

// jsdom 没有 ResizeObserver，也没有真实布局：宽度由测试按容器与测量行分别给出。
type ResizeCallback = (entries: unknown[]) => void;
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  targets: Element[] = [];
  private callback: ResizeCallback;
  constructor(callback: ResizeCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    ResizeObserverStub.instances = ResizeObserverStub.instances.filter(
      (instance) => instance !== this,
    );
  }
  trigger() {
    this.callback([]);
  }
}

let availableWidth = 0;
let naturalWidth = 0;
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

function rect(width: number): DOMRect {
  return {
    width,
    height: 24,
    top: 0,
    left: 0,
    right: width,
    bottom: 24,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

async function measureLayout(available: number, natural: number) {
  availableWidth = available;
  naturalWidth = natural;
  const observer = ResizeObserverStub.instances.find((instance) =>
    instance.targets.some((target) =>
      target.hasAttribute("data-session-controls"),
    ),
  );
  if (!observer) throw new Error("session controls ResizeObserver not found");
  await act(async () => observer.trigger());
  await flush();
}

const ENTRY_IDS = [
  "identity",
  "interaction",
  "prompt",
  "protocol",
  "proxy",
  "second-brain",
  "context",
];

const originalActions = {
  setSessionProxy: useChatStore.getState().setSessionProxy,
  setSessionSecondBrain: useChatStore.getState().setSessionSecondBrain,
  setSessionAutoCompactWindow:
    useChatStore.getState().setSessionAutoCompactWindow,
  refreshSessionControl: useChatStore.getState().refreshSessionControl,
  applySessionControl: useChatStore.getState().applySessionControl,
};

function setStore({
  sessionState = state(),
  sessionControl = true,
  streaming = false,
  controlBusy = false,
  proxyEnabled = null,
  secondBrainEnabled = null,
  autoCompactWindow = null,
}: {
  sessionState?: SessionControlState;
  sessionControl?: boolean;
  streaming?: boolean;
  controlBusy?: boolean;
  proxyEnabled?: boolean | null;
  secondBrainEnabled?: boolean | null;
  autoCompactWindow?: number | null;
} = {}) {
  useChatStore.setState({
    active: ACTIVE_1,
    openTabs: [ACTIVE_1],
    bySession: {
      [KEY]: {
        ...EMPTY_SESSION,
        streaming,
        proxyEnabled,
        secondBrainEnabled,
        autoCompactWindow,
        ...(sessionControl
          ? { sessionControl: result({ state: sessionState }) }
          : {}),
      },
    },
    controlBusy,
    controlBusyByKey: controlBusy ? { [KEY]: true } : {},
  });
}

async function renderControls() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SessionControls />
      </MemoryRouter>,
    );
  });
  // 设置读取等挂起的微任务在渲染后结算，避免测试看到初始空地址。
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function entry(id: string) {
  return container.querySelector(
    `[data-session-control="${id}"]`,
  ) as HTMLElement | null;
}

function requireEntry(id: string) {
  const element = entry(id);
  if (!element) throw new Error(`missing session entry: ${id}`);
  return element;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function activate(element: HTMLElement) {
  // 按下与松开分开发送，让 React 提交失焦导致的更新，而不是把整次按压合并处理。
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    element.focus();
  });
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, button: 0 }),
    );
    element.click();
  });
}

async function openPanel(id: string) {
  await activate(requireEntry(id));
  return document.querySelector('[role="dialog"]') as HTMLElement | null;
}

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  usePendingIdentityStore.setState({ request: null });
  useChatStore.setState({ actionError: null });
  ResizeObserverStub.instances = [];
  availableWidth = 0;
  naturalWidth = 0;
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute("data-session-controls")) return rect(availableWidth);
    if (this.hasAttribute("data-session-controls-measure")) {
      return rect(naturalWidth);
    }
    return originalGetBoundingClientRect.call(this);
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  vi.unstubAllGlobals();
  useChatStore.setState({
    ...originalActions,
    actionError: null,
    controlBusy: false,
    controlBusyByKey: {},
  });
});

describe("会话工具栏入口", () => {
  it("renders seven independent entries", async () => {
    setStore();
    await renderControls();
    const ids = [
      "identity",
      "interaction",
      "prompt",
      "protocol",
      "proxy",
      "second-brain",
      "context",
    ];
    expect(container.querySelectorAll("[data-session-control]")).toHaveLength(7);
    for (const id of ids) {
      expect(entry(id)).not.toBeNull();
    }
  });

  it("opens the shared identity dialog directly", async () => {
    useChatStore.setState({
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await activate(requireEntry("identity"));
    const request = usePendingIdentityStore.getState().request;
    expect(request?.key).toBe(KEY);
    expect(request?.identity.value).toBe("simple-internal");
  });

  it("opens identity before the session state is read", async () => {
    const pending = Promise.withResolvers<SessionControlResult | null>();
    useChatStore.setState({
      refreshSessionControl: vi.fn(() => pending.promise),
    });
    setStore({ sessionControl: false });
    await renderControls();
    await activate(requireEntry("identity"));
    expect(usePendingIdentityStore.getState().request?.identity.value).toBeNull();
    await act(async () => pending.resolve(null));
    await flush();
  });

  it("shows the effective protocol even when the override differs", async () => {
    useChatStore.setState({
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore({
      sessionState: state({
        apiMode: {
          effective: "responses",
          override: "anthropic",
          source: "session",
        },
      }),
    });
    await renderControls();
    const protocol = requireEntry("protocol");
    expect(protocol.getAttribute("data-api-mode")).toBe("responses");
    expect(protocol.getAttribute("data-protocol-state")).toBe("value");
    await activate(protocol);
    const checked = document.querySelector(
      '[data-testid="session-api-mode"] [data-value="anthropic"]',
    );
    expect(checked?.getAttribute("aria-checked")).toBe("true");
  });

  it("exposes the effective chat_completions protocol without a session override", async () => {
    useChatStore.setState({
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore({
      sessionState: state({
        apiMode: {
          effective: "chat_completions",
          override: null,
          source: "startup",
        },
      }),
    });
    await renderControls();
    const protocol = requireEntry("protocol");
    expect(protocol.getAttribute("data-api-mode")).toBe("chat_completions");
    expect(protocol.getAttribute("data-protocol-state")).toBe("value");
  });

  it("shows an honest protocol state when the session state cannot be read", async () => {
    useChatStore.setState({
      refreshSessionControl: vi.fn(async () => null),
    });
    setStore({ sessionControl: false });
    await renderControls();
    await flush();
    const protocol = requireEntry("protocol");
    expect(protocol.getAttribute("data-protocol-state")).toBe("unavailable");
    expect(protocol.hasAttribute("data-api-mode")).toBe(false);
  });

  it("reads the session state once on activation when it is not cached", async () => {
    const refresh = vi.fn(async () => result());
    useChatStore.setState({ refreshSessionControl: refresh });
    setStore({ sessionControl: false });
    await renderControls();
    expect(refresh).toHaveBeenCalledTimes(1);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reads the state only when a control panel opens", async () => {
    const refresh = vi.fn(async () => result());
    useChatStore.setState({ refreshSessionControl: refresh });
    setStore();
    await renderControls();
    expect(refresh).not.toHaveBeenCalled();
    const protocol = requireEntry("protocol");
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await activate(protocol);
      expect(refresh).toHaveBeenCalledTimes(cycle + 1);
      await act(async () => {
        document.querySelector<HTMLElement>('[role="dialog"]')!.focus();
      });
      await activate(protocol);
      expect(refresh).toHaveBeenCalledTimes(cycle + 1);
    }
  });

  it("toggles a panel with one press and swaps between entries", async () => {
    useChatStore.setState({
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    const proxy = requireEntry("proxy");
    await activate(proxy);
    expect(proxy.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      document.querySelector<HTMLElement>('[role="dialog"]')!.focus();
    });
    await activate(proxy);
    expect(proxy.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await activate(proxy);
    expect(proxy.getAttribute("aria-expanded")).toBe("true");
    const behavior = requireEntry("interaction");
    await activate(behavior);
    expect(proxy.getAttribute("aria-expanded")).toBe("false");
    expect(behavior.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("does not write session control while the session runs", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore({ streaming: true });
    await renderControls();
    await openPanel("protocol");
    const responses = document.querySelector(
      '[data-testid="session-api-mode"] [data-value="responses"]',
    )!;
    expect(responses.hasAttribute("disabled")).toBe(true);
    await click(responses);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("会话控制面板", () => {
  it("applies a prompt mode in place when the engine offers no clone method", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () =>
        result({
          state: state({
            availableApplyMethods: {
              identity: ["current", "clone", "append"],
              promptMode: ["current"],
            },
          }),
        }),
      ),
    });
    setStore({
      sessionState: state({
        availableApplyMethods: {
          identity: ["current", "clone", "append"],
          promptMode: ["current"],
        },
      }),
    });
    await renderControls();
    await openPanel("prompt");
    await click(
      document.querySelector(
        '[data-testid="session-prompt-mode"] [data-value="compact"]',
      )!,
    );
    expect(apply).toHaveBeenCalledWith({
      operation: "prompt-mode",
      value: "compact",
      apply: "current",
    });
  });

  it("asks current or clone before applying a prompt mode with history", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await openPanel("prompt");
    await click(
      document.querySelector(
        '[data-testid="session-prompt-mode"] [data-value="compact"]',
      )!,
    );
    expect(apply).not.toHaveBeenCalled();
    const clone = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "chat.sessionPromptModeClone",
    )!;
    await click(clone);
    expect(apply).toHaveBeenCalledWith({
      operation: "prompt-mode",
      value: "compact",
      apply: "clone",
    });
  });

  it("clears the pending prompt after a StrictMode remount", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await act(async () => {
      root.render(
        <StrictMode>
          <MemoryRouter>
            <SessionControls />
          </MemoryRouter>
        </StrictMode>,
      );
    });
    await flush();
    await openPanel("prompt");
    await click(
      document.querySelector(
        '[data-testid="session-prompt-mode"] [data-value="compact"]',
      )!,
    );
    expect(apply).not.toHaveBeenCalled();
    const current = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "chat.sessionPromptModeCurrent",
    )!;
    await click(current);
    expect(apply).toHaveBeenCalledWith({
      operation: "prompt-mode",
      value: "compact",
      apply: "current",
    });
    expect(
      document.querySelector(
        '[data-testid="session-prompt-mode"] [data-value="compact"]',
      ),
    ).not.toBeNull();
    expect(
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "chat.sessionPromptModeCurrent",
      ),
    ).toBe(false);
  });

  it("applies interaction modes and reset with their slugs", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await openPanel("interaction");
    await click(
      document.querySelector(
        '[data-testid="session-interaction-mode"] [data-value="lead"]',
      )!,
    );
    expect(apply).toHaveBeenLastCalledWith({
      operation: "interaction-mode",
      value: "lead",
    });
    await click(
      document.querySelector(
        '[data-testid="session-interaction-mode"] [data-value="reset"]',
      )!,
    );
    expect(apply).toHaveBeenLastCalledWith({
      operation: "interaction-mode",
      value: "reset",
    });
  });

  it("applies API protocols and reset", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await openPanel("protocol");
    await click(
      document.querySelector(
        '[data-testid="session-api-mode"] [data-value="responses"]',
      )!,
    );
    expect(apply).toHaveBeenLastCalledWith({
      operation: "api-mode",
      value: "responses",
    });
    await click(
      document.querySelector(
        '[data-testid="session-api-mode"] [data-value="reset"]',
      )!,
    );
    expect(apply).toHaveBeenLastCalledWith({
      operation: "api-mode",
      value: "reset",
    });
  });

  it("keeps the panel and shows the failure reason when apply fails", async () => {
    const apply = vi.fn(async () => {
      useChatStore.setState({ actionError: "会话仍在运行" });
      return false;
    });
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await openPanel("protocol");
    await click(
      document.querySelector(
        '[data-testid="session-api-mode"] [data-value="responses"]',
      )!,
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("ignores an old failure after switching sessions", async () => {
    const pending = Promise.withResolvers<boolean>();
    useChatStore.setState({
      applySessionControl: vi.fn(() => pending.promise),
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await openPanel("protocol");
    await click(
      document.querySelector(
        '[data-testid="session-api-mode"] [data-value="responses"]',
      )!,
    );
    await act(async () => {
      useChatStore.setState({
        active: ACTIVE_2,
        openTabs: [ACTIVE_2],
        bySession: {
          [KEY2]: {
            ...EMPTY_SESSION,
            sessionControl: result({
              sourceSessionId: SID2,
              targetSessionId: SID2,
            }),
          },
        },
      });
    });
    await act(async () => {
      useChatStore.setState({ actionError: "old error" });
      pending.resolve(false);
    });
    await flush();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("上下文窗口入口", () => {
  it("commits a valid draft when the panel closes", async () => {
    const save = vi.fn();
    useChatStore.setState({
      setSessionAutoCompactWindow: save,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    const context = requireEntry("context");
    await activate(context);
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="chat.sessionContextWindow"]',
    )!;
    await act(async () => {
      input.focus();
      typeInto(input, "123456");
    });
    await activate(context);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(KEY, 123456);
  });

  it("commits a valid draft when an outside press closes the panel", async () => {
    const save = vi.fn();
    useChatStore.setState({
      setSessionAutoCompactWindow: save,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await activate(requireEntry("context"));
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="chat.sessionContextWindow"]',
    )!;
    await act(async () => {
      input.focus();
      typeInto(input, "654321");
    });
    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(KEY, 654321);
  });

  it("discards an invalid draft when the panel closes", async () => {
    const save = vi.fn();
    useChatStore.setState({
      setSessionAutoCompactWindow: save,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    const context = requireEntry("context");
    await activate(context);
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="chat.sessionContextWindow"]',
    )!;
    await act(async () => {
      input.focus();
      typeInto(input, "invalid");
    });
    await activate(context);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not carry a context draft into another session", async () => {
    const save = vi.fn();
    useChatStore.setState({
      setSessionAutoCompactWindow: save,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await activate(requireEntry("context"));
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="chat.sessionContextWindow"]',
    )!;
    await act(async () => {
      input.focus();
      typeInto(input, "123456");
    });
    await act(async () => {
      useChatStore.setState({
        active: ACTIVE_2,
        openTabs: [ACTIVE_2],
        bySession: {
          [KEY2]: {
            ...EMPTY_SESSION,
            sessionControl: result({
              sourceSessionId: SID2,
              targetSessionId: SID2,
            }),
          },
        },
      });
    });
    expect(save).not.toHaveBeenCalled();
    await activate(requireEntry("context"));
    const nextInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="chat.sessionContextWindow"]',
    )!;
    expect(nextInput.value).toBe("");
  });
});

describe("代理与第二大脑入口", () => {
  it("applies a session proxy choice and closes the panel", async () => {
    const setProxy = vi.fn();
    useChatStore.setState({
      setSessionProxy: setProxy,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await openPanel("proxy");
    const on = document.querySelector(
      '[data-testid="session-proxy"] [data-value="true"]',
    )!;
    expect(on.hasAttribute("disabled")).toBe(false);
    await click(on);
    expect(setProxy).toHaveBeenCalledWith(KEY, true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("applies a second-brain choice and closes the panel", async () => {
    const setBrain = vi.fn();
    useChatStore.setState({
      setSessionSecondBrain: setBrain,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await openPanel("second-brain");
    await click(
      document.querySelector(
        '[data-testid="session-second-brain"] [data-value="false"]',
      )!,
    );
    expect(setBrain).toHaveBeenCalledWith(KEY, false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("会话工具栏窄宽度菜单", () => {
  it("collapses to one entry and expands by measured width", async () => {
    useChatStore.setState({
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    expect(container.querySelectorAll("[data-session-control]")).toHaveLength(7);

    await measureLayout(120, 420);
    expect(container.querySelectorAll("[data-session-control]")).toHaveLength(1);
    expect(entry("session-actions")).not.toBeNull();
    for (const id of ENTRY_IDS) {
      expect(entry(id)).toBeNull();
    }

    await measureLayout(600, 420);
    expect(container.querySelectorAll("[data-session-control]")).toHaveLength(7);
    expect(entry("session-actions")).toBeNull();
  });

  it("opens every existing panel from the compact menu and reads the state once", async () => {
    const refresh = vi.fn(async () => result());
    const apply = vi.fn(async () => true);
    const setProxy = vi.fn();
    useChatStore.setState({
      refreshSessionControl: refresh,
      applySessionControl: apply,
      setSessionProxy: setProxy,
    });
    setStore();
    await renderControls();
    await measureLayout(120, 420);
    await openPanel("session-actions");
    expect(refresh).toHaveBeenCalledTimes(1);
    for (const testId of [
      "session-interaction-mode",
      "session-prompt-mode",
      "session-api-mode",
      "session-proxy",
      "session-second-brain",
    ]) {
      expect(document.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
    }
    expect(
      document.querySelector('input[aria-label="chat.sessionContextWindow"]'),
    ).not.toBeNull();

    await click(
      document.querySelector(
        '[data-testid="session-api-mode"] [data-value="responses"]',
      )!,
    );
    expect(apply).toHaveBeenCalledWith({
      operation: "api-mode",
      value: "responses",
    });
    await click(
      document.querySelector(
        '[data-testid="session-proxy"] [data-value="true"]',
      )!,
    );
    expect(setProxy).toHaveBeenCalledWith(KEY, true);
  });

  it("opens the shared identity dialog from the compact row", async () => {
    useChatStore.setState({
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await measureLayout(120, 420);
    await openPanel("session-actions");
    const identity = document.querySelector(
      '[data-session-control="identity"]',
    ) as HTMLElement;
    await activate(identity);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(usePendingIdentityStore.getState().request?.key).toBe(KEY);
    expect(usePendingIdentityStore.getState().request?.identity.value).toBe(
      "simple-internal",
    );
  });

  it("closes an open entry when the row collapses", async () => {
    useChatStore.setState({
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await measureLayout(600, 420);
    await openPanel("protocol");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await measureLayout(120, 420);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelectorAll("[data-session-control]")).toHaveLength(1);
  });

  it("closes the compact menu when the row expands", async () => {
    useChatStore.setState({
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await measureLayout(120, 420);
    await openPanel("session-actions");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await measureLayout(600, 420);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelectorAll("[data-session-control]")).toHaveLength(7);
  });

  it("commits a valid context draft when the compact menu closes", async () => {
    const save = vi.fn();
    useChatStore.setState({
      setSessionAutoCompactWindow: save,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await measureLayout(120, 420);
    await openPanel("session-actions");
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="chat.sessionContextWindow"]',
    )!;
    await act(async () => {
      input.focus();
      typeInto(input, "123456");
    });
    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(KEY, 123456);
  });

  it("commits a valid context draft when the layout switches", async () => {
    const save = vi.fn();
    useChatStore.setState({
      setSessionAutoCompactWindow: save,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await measureLayout(120, 420);
    await openPanel("session-actions");
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="chat.sessionContextWindow"]',
    )!;
    await act(async () => {
      input.focus();
      typeInto(input, "123456");
    });

    await measureLayout(600, 420);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(KEY, 123456);
  });

  it("does not carry a compact context draft into another session", async () => {
    const save = vi.fn();
    useChatStore.setState({
      setSessionAutoCompactWindow: save,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    await renderControls();
    await measureLayout(120, 420);
    await openPanel("session-actions");
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="chat.sessionContextWindow"]',
    )!;
    await act(async () => {
      input.focus();
      typeInto(input, "123456");
    });
    await act(async () => {
      useChatStore.setState({
        active: ACTIVE_2,
        openTabs: [ACTIVE_2],
        bySession: {
          [KEY2]: {
            ...EMPTY_SESSION,
            sessionControl: result({
              sourceSessionId: SID2,
              targetSessionId: SID2,
            }),
          },
        },
      });
    });

    expect(save).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await measureLayout(120, 420);
    await openPanel("session-actions");
    const nextInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="chat.sessionContextWindow"]',
    )!;
    expect(nextInput.value).toBe("");
  });
});
