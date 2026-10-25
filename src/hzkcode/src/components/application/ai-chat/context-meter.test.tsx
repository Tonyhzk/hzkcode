import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "./ai-chat-composer";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./session-toggles", () => ({ SessionToggles: () => null }));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    getAppSettings: vi.fn(async () => ({})),
    listAgents: vi.fn(async () => []),
    listBuiltInAgents: vi.fn(async () => ({ agents: [], divisions: [] })),
  },
}));
vi.mock("@/lib/events", () => ({
  listenSettingsChanged: vi.fn(async () => () => {}),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let trigger: HTMLButtonElement;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<StatusBar usagePct={25} contextMax={200_000} />);
  });
  trigger = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

async function activate(element: HTMLElement) {
  // 分开发送事件，让 React 提交失焦导致的更新，而不是把整次按压合并处理。
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    element.focus();
  });
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    element.click();
  });
}

describe("上下文用量面板", () => {
  it("连续点击图标交替打开与关闭，不会关闭后重开", async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await activate(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(dialog()).not.toBeNull();
      await act(async () => dialog()!.focus());
      await activate(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(dialog()).toBeNull();
    }
  });

  it("焦点回到图标不提前关闭，长按后仍只关闭一次", async () => {
    await activate(trigger);
    await act(async () => dialog()!.focus());
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.focus();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
      trigger.click();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
    await activate(trigger);
    expect(dialog()).not.toBeNull();
  });

  it("点击面板内部保持打开，点击外部关闭且可以立即重开", async () => {
    await activate(trigger);
    const header = dialog()!.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await activate(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(dialog()).toBeNull();
    await activate(trigger);
    expect(dialog()).not.toBeNull();
  });

  it("Esc 关闭后可再次打开", async () => {
    await activate(trigger);
    await act(async () => {
      dialog()!.focus();
      dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
    await activate(trigger);
    expect(dialog()).not.toBeNull();
  });

  it("刷新操作不会关闭面板或触发压缩", async () => {
    const onRefresh = vi.fn();
    const onCompact = vi.fn();
    await act(async () => {
      root.render(<StatusBar onRefreshUsage={onRefresh} onCompactContext={onCompact} />);
    });
    await activate(trigger);
    await activate(dialog()!.querySelector<HTMLButtonElement>('[data-testid="refresh-usage-btn"]')!);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onCompact).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});
