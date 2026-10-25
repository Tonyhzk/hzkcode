import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionControlDialogHost } from "./SessionControlDialogHost";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { useChatStore } from "@/features/chat/store";
import { usePendingIdentityStore } from "@/features/agents/pending-identity";
import { useAgentStore } from "@/features/agents/agent-store";
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
          id: "reviewer",
          name: "审查",
          description: "",
          source: "userSettings",
          tools: null,
          disallowedTools: [],
          model: null,
          effort: null,
          permissionMode: null,
        },
      ],
      interactionModes: [],
    },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function setSession({
  sessionState = state(),
  streaming = false,
}: {
  sessionState?: SessionControlState;
  streaming?: boolean;
} = {}) {
  const active = { engine: "claude", sessionId: SID, workspacePath: WS };
  useChatStore.setState({
    active,
    openTabs: [active],
    bySession: {
      [KEY]: {
        ...EMPTY_SESSION,
        streaming,
        usage: null,
        sessionControl: result({ state: sessionState }),
      },
    },
    controlBusy: false,
    controlBusyByKey: {},
    actionError: null,
  });
}

function requestIdentity(value: string | null = "reviewer") {
  usePendingIdentityStore.getState().requestIdentity(KEY, {
    value,
    name: value ?? "默认",
    group: value === null ? "default" : "external",
    source: value === null ? "default" : "userSettings",
  });
}

