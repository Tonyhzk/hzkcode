import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerToolbar } from "./composer-toolbar";
import { StatusBar } from "./ai-chat-composer";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { useChatStore } from "@/features/chat/store";
import type {
  SessionControlResult,
  SessionControlState,
} from "@/lib/ipc";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
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
const SID = "s-toolbar";
const KEY = `claude/${SID}`;
const ACTIVE = { engine: "claude", sessionId: SID, workspacePath: WS };

function state(): SessionControlState {
  return {
    hasConversation: false,
    availableApplyMethods: {
      identity: ["current"],
      promptMode: ["current"],
    },
    identity: { base: null, extensions: [] },
    promptMode: { effective: "full", override: null, source: "startup" },
    interactionMode: { effective: "default", override: null, source: "startup" },
    apiMode: { effective: "anthropic", override: null, source: "startup" },
    model: { effective: "high", override: null, source: "startup" },
    effort: { effective: null, override: null, source: "startup" },
    permission: { effective: "default", override: null, source: "startup" },
  };
}

function controlResult(): SessionControlResult {
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
    catalog: { identities: [], interactionModes: [] },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useChatStore.setState({
    active: ACTIVE,
    openTabs: [ACTIVE],
    bySession: {
      [KEY]: { ...EMPTY_SESSION, sessionControl: controlResult() },
    },
    controlBusy: false,
    controlBusyByKey: {},
    actionError: null,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderToolbar(props: {
  streaming?: boolean;
  onSend: () => void;
  onStop?: () => void;
}) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <section data-testid="input-actions">
          <ComposerToolbar {...props} />
        </section>
        <StatusBar />
      </MemoryRouter>,
    );
  });
}

describe("输入框与外侧状态栏", () => {
  it("将七个会话入口放在外侧状态栏而非输入框内", async () => {
    const onSend = vi.fn();
    await renderToolbar({ onSend });
    expect(container.querySelector('[data-testid="input-actions"]')?.querySelectorAll("[data-session-control]")).toHaveLength(0);
    expect(container.querySelector('[data-testid="composer-status-bar"]')?.querySelectorAll("[data-session-control]")).toHaveLength(7);
    const send = container.querySelector<HTMLButtonElement>(
      'button[aria-label="chat.send"]',
    )!;
    await act(async () => {
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("运行中仍将会话入口保留在外侧并显示停止按钮", async () => {
    const onStop = vi.fn();
    await renderToolbar({ streaming: true, onSend: vi.fn(), onStop });
    expect(container.querySelector('[data-testid="input-actions"]')?.querySelectorAll("[data-session-control]")).toHaveLength(0);
    expect(container.querySelector('[data-testid="composer-status-bar"]')?.querySelectorAll("[data-session-control]")).toHaveLength(7);
    const stop = container.querySelector<HTMLButtonElement>(
      'button[aria-label="chat.stop"]',
    )!;
    await act(async () => {
      stop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
