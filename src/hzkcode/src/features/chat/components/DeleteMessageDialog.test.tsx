import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { DeleteMessageDialog } from "./DeleteMessageDialog";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    deleteMessage: vi.fn(async () => undefined),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("DeleteMessageDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onDeleted: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipc.deleteMessage).mockResolvedValue(undefined);
    onDeleted = vi.fn();
    onClose = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = () => {
    act(() => {
      root.render(
        <DeleteMessageDialog
          engine="claude"
          sessionId="s-1"
          target={{ uuid: "u-1" }}
          onDeleted={onDeleted}
          onClose={onClose}
        />,
      );
    });
  };

  const clickDelete = async () => {
    await act(async () => {
      findButton(container, "删除").click();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("deletes the message and refreshes before closing", async () => {
    render();
    await clickDelete();
    expect(ipc.deleteMessage).toHaveBeenCalledWith("claude", "s-1", "u-1");
    expect(onDeleted).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("waits for the refresh callback before closing", async () => {
    // onDeleted hands back the anchor cleanup + session reload: the dialog
    // must stay open until it resolves, or an immediate send could still
    // read a stale rewind anchor.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    onDeleted = vi.fn(() => gate);
    render();
    await clickDelete();
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failure and keeps the dialog open for retry", async () => {
    vi.mocked(ipc.deleteMessage).mockRejectedValue(
      new Error("该会话仍在运行，回合结束后再删除这条消息"),
    );
    render();
    await clickDelete();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("仍在运行");
    expect(isDisabled(findButton(container, "删除"))).toBe(false);
  });

  it("locks the dialog while the delete is in flight", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(ipc.deleteMessage).mockImplementation(
      () => new Promise((r) => (resolve = r)) as never,
    );
    render();
    await act(async () => {
      findButton(container, "删除").click();
      await Promise.resolve();
    });
    // The overlay click must not close mid-flight: the file change would
    // land behind a user who believes they cancelled.
    act(() => {
      (container.firstElementChild as HTMLElement).click();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(isDisabled(findButton(container, "取消"))).toBe(true);
    expect(isDisabled(findButton(container, "删除"))).toBe(true);
    await act(async () => {
      resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes without deleting on cancel", async () => {
    render();
    act(() => findButton(container, "取消").click());
    expect(ipc.deleteMessage).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
