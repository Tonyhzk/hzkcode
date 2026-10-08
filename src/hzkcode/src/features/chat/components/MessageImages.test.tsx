import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImageLightbox } from "./MessageImages";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("ImageLightbox", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    // jsdom 的 HTMLDialogElement 只有 open 反射，未实现 showModal/close；
    // 补最小实现让灯箱能挂载并走 close 事件链。
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container.remove();
  });

  async function render(onClose: () => void) {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ImageLightbox
          src="data:image/png;base64,AA=="
          name="shot.png"
          onClose={onClose}
        />,
      );
    });
    return document.querySelector("dialog") as HTMLDialogElement;
  }

  it("consumes Escape and closes the lightbox", async () => {
    const onClose = vi.fn();
    const dialog = await render(onClose);
    expect(dialog.open).toBe(true);

    let event!: KeyboardEvent;
    await act(async () => {
      event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      dialog.dispatchEvent(event);
    });

    // Consumed mark: the global Esc=interrupt runtime yields on defaultPrevented
    // (see shortcuts/runtime) — the native dialog close alone carries no mark.
    expect(event.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves other keys untouched", async () => {
    const onClose = vi.fn();
    const dialog = await render(onClose);

    let event!: KeyboardEvent;
    await act(async () => {
      event = new KeyboardEvent("keydown", {
        key: "a",
        bubbles: true,
        cancelable: true,
      });
      dialog.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(dialog.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});
