import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerActions } from "./use-composer-actions";
import { useChatStore, type ActiveSession } from "../store";
import { EMPTY_SESSION } from "../store/stream";
import type { Message } from "@/lib/ipc";

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

let container: HTMLDivElement;
let root: Root;
let clearImagesMock: ReturnType<typeof vi.fn>;

function Harness({
  onReady,
  images,
  streaming,
  active,
  sessionKey,
}: {
  onReady: (submit: (value: string) => Promise<void>) => void;
  images: string[];
  streaming: boolean;
  active: ActiveSession;
  sessionKey: string;
}) {
  const { submit } = useComposerActions({
    active,
    sessionKey,
    streaming,
    images,
    clearImages: clearImagesMock,
    importImageFiles: () => {},
    supportsImages: true,
    composerInputRef: { current: null },
  });
  onReady(submit);
  return null;
}

async function render({
  controlBusy = false,
  streaming = false,
  images = [],
  drafts = {},
  active = { engine: "claude", sessionId: SID, workspacePath: WS },
  sessionKey: key = KEY,
  send: sendOverride,
}: {
  controlBusy?: boolean;
  streaming?: boolean;
  images?: string[];
  drafts?: Record<string, string>;
  active?: ActiveSession;
  sessionKey?: string;
  send?: ReturnType<typeof vi.fn>;
} = {}) {
  const send = sendOverride ?? vi.fn(async () => true);
  const queueMessage = vi.fn();
  const setDraft = vi.fn();
  const clearPendingMention = vi.fn();
  const interrupt = vi.fn(async () => {});
  useChatStore.setState({
    active,
    openTabs: [active],
    controlBusy,
    drafts,
    send,
    queueMessage,
    setDraft,
    clearPendingMention,
    interrupt,
  });
  let submit: ((value: string) => Promise<void>) | null = null;
  await act(async () => {
    root.render(
      <Harness
        images={images}
        streaming={streaming}
        active={active}
        sessionKey={key}
        onReady={(fn) => (submit = fn)}
      />,
    );
  });
  return {
    send,
    queueMessage,
    setDraft,
    submit: submit!,
    rerender: (nextImages: string[]) =>
      act(async () => {
        root.render(
          <Harness
            images={nextImages}
            streaming={streaming}
            active={active}
            sessionKey={key}
            onReady={(fn) => (submit = fn)}
          />,
        );
      }),
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  clearImagesMock = vi.fn();
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useComposerActions submit", () => {
  it("does not send or clear the draft while session control is busy", async () => {
    const { send, queueMessage, setDraft, submit } = await render({
      controlBusy: true,
    });
    await act(async () => submit("继续"));
    expect(send).not.toHaveBeenCalled();
    expect(queueMessage).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
    expect(clearImagesMock).not.toHaveBeenCalled();
  });

  it("发送接受后清附件，草稿交由 store 处理", async () => {
    const { send, setDraft, submit } = await render({
      images: ["/a.png"],
      drafts: { [KEY]: "继续" },
    });
    await act(async () => submit("继续"));
    expect(send).toHaveBeenCalledWith("继续", ["/a.png"]);
    expect(setDraft).not.toHaveBeenCalled();
    expect(clearImagesMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft and images when the send is rejected", async () => {
    const send = vi.fn(async () => false);
    const { setDraft, submit } = await render({
      send,
      images: ["/a.png"],
      drafts: { [KEY]: "继续" },
    });
    await act(async () => submit("继续"));
    expect(send).toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
    expect(clearImagesMock).not.toHaveBeenCalled();
  });

  it("does not clear text the user typed while the send was pending", async () => {
    const send = vi.fn(async () => {
      useChatStore.setState({ drafts: { [KEY]: "新输入" } });
      return true;
    });
    const { setDraft, submit } = await render({
      send,
      drafts: { [KEY]: "继续" },
    });
    await act(async () => submit("继续"));
    expect(setDraft).not.toHaveBeenCalled();
    // 附件没变，仍属于本次发送，可以清理。
    expect(clearImagesMock).toHaveBeenCalledTimes(1);
  });

  it("does not clear attachments added while the send was pending", async () => {
    let resolveSend: (accepted: boolean) => void = () => {};
    const send = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveSend = resolve)),
    );
    const view = await render({
      send,
      images: ["/a.png"],
      drafts: { [KEY]: "继续" },
    });
    let submitted: Promise<void> | null = null;
    await act(async () => {
      submitted = view.submit("继续");
    });
    await view.rerender(["/a.png", "/b.png"]);
    await act(async () => {
      resolveSend(true);
      await submitted;
    });
    expect(clearImagesMock).not.toHaveBeenCalled();
  });

  it("不根据相同文本推断其他会话的草稿归属", async () => {
    const NEW_KEY = "claude/native-1";
    const oldKey = `new:claude:${WS}`;
    const newTab: ActiveSession = {
      engine: "claude",
      sessionId: null,
      workspacePath: WS,
    };
    const userRow: Message = {
      seq: 1,
      role: "user",
      text: "继续",
      ts: null,
    };
    const send = vi.fn(async () => {
      // 模拟会话事件：草稿与消息从临时键迁到原生 id 的键。
      useChatStore.setState({
        drafts: { [NEW_KEY]: "继续" },
        openTabs: [{ engine: "claude", sessionId: "native-1", workspacePath: WS }],
        bySession: {
          [NEW_KEY]: { ...EMPTY_SESSION, messages: [userRow] },
        },
      });
      return true;
    });
    const { setDraft, submit } = await render({
      send,
      active: newTab,
      sessionKey: oldKey,
      drafts: { [oldKey]: "继续" },
    });
    await act(async () => submit("继续"));
    expect(setDraft).not.toHaveBeenCalled();
  });

  it("does not migrate-clear when another session could match", async () => {
    const NEW_KEY = "claude/native-1";
    const OTHER_KEY = "claude/native-2";
    const oldKey = `new:claude:${WS}`;
    const newTab: ActiveSession = {
      engine: "claude",
      sessionId: null,
      workspacePath: WS,
    };
    const row: Message = { seq: 1, role: "user", text: "继续", ts: null };
    const send = vi.fn(async () => {
      useChatStore.setState({
        drafts: { [NEW_KEY]: "继续", [OTHER_KEY]: "继续" },
        openTabs: [
          { engine: "claude", sessionId: "native-1", workspacePath: WS },
          { engine: "claude", sessionId: "native-2", workspacePath: WS },
        ],
        bySession: {
          [NEW_KEY]: { ...EMPTY_SESSION, messages: [row] },
          [OTHER_KEY]: { ...EMPTY_SESSION, messages: [row] },
        },
      });
      return true;
    });
    const { setDraft, submit } = await render({
      send,
      active: newTab,
      sessionKey: oldKey,
      drafts: { [oldKey]: "继续" },
    });
    await act(async () => submit("继续"));
    expect(setDraft).not.toHaveBeenCalled();
  });

  it("parks the message in the queue and clears immediately while streaming", async () => {
    const { send, queueMessage, setDraft, submit } = await render({
      streaming: true,
      images: ["/a.png"],
      drafts: { [KEY]: "继续" },
    });
    await act(async () => submit("继续"));
    expect(send).not.toHaveBeenCalled();
    expect(queueMessage).toHaveBeenCalledWith("继续", ["/a.png"]);
    expect(setDraft).toHaveBeenCalledWith(KEY, "");
    expect(clearImagesMock).toHaveBeenCalledTimes(1);
  });
});
