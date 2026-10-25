import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionToggles } from "./session-toggles";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { useChatStore } from "@/features/chat/store";
import { usePendingIdentityStore } from "@/features/agents/pending-identity";
import type {
  SessionControlResult,
  SessionControlState,
} from "@/lib/ipc";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  const t = (key: string) =>
    key === "chat.sessionIdentityJoin" ? "、" : key;
  return {
    ...actual,
    useTranslation: () => ({ t }),
  };
});

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getAppSettings: vi.fn(async () => ({ cliEnv: {} })),
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

function setStore({
  sessionState = state(),
  streaming = false,
  controlBusy = false,
}: {
  sessionState?: SessionControlState;
  streaming?: boolean;
  controlBusy?: boolean;
} = {}) {
  const active = { engine: "claude", sessionId: SID, workspacePath: WS };
  useChatStore.setState({
    active,
    openTabs: [active],
    bySession: {
      [KEY]: {
        ...EMPTY_SESSION,
        streaming,
        sessionControl: result({ state: sessionState }),
      },
    },
    controlBusy,
    controlBusyByKey: controlBusy ? { [KEY]: true } : {},
  });
}

async function renderMenu() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SessionToggles />
      </MemoryRouter>,
    );
  });
  const trigger = container.querySelector(
    'button[aria-label="chat.sessionToggles"]',
  ) as HTMLButtonElement;
  await click(trigger);
  return document.querySelector('[role="dialog"]') as HTMLElement;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function activate(element: HTMLElement) {
  // 按下与松开分开发送，让 React 提交失焦导致的更新，而不是把整次按压合并处理。
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    element.focus();
  });
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    element.click();
  });
}

function sessionTrigger() {
  return container.querySelector(
    'button[aria-label="chat.sessionToggles"]',
  ) as HTMLButtonElement;
}