async function renderHost() {
  await act(async () => {
    root.render(<SessionControlDialogHost />);
  });
  return document.querySelector(
    '[data-testid="session-control-dialog"]',
  ) as HTMLElement | null;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function buttonByText(text: string) {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  )!;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  usePendingIdentityStore.setState({ request: null });
  useAgentStore.setState({ agents: [], builtInAgents: [], loaded: true });
  useChatStore.setState({
    applySessionControl: vi.fn(async () => true),
    refreshSessionControl: vi.fn(async () => result()),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("SessionControlDialogHost", () => {
  it("applies the requested identity with the chosen method and closes", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setSession();
    requestIdentity();
    const dialog = await renderHost();
    expect(dialog).not.toBeNull();

    await click(dialog!.querySelector('[data-apply="clone"]')!);
    await click(buttonByText("chat.sessionApply"));

    expect(apply).toHaveBeenCalledWith({
      operation: "identity",
      value: "reviewer",
      apply: "clone",
    });
    expect(usePendingIdentityStore.getState().request).toBeNull();
    expect(document.querySelector('[data-testid="session-control-dialog"]')).toBeNull();
  });

  it("sends the engine's 'default' value when clearing the identity", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setSession();
    requestIdentity(null);
    await renderHost();
    await click(buttonByText("chat.sessionApply"));
    expect(apply).toHaveBeenCalledWith({
      operation: "identity",
      value: "default",
      apply: "current",
    });
  });

  it("keeps the dialog and selection on failure", async () => {
    const apply = vi.fn(async () => {
      useChatStore.setState({ actionError: "该身份不可用" });
      return false;
    });
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setSession();
    requestIdentity();
    await renderHost();
    await click(buttonByText("chat.sessionApply"));

    expect(usePendingIdentityStore.getState().request).not.toBeNull();
    const stillOpen = document.querySelector(
      '[data-testid="session-control-dialog"]',
    )!;
    expect(stillOpen).not.toBeNull();
    expect(stillOpen.querySelector('[data-identity="reviewer"]')!.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(stillOpen.querySelector('[role="alert"]')!.textContent).toBe(
      "该身份不可用",
    );
  });

  it("passes the GUI custom identity definition with the command", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    const agent = { id: "agent-1", name: "审查", prompt: "审查代码" };
    useAgentStore.setState({ agents: [agent], builtInAgents: [], loaded: true });
    setSession();
    usePendingIdentityStore.getState().requestIdentity(KEY, {
      value: "审查",
      name: "审查",
      group: "custom",
      source: "custom",
      agent,
    });
    await renderHost();
    await click(buttonByText("chat.sessionApply"));
    expect(apply).toHaveBeenCalledWith({
      operation: "identity",
      value: "审查",
      apply: "current",
      agent,
    });
  });

  it("applies an app role by its stable catalog id", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    const role = {
      id: "agency-agents:design/design-ui-designer",
      divisionId: "design",
      name: "UI 设计师",
      description: "设计界面",
      icon: "🎨",
      enabled: true,
    };
    useAgentStore.setState({ agents: [], builtInAgents: [role], loaded: true });
    setSession();
    usePendingIdentityStore.getState().requestIdentity(KEY, {
      value: role.id,
      name: role.name,
      group: "agency",
      source: "builtIn",
      builtIn: role,
    });
    await renderHost();
    await click(buttonByText("chat.sessionApply"));
    expect(apply).toHaveBeenCalledWith({
      operation: "identity",
      value: role.id,
      apply: "current",
    });
  });

  it("keeps the selection when a refresh replaces the identity objects", async () => {
    const apply = vi.fn(async () => false);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setSession();
    requestIdentity();
    const dialog = await renderHost();
    await click(dialog!.querySelector('[data-identity="reviewer"]')!);
    await click(buttonByText("chat.sessionApply"));
    // 失败后 Host 清错并重读目录；用新的 initialIdentity 对象重新渲染，
    // 用户刚选的 reviewer 仍保持选中。
    await act(async () => {
      useChatStore.setState({ actionError: "该身份不可用" });
      root.render(<SessionControlDialogHost />);
    });
    expect(
      document
        .querySelector('[data-identity="reviewer"]')!
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("ignores a stale apply result after switching sessions", async () => {
    let resolveApply: (ok: boolean) => void = () => {};
    const apply = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveApply = resolve)),
    );
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setSession();
    requestIdentity();
    await renderHost();
    await click(buttonByText("chat.sessionApply"));

    const other = { engine: "claude", sessionId: SID2, workspacePath: WS };
    const kept = useChatStore.getState().bySession[KEY]!;
    await act(async () => {
      useChatStore.setState({
        active: other,
        openTabs: [other],
        bySession: {
          [KEY]: kept,
          [KEY2]: { ...EMPTY_SESSION, sessionControl: result() },
        },
      });
    });
    await act(async () => resolveApply(false));

    // 切回原会话：旧回调不得写入错误，待应用请求仍保留供重试。
    await act(async () => {
      useChatStore.setState({
        active: { engine: "claude", sessionId: SID, workspacePath: WS },
        openTabs: [{ engine: "claude", sessionId: SID, workspacePath: WS }],
      });
    });
    expect(usePendingIdentityStore.getState().request).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="session-control-dialog"]'),
    ).not.toBeNull();
  });

  it("hides the dialog while another session is active and shows it again", async () => {
    setSession();
    requestIdentity();
    expect(await renderHost()).not.toBeNull();

    const other = { engine: "claude", sessionId: SID2, workspacePath: WS };
    await act(async () => {
      useChatStore.setState({
        active: other,
        openTabs: [other],
        bySession: {
          [KEY2]: { ...EMPTY_SESSION, sessionControl: result() },
        },
      });
    });
    expect(document.querySelector('[data-testid="session-control-dialog"]')).toBeNull();

    await act(async () => {
      useChatStore.setState({
        active: { engine: "claude", sessionId: SID, workspacePath: WS },
        openTabs: [{ engine: "claude", sessionId: SID, workspacePath: WS }],
      });
    });
    expect(document.querySelector('[data-testid="session-control-dialog"]')).not.toBeNull();
  });

  it("disables apply while the session runs", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setSession({ streaming: true });
    requestIdentity();
    const dialog = await renderHost();
    const applyButton = buttonByText("chat.sessionApply");
    expect(applyButton.hasAttribute("disabled")).toBe(true);
    await click(applyButton);
    expect(apply).not.toHaveBeenCalled();
    expect(dialog!.textContent).toContain("chat.sessionControlRunning");
  });

  it("hides apply methods for an empty conversation", async () => {
    const apply = vi.fn(async () => true);
    useChatStore.setState({
      applySessionControl: apply,
      refreshSessionControl: vi.fn(async () => result()),
    });
    setSession({ sessionState: state({ hasConversation: false }) });
    requestIdentity();
    const dialog = await renderHost();
    expect(dialog!.querySelector("[data-apply]")).toBeNull();
    await click(buttonByText("chat.sessionApply"));
    expect(apply).toHaveBeenCalledWith({
      operation: "identity",
      value: "reviewer",
      apply: "current",
    });
  });
});
