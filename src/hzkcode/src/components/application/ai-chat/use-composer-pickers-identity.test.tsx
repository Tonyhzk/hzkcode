import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerPickers } from "./use-composer-pickers";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { useChatStore } from "@/features/chat/store";
import { usePendingIdentityStore } from "@/features/agents/pending-identity";
import {
  getSelectedAgent,
  selectSelectedAgent,
} from "@/features/agents/selected-agent";
import {
  defaultIdentityOption,
  identityOptionFromAgent,
} from "@/features/chat/session-control-view";
import type { AgentConfig } from "@/lib/ipc";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  const t = (key: string) => key;
  return { ...actual, useTranslation: () => ({ t }) };
});

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/ws";
const SID = "s-1";
const KEY = `claude/${SID}`;

const AGENT: AgentConfig = {
  id: "agent-1",
  name: "审查",
  prompt: "审查代码",
};

const LEGACY: AgentConfig = {
  id: "legacy",
  name: "旧身份",
  prompt: "旧提示词",
};

function Harness() {
  const editableRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pickers = useComposerPickers({
    editableRef,
    wrapperRef,
    workspacePath: WS,
    value: "",
    lastEmittedRef: { current: "" },
    emitChange: () => {},
    syncTags: () => {},
  });
  return (
    <div ref={wrapperRef}>
      <div ref={editableRef} contentEditable suppressContentEditableWarning />
        <button
          type="button"
          data-testid="pick-agent"
          onClick={() =>
            pickers.handleAgentSelect({
              kind: "identity",
              identity: identityOptionFromAgent(AGENT),
            })
          }
        >
          pick
        </button>
        <button
          type="button"
          data-testid="pick-default"
          onClick={() =>
            pickers.handleAgentSelect({
              kind: "identity",
              identity: defaultIdentityOption("默认身份"),
            })
          }
        >
          default
        </button>
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  usePendingIdentityStore.setState({ request: null });
  const active = { engine: "claude", sessionId: SID, workspacePath: WS };
  useChatStore.setState({
    active,
    openTabs: [active],
    bySession: { [KEY]: { ...EMPTY_SESSION } },
  });
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function click(testId: string) {
  const button = container.querySelector(`[data-testid="${testId}"]`)!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("composer # identity picker", () => {
  it("requests session-control apply without touching the current identity", async () => {
    selectSelectedAgent(WS, SID, LEGACY);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Harness />
        </MemoryRouter>,
      );
    });
    await click("pick-agent");

    expect(usePendingIdentityStore.getState().request).toEqual({
      key: KEY,
      identity: {
        value: "审查",
        name: "审查",
        description: "审查代码",
        icon: null,
        group: "custom",
        source: "custom",
        agent: AGENT,
      },
    });
    // 选择只发起待应用请求：生效身份与旧记录在对话框确认前不变。
    expect(getSelectedAgent(WS, SID)).toEqual(LEGACY);
  });

  it("requests the default identity for the sentinel row", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Harness />
        </MemoryRouter>,
      );
    });
    await click("pick-default");
    expect(usePendingIdentityStore.getState().request?.identity.value).toBeNull();
  });
});
