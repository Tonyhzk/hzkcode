import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: { getAppSettings: vi.fn(async () => ({})) },
}));
vi.mock("@/lib/events", () => ({
  listenSettingsChanged: vi.fn(async () => () => {}),
}));

import { defaultShortcutFor, resolveShortcut, shortcutActions } from "./actions";
import { registerShortcutHandler, startShortcutRuntime } from "./runtime";
import { useShortcutsStore } from "./store";

const action = (id: string) => {
  const found = shortcutActions.find((a) => a.id === id);
  if (!found) throw new Error(`unknown action ${id}`);
  return found;
};
const originalPlatform = window.navigator.platform;
afterAll(() => {
  Object.defineProperty(window.navigator, "platform", {
    value: originalPlatform,
    configurable: true,
  });
});

function pressKey(
  key: string,
  modifiers: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
  target: EventTarget = window,
) {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: modifiers.meta ?? false,
    ctrlKey: modifiers.ctrl ?? false,
    shiftKey: modifiers.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("resolveShortcut", () => {
  it("falls back to the default when the setting is absent", () => {
    expect(resolveShortcut(action("newSession"), {})).toBe("cmd+n");
  });

  it("treats an empty string as explicitly unbound", () => {
    expect(
      resolveShortcut(action("newSession"), { newSessionShortcut: "" }),
    ).toBeNull();
  });

  it("prefers the configured value over the default", () => {
    expect(
      resolveShortcut(action("newSession"), { newSessionShortcut: "cmd+alt+n" }),
    ).toBe("cmd+alt+n");
  });

  it("resolves the interrupt default to Esc", () => {
    expect(defaultShortcutFor(action("interrupt"))).toBe("esc");
  });
});

describe("shortcut runtime dispatch", () => {
  beforeEach(() => {
    useShortcutsStore.setState({ values: {} });
    // Dispatch resolves defaults per-platform; pin macOS so cmd = metaKey.
    Object.defineProperty(window.navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
  });

  it("runs the registered handler on the default key and prevents default", () => {
    const stop = startShortcutRuntime();
    const spy = vi.fn();
    const unregister = registerShortcutHandler("commandPalette", spy);
    const event = pressKey("k", { meta: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    unregister();
    stop();
  });

  it("does not fire an explicitly unbound (cleared) action", () => {
    const stop = startShortcutRuntime();
    useShortcutsStore.setState({ values: { commandPaletteShortcut: "" } });
    const spy = vi.fn();
    const unregister = registerShortcutHandler("commandPalette", spy);
    pressKey("k", { meta: true });
    expect(spy).not.toHaveBeenCalled();
    unregister();
    stop();
  });

  it("hot-reloads rebound keys from the store", () => {
    const stop = startShortcutRuntime();
    useShortcutsStore.setState({
      values: { commandPaletteShortcut: "cmd+shift+p" },
    });
    const spy = vi.fn();
    const unregister = registerShortcutHandler("commandPalette", spy);
    pressKey("k", { meta: true });
    expect(spy).not.toHaveBeenCalled();
    pressKey("p", { meta: true, shift: true });
    expect(spy).toHaveBeenCalledTimes(1);
    unregister();
    stop();
  });

  it("keeps a custom modifier interrupt key out of editable targets", () => {
    const stop = startShortcutRuntime();
    useShortcutsStore.setState({ values: { interruptShortcut: "ctrl+c" } });
    const spy = vi.fn();
    const unregister = registerShortcutHandler("interrupt", spy);
    const input = document.createElement("input");
    document.body.appendChild(input);
    pressKey("c", { ctrl: true }, input);
    expect(spy).not.toHaveBeenCalled();
    pressKey("c", { ctrl: true });
    expect(spy).toHaveBeenCalledTimes(1);
    input.remove();
    unregister();
    stop();
  });

  it("fires interrupt on the default Esc even inside the composer", async () => {
    const stop = startShortcutRuntime();
    const spy = vi.fn();
    const unregister = registerShortcutHandler("interrupt", spy);
    const input = document.createElement("input");
    document.body.appendChild(input);
    pressKey("Escape", {}, input);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    input.remove();
    unregister();
    stop();
  });

  it("yields the default Esc to another consumer that prevents default", async () => {
    const stop = startShortcutRuntime();
    const spy = vi.fn();
    const unregister = registerShortcutHandler("interrupt", spy);
    // 模拟命令面板等晚注册的 window 监听：消费 Esc 时 preventDefault
    const consumer = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    window.addEventListener("keydown", consumer);
    pressKey("Escape");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spy).not.toHaveBeenCalled();
    window.removeEventListener("keydown", consumer);
    unregister();
    stop();
  });

  it("yields the default Esc to a capture-phase consumer (context menu)", async () => {
    const stop = startShortcutRuntime();
    const spy = vi.fn();
    const unregister = registerShortcutHandler("interrupt", spy);
    // 模拟右键菜单：window 捕获阶段消费 Esc（stopPropagation + preventDefault），
    // 事件的 target 在页面内部而不是 window 本身。
    const consumer = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", consumer, true);
    pressKey("Escape", {}, document.body);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spy).not.toHaveBeenCalled();
    window.removeEventListener("keydown", consumer, true);
    unregister();
    stop();
  });

  it("ignores Esc while an IME composition is active", async () => {
    const stop = startShortcutRuntime();
    const spy = vi.fn();
    const unregister = registerShortcutHandler("interrupt", spy);
    // 输入法候选窗开着（isComposing）或已按 IME 老协议上报 keyCode 229 时，
    // Esc 属于 IME 的取消键，不能当作中断。
    for (const mark of [
      (event: KeyboardEvent) => Object.defineProperty(event, "isComposing", { value: true }),
      (event: KeyboardEvent) => Object.defineProperty(event, "keyCode", { value: 229 }),
    ]) {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      mark(event);
      window.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spy).not.toHaveBeenCalled();
    }
    unregister();
    stop();
  });
});
