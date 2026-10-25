import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionMenu } from "./permission-menu";
import {
  createInitialSwitchProfiles,
  rememberPermissionSwitchMemory,
  type ComposerPermission,
} from "./permission-modes";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { label?: string }) =>
      key === "chat.permissionLabel" || key === "chat.permissionDraft"
        ? `${key}:${options?.label ?? ""}`
        : key,
  }),
}));

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  rememberPermissionSwitchMemory(createInitialSwitchProfiles("default"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function activate(element: HTMLElement) {
  // 按下与松开分开发送，让 React 提交失焦导致的更新，而不是把整次按压合并处理。
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    element.focus();
  });
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    element.click();
  });
}

function permissionTrigger() {
  return container.querySelector(
    'button[aria-label^="chat.permissionLabel"]',
  ) as HTMLButtonElement;
}

async function openMenu(
  onChange = vi.fn(),
  value: ComposerPermission = "default",
) {
  await act(async () => {
    root.render(<PermissionMenu value={value} onChange={onChange} />);
  });
  const trigger = container.querySelector(
    'button[aria-label^="chat.permissionLabel"]',
  ) as HTMLButtonElement;
  await click(trigger);
  return document.querySelector('[role="dialog"]') as HTMLElement;
}

function buttonByText(rootNode: ParentNode, text: string) {
  return [...rootNode.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  );
}

describe("PermissionMenu", () => {
  it("stages a boundary and applies it only on confirm", async () => {
    const onChange = vi.fn();
    const dialog = await openMenu(onChange);
    const boundaries = [...dialog.querySelectorAll('[role="radio"]')];
    expect(boundaries).toHaveLength(4);

    await click(boundaries[1]);
    expect(onChange).not.toHaveBeenCalled();

    const apply = buttonByText(dialog, "chat.permissionApply")!;
    await click(apply);
    expect(onChange).toHaveBeenCalledWith("readonlyAsk");
  });

  it("maps a staged switch to the real mode on confirm", async () => {
    const onChange = vi.fn();
    const dialog = await openMenu(onChange);
    const switches = [...dialog.querySelectorAll('[role="checkbox"]')];
    expect(switches).toHaveLength(3);

    await click(switches[1]);
    expect(onChange).not.toHaveBeenCalled();

    await click(buttonByText(dialog, "chat.permissionApply")!);
    expect(onChange).toHaveBeenCalledWith("dontAsk");
  });

  it("keeps legacy plan separate from the new plan boundary", async () => {
    const onChange = vi.fn();
    const dialog = await openMenu(onChange, "plan");
    const radios = [...dialog.querySelectorAll('[role="radio"]')];
    expect(radios).toHaveLength(5);
    expect(radios.filter((row) => row.getAttribute("aria-checked") === "true")).toEqual([
      radios[4],
    ]);

    await click(radios[2]);
    await click(buttonByText(dialog, "chat.permissionApply")!);
    expect(onChange).toHaveBeenCalledWith("planOnlyAsk");
  });

  it("discards the draft on cancel", async () => {
    const onChange = vi.fn();
    const dialog = await openMenu(onChange);
    await click(dialog.querySelectorAll('[role="radio"]')[1]);

    await click(buttonByText(dialog, "common.cancel")!);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("discards the draft on an outside press", async () => {
    const onChange = vi.fn();
    const dialog = await openMenu(onChange);
    await click(dialog.querySelectorAll('[role="radio"]')[1]);

    const outside = document.createElement("div");
    document.body.append(outside);
    await act(async () => {
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
    outside.remove();
  });
});

describe("PermissionMenu trigger toggle", () => {
  it("连续点击触发按钮交替打开与关闭，关闭不提交且重开重置草稿", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<PermissionMenu value="default" onChange={onChange} />);
    });
    const trigger = permissionTrigger();

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await activate(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
      await click(dialog.querySelectorAll('[role="radio"]')[1]);

      await activate(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(onChange).not.toHaveBeenCalled();

      await activate(trigger);
      const reopened = document.querySelector('[role="dialog"]') as HTMLElement;
      const radios = reopened.querySelectorAll('[role="radio"]');
      expect(radios[0].getAttribute("aria-checked")).toBe("true");
      expect(radios[1].getAttribute("aria-checked")).toBe("false");

      await activate(trigger);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
  });

  it("焦点回到触发按钮不提前关闭，松开后只关闭一次", async () => {
    await act(async () => {
      root.render(<PermissionMenu value="default" />);
    });
    const trigger = permissionTrigger();
    await activate(trigger);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await act(async () => {
      dialog.focus();
      trigger.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      trigger.focus();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
      trigger.click();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