async function renderToggle() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SessionToggles />
      </MemoryRouter>,
    );
  });
  return sessionTrigger();
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
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("SessionToggles session control", () => {
  it("applies a prompt mode in place when there is no conversation", async () => {
    const apply = vi.fn(async () => true);
    const refresh = vi.fn(async () =>
      result({ state: state({ hasConversation: false }) }),
    );
    useChatStore.setState({ applySessionControl: apply, refreshSessionControl: refresh });
    setStore({ sessionState: state({ hasConversation: false,
      availableApplyMethods: { identity: ["current"], promptMode: ["current"] },
    }) });
    const dialog = await renderMenu();
    const compact = dialog.querySelector(
      '[data-testid="session-prompt-mode"] [data-value="compact"]',
    )!;
    await click(compact);
    expect(apply).toHaveBeenCalledWith({
      operation: "prompt-mode",
      value: "compact",
      apply: "current",
    });
  });

  it("applies in place when the engine offers no clone method", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () =>
        result({
          state: state({
            hasConversation: true,
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
        hasConversation: true,
        availableApplyMethods: {
          identity: ["current", "clone", "append"],
          promptMode: ["current"],
        },
      }),
    });
    const dialog = await renderMenu();
    await click(
      dialog.querySelector(
        '[data-testid="session-prompt-mode"] [data-value="compact"]',
      )!,
    );
    expect(apply).toHaveBeenCalledWith({
      operation: "prompt-mode",
      value: "compact",
      apply: "current",
    });
  });

  it("asks for a method when clone is offered, even without visible history", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore({ sessionState: state({ hasConversation: false }) });
    const dialog = await renderMenu();
    await click(
      dialog.querySelector(
        '[data-testid="session-prompt-mode"] [data-value="compact"]',
      )!,
    );
    expect(apply).not.toHaveBeenCalled();
    expect(
      [...dialog.querySelectorAll("button")].some(
        (button) => button.textContent === "chat.sessionPromptModeClone",
      ),
    ).toBe(true);
  });

  it("asks current or clone before applying a prompt mode with history", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    const dialog = await renderMenu();
    await click(
      dialog.querySelector(
        '[data-testid="session-prompt-mode"] [data-value="compact"]',
      )!,
    );
    expect(apply).not.toHaveBeenCalled();
    const clone = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent === "chat.sessionPromptModeClone",
    )!;
    await click(clone);
    expect(apply).toHaveBeenCalledWith({
      operation: "prompt-mode",
      value: "compact",
      apply: "clone",
    });
  });

  it("applies interaction modes and reset with their slugs", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    const dialog = await renderMenu();
    await click(
      dialog.querySelector(
        '[data-testid="session-interaction-mode"] [data-value="lead"]',
      )!,
    );
    expect(apply).toHaveBeenLastCalledWith({
      operation: "interaction-mode",
      value: "lead",
    });
    await click(
      dialog.querySelector(
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
    const dialog = await renderMenu();
    await click(
      dialog.querySelector(
        '[data-testid="session-api-mode"] [data-value="responses"]',
      )!,
    );
    expect(apply).toHaveBeenLastCalledWith({
      operation: "api-mode",
      value: "responses",
    });
    await click(
      dialog.querySelector(
        '[data-testid="session-api-mode"] [data-value="reset"]',
      )!,
    );
    expect(apply).toHaveBeenLastCalledWith({
      operation: "api-mode",
      value: "reset",
    });
  });

  it("disables modifications while the session runs or control is busy", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore({ streaming: true });
    const dialog = await renderMenu();
    for (const element of dialog.querySelectorAll("[data-value]")) {
      expect(element.hasAttribute("disabled")).toBe(true);
    }
    expect(
      dialog.querySelector('[data-testid="session-identity-open"]')!.hasAttribute("disabled"),
    ).toBe(true);
    await click(
      dialog.querySelector(
        '[data-testid="session-api-mode"] [data-value="responses"]',
      )!,
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it("keeps the popover and shows the failure reason when apply fails", async () => {
    const apply = vi.fn(async () => {
      useChatStore.setState({ actionError: "会话仍在运行" });
      return false;
    });
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    const dialog = await renderMenu();
    await click(
      dialog.querySelector(
        '[data-testid="session-api-mode"] [data-value="responses"]',
      )!,
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("reads the switched session's state", async () => {
    const secondState = state({
      identity: { base: "reviewer", extensions: [] },
      apiMode: { effective: "responses", override: "responses", source: "session" },
    });
    const active2 = { engine: "claude", sessionId: SID2, workspacePath: WS };
    useChatStore.setState({
      active: active2,
      openTabs: [active2],
      bySession: {
        [KEY2]: {
          ...EMPTY_SESSION,
          sessionControl: result({
            sourceSessionId: SID2,
            targetSessionId: SID2,
            state: secondState,
          }),
        },
      },
      applySessionControl: vi.fn(async () => true),
      refreshSessionControl: vi.fn(async () => result({ state: secondState })),
    });
    const dialog = await renderMenu();
    expect(
      dialog.querySelector(
        '[data-testid="session-api-mode"] [data-value="responses"]',
      )!.getAttribute("aria-checked"),
    ).toBe("true");
    await click(dialog.querySelector('[data-testid="session-identity-open"]')!);
    expect(usePendingIdentityStore.getState().request?.identity.value).toBe("reviewer");
  });

  it("切换会话后忽略旧修改的失败结果", async () => {
    const pending = Promise.withResolvers<boolean>();
    useChatStore.setState({
      applySessionControl: vi.fn(() => pending.promise),
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    const dialog = await renderMenu();
    await click(dialog.querySelector('[data-testid="session-api-mode"] [data-value="responses"]')!);
    await act(async () => {
      const active = { engine: "claude", sessionId: SID2, workspacePath: WS };
      useChatStore.setState({
        active, openTabs: [active],
        bySession: { [KEY2]: { ...EMPTY_SESSION, sessionControl: result() } },
      });
    });
    await act(async () => {
      useChatStore.setState({ actionError: "old error" });
      pending.resolve(false);
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("opens the shared identity dialog with the current base identity", async () => {
    useChatStore.setState({
      applySessionControl: vi.fn(async () => true),
      refreshSessionControl: vi.fn(async () => result()),
    });
    setStore();
    const dialog = await renderMenu();
    await click(dialog.querySelector('[data-testid="session-identity-open"]')!);
    const request = usePendingIdentityStore.getState().request;
    expect(request?.key).toBe(KEY);
    expect(request?.identity.value).toBe("simple-internal");
  });
});

describe("会话开关弹层", () => {
  it("连续开关只在真正打开时读取状态", async () => {
    const refresh = vi.fn(async () => result());
    useChatStore.setState({ refreshSessionControl: refresh });
    setStore();
    const trigger = await renderToggle();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await activate(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(refresh).toHaveBeenCalledTimes(cycle + 1);
      await act(async () => {
        document.querySelector<HTMLElement>('[role="dialog"]')!.focus();
      });
      await activate(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(refresh).toHaveBeenCalledTimes(cycle + 1);
    }
  });

  it.each(["123456", "invalid"])("关闭时只提交合法窗口草稿：%s", async (draft) => {
    const original = useChatStore.getState().setSessionAutoCompactWindow;
    const save = vi.fn();
    const refresh = vi.fn(async () => result());
    useChatStore.setState({ refreshSessionControl: refresh, setSessionAutoCompactWindow: save });
    try {
      setStore();
      const trigger = await renderToggle();
      await activate(trigger);
      const input = document.querySelector<HTMLInputElement>('input[aria-label="chat.sessionContextWindow"]')!;
      await act(async () => {
        input.focus();
        typeInto(input, draft);
      });
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
        trigger.focus();
      });
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(save).not.toHaveBeenCalled();
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
        trigger.click();
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(refresh).toHaveBeenCalledTimes(1);
      if (draft === "123456") {
        expect(save).toHaveBeenCalledExactlyOnceWith(KEY, 123456);
      } else {
        expect(save).not.toHaveBeenCalled();
      }
    } finally {
      await act(async () => {
        useChatStore.setState({ setSessionAutoCompactWindow: original });
      });
    }
  });
});
