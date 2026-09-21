import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSelectionGuard } from "./selection-guard";

/** jsdom has no PointerEvent constructor; a MouseEvent with the pointer
 *  type string still reaches the capture-phase listeners. */
function press(el: EventTarget, type = "pointerdown", init: MouseEventInit = {}) {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...init }));
}

describe("installSelectionGuard", () => {
  let uninstall: () => void;

  beforeEach(() => {
    uninstall = installSelectionGuard();
  });

  afterEach(() => {
    uninstall();
    document.body.replaceChildren();
  });

  it("marks the window non-selectable while a press on chrome is held", () => {
    const chrome = document.createElement("div");
    document.body.appendChild(chrome);
    press(chrome);
    expect(document.documentElement.hasAttribute("data-window-dragging")).toBe(true);
    press(document, "pointerup");
    expect(document.documentElement.hasAttribute("data-window-dragging")).toBe(false);
  });

  it("keeps presses on readable surfaces selectable", () => {
    for (const className of ["prose-chat", "cm-editor"]) {
      const readable = document.createElement("div");
      readable.className = className;
      document.body.appendChild(readable);
      press(readable);
      expect(document.documentElement.hasAttribute("data-window-dragging")).toBe(false);
    }
    const input = document.createElement("input");
    document.body.appendChild(input);
    press(input);
    expect(document.documentElement.hasAttribute("data-window-dragging")).toBe(false);
  });

  it("ignores non-primary buttons", () => {
    const chrome = document.createElement("div");
    document.body.appendChild(chrome);
    press(chrome, "pointerdown", { button: 2 });
    expect(document.documentElement.hasAttribute("data-window-dragging")).toBe(false);
  });

  it("clears on blur and on a fresh press on a readable surface", () => {
    const chrome = document.createElement("div");
    document.body.appendChild(chrome);
    press(chrome);
    expect(document.documentElement.hasAttribute("data-window-dragging")).toBe(true);

    // A drag released outside the window never delivers pointerup.
    window.dispatchEvent(new Event("blur"));
    expect(document.documentElement.hasAttribute("data-window-dragging")).toBe(false);

    // Stale flag + a press that starts a text selection: the flag must drop.
    press(chrome);
    expect(document.documentElement.hasAttribute("data-window-dragging")).toBe(true);
    const prose = document.createElement("div");
    prose.className = "prose-chat";
    document.body.appendChild(prose);
    press(prose);
    expect(document.documentElement.hasAttribute("data-window-dragging")).toBe(false);
  });

  it("clears on pointercancel", () => {
    const chrome = document.createElement("div");
    document.body.appendChild(chrome);
    press(chrome);
    expect(document.documentElement.hasAttribute("data-window-dragging")).toBe(true);
    press(document, "pointercancel");
    expect(document.documentElement.hasAttribute("data-window-dragging")).toBe(false);
  });
});
