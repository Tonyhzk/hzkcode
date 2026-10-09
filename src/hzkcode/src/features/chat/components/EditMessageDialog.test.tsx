import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { EditMessageDialog } from "./EditMessageDialog";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    editMessage: vi.fn(async () => ({
      errorCode: null,
      archived: false,
      detail: "Edited message u-1",
    })),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUTCOME_OK = { errorCode: null, archived: false, detail: "Edited message u-1" };

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );
  if (!button) throw new Error(`button ${label} not found`);
  return button as HTMLButtonElement;
}

const isDisabled = (el: HTMLElement) =>
  (el as HTMLButtonElement).disabled ||
  el.getAttribute("aria-disabled") === "true";

describe("EditMessageDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSaved: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipc.editMessage).mockResolvedValue(OUTCOME_OK);
    onSaved = vi.fn();
    onClose = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (target: { uuid: string; text: string; tail?: string }) => {
    act(() => {
      root.render(
        <EditMessageDialog
          engine="claude"
          sessionId="s-1"
          workspacePath="/ws"
          target={target}
          onSaved={onSaved}
          onClose={onClose}
        />,
      );
    });
  };
  const textarea = () => container.querySelector("textarea") as HTMLTextAreaElement;

  const setDraft = (value: string) => {
    act(() => {
      const el = textarea();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const clickSave = async () => {
    await act(async () => {
      findButton(container, "保存").click();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("saves the edited text and reports the new value", async () => {
    render({ uuid: "u-1", text: "hello" });
    setDraft("hello world");
    await clickSave();
    expect(ipc.editMessage).toHaveBeenCalledWith(
      "claude",
      "s-1",
      "/ws",
      "u-1",
      "hello world",
    );
    expect(onSaved).toHaveBeenCalledWith("u-1", "hello world");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps leading indentation and trailing newlines verbatim", async () => {
    render({ uuid: "u-1", text: "  pasted code\n" });
    await clickSave();
    expect(ipc.editMessage).toHaveBeenCalledWith(
      "claude",
      "s-1",
      "/ws",
      "u-1",
      "  pasted code\n",
    );
    expect(onSaved).toHaveBeenCalledWith("u-1", "  pasted code\n");
  });

  it("appends the hidden legacy tail block back to the saved text", async () => {
    const tail = "\n\n## Agent Role and Instructions\nold block";
    render({ uuid: "u-1", text: "body", tail });
    setDraft("rewritten body");
    await clickSave();
    expect(ipc.editMessage).toHaveBeenCalledWith(
      "claude",
      "s-1",
      "/ws",
      "u-1",
      `rewritten body\n\n## Agent Role and Instructions\nold block`,
    );
  });

  it("notes an archived-segment edit and closes on confirmation", async () => {
    vi.mocked(ipc.editMessage).mockResolvedValue({
      errorCode: null,
      archived: true,
      detail: "Edited message u-1",
    });
    render({ uuid: "u-1", text: "hello" });
    await clickSave();
    expect(onSaved).toHaveBeenCalledWith("u-1", "hello");
    // The dialog stays open with the archived note until the user confirms.
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    act(() => findButton(container, "关闭").click());
    expect(onClose).toHaveBeenCalled();
  });

  it("maps a classified failure to an alert and keeps the draft", async () => {
    vi.mocked(ipc.editMessage).mockResolvedValue({
      errorCode: "session_live",
      archived: false,
      detail: "session is live",
    });
    render({ uuid: "u-1", text: "hello" });
    await clickSave();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    // The draft survives for a corrected retry.
    expect(textarea().value).toBe("hello");
    expect(isDisabled(findButton(container, "保存"))).toBe(false);
  });

  it("locks the dialog while the edit is in flight", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(ipc.editMessage).mockImplementation(
      () => new Promise((r) => (resolve = r)) as never,
    );
    render({ uuid: "u-1", text: "hello" });
    await act(async () => {
      findButton(container, "保存").click();
      await Promise.resolve();
    });
    // The overlay click must not close mid-flight: the file change would
    // land behind a user who believes they cancelled.
    act(() => {
      (container.firstElementChild as HTMLElement).click();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(isDisabled(findButton(container, "取消"))).toBe(true);
    expect(isDisabled(findButton(container, "保存"))).toBe(true);
    expect(textarea().disabled).toBe(true);
    await act(async () => {
      resolve(OUTCOME_OK);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("waits for the save callback before closing", async () => {
    // onSaved hands back the resumable-set refresh (and stale-anchor
    // cleanup): the dialog must stay open until it resolves, or an
    // immediate continue/retry would still read the old anchor.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    onSaved = vi.fn(() => gate);
    render({ uuid: "u-1", text: "hello" });
    setDraft("hello world");
    await clickSave();
    expect(onSaved).toHaveBeenCalledWith("u-1", "hello world");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
