import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import { Select, SelectItem } from "@/components/base/select/select";
import { usePopoverState } from "@/utils/use-dismiss-on-outside-press";
import { Dropdown, DropdownItem, DropdownPopover, DropdownTrigger } from "./dropdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 不提供 CSS.escape，React Aria 的列表自动聚焦会用它拼选择器。
const cssGlobal = globalThis as unknown as {
  CSS?: { escape: (value: string) => string };
};
if (!cssGlobal.CSS) {
  cssGlobal.CSS = {
    escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function triggerButton() {
  return container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
}

function listbox() {
  return document.querySelector<HTMLElement>('[role="listbox"]');
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;
  readonly pointerId = 1;
  readonly width = 1;
  readonly height = 1;
  readonly isPrimary = true;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
  }
}

function pointerEvent(type: "pointerdown" | "pointerup", buttons: number, pointerType = "mouse") {
  return new TestPointerEvent(type, { bubbles: true, button: 0, buttons, pointerType });
}

function clickEvent() {
  return new MouseEvent("click", { bubbles: true, button: 0, detail: 1 });
}

async function activate(element: HTMLElement, pointerType = "mouse") {
  // 分开发送事件，让 React 提交失焦导致的更新，而不是把整次按压合并处理。
  await act(async () => {
    element.dispatchEvent(pointerEvent("pointerdown", 1, pointerType));
    element.focus();
  });
  await act(async () => {
    element.dispatchEvent(pointerEvent("pointerup", 0, pointerType));
    element.dispatchEvent(clickEvent());
  });
}

async function pressOutside() {
  await act(async () => {
    document.body.dispatchEvent(pointerEvent("pointerdown", 1));
  });
}

async function pressEscape(target: HTMLElement) {
  await act(async () => {
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

async function renderSelect() {
  const onSelectionChange = vi.fn();
  await render(
    <Select aria-label="测试选择" onSelectionChange={onSelectionChange}>
      <SelectItem id="a">选项 A</SelectItem>
      <SelectItem id="b">选项 B</SelectItem>
    </Select>,
  );
  return onSelectionChange;
}

function DropdownHarness({ onSelect }: { onSelect: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const select = () => {
    onSelect();
    setIsOpen(false);
  };
  return (
    <Dropdown isOpen={isOpen} onOpenChange={setIsOpen}>
      <DropdownTrigger>操作</DropdownTrigger>
      <DropdownPopover aria-label="测试菜单">
        <DropdownItem onSelect={select}>第一项</DropdownItem>
        <DropdownItem onSelect={select}>第二项</DropdownItem>
      </DropdownPopover>
    </Dropdown>
  );
}

function PopoverHarness({ onAction }: { onAction: () => void }) {
  const { isOpen, triggerRef, popoverRef, setOpen, shouldCloseOnInteractOutside } =
    usePopoverState();
  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={setOpen}>
      <AriaButton ref={triggerRef}>菜单</AriaButton>
      <AriaPopover
        ref={popoverRef}
        isNonModal
        shouldCloseOnInteractOutside={shouldCloseOnInteractOutside}
      >
        <AriaDialog aria-label="测试菜单">
          <button type="button" onClick={onAction}>
            内部操作
          </button>
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}

describe("基础 Select", () => {
  it("触摸连续开关保留原生切换行为", async () => {
    await renderSelect();
    const trigger = triggerButton();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await activate(trigger, "touch");
      expect(listbox()).not.toBeNull();
      await activate(trigger, "touch");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(listbox()).toBeNull();
    }
  });

  it("键盘 Enter 连续开关不会重复切换", async () => {
    await renderSelect();
    const trigger = triggerButton();
    for (const open of [true, false, true, false]) {
      await act(async () => {
        trigger.focus();
        trigger.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", bubbles: true, cancelable: true,
        }));
      });
      await act(async () => {
        trigger.dispatchEvent(new KeyboardEvent("keyup", {
          key: "Enter", code: "Enter", bubbles: true, cancelable: true,
        }));
      });
      expect(trigger.getAttribute("aria-expanded")).toBe(String(open));
      expect(Boolean(listbox())).toBe(open);
    }
  });

  it("连续三轮开关只切换一次", async () => {
    await renderSelect();
    const trigger = triggerButton();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await activate(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(listbox()).not.toBeNull();
      await act(async () => listbox()!.focus());
      await activate(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(listbox()).toBeNull();
    }
  });

  it("长按触发按钮只关闭一次并能再次打开", async () => {
    await renderSelect();
    const trigger = triggerButton();
    await activate(trigger);
    await act(async () => listbox()!.focus());
    await act(async () => {
      trigger.dispatchEvent(pointerEvent("pointerdown", 1));
      trigger.focus();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(listbox()).toBeNull();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    await act(async () => {
      trigger.dispatchEvent(pointerEvent("pointerup", 0));
      trigger.dispatchEvent(clickEvent());
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(listbox()).toBeNull();
    await activate(trigger);
    expect(listbox()).not.toBeNull();
  });

  it("外部按压关闭且可以立即重开", async () => {
    await renderSelect();
    const trigger = triggerButton();
    await activate(trigger);
    expect(listbox()).not.toBeNull();
    await pressOutside();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(listbox()).toBeNull();
    await activate(trigger);
    expect(listbox()).not.toBeNull();
  });

  it("Esc 关闭后可再次打开", async () => {
    await renderSelect();
    const trigger = triggerButton();
    await activate(trigger);
    await pressEscape(listbox()!);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(listbox()).toBeNull();
    await activate(trigger);
    expect(listbox()).not.toBeNull();
  });

  it("内部按压保持打开，选择回调只触发一次并关闭", async () => {
    const onSelectionChange = await renderSelect();
    const trigger = triggerButton();
    await activate(trigger);
    await act(async () => {
      listbox()!.dispatchEvent(pointerEvent("pointerdown", 1));
    });
    expect(listbox()).not.toBeNull();

    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === "选项 B",
    )!;
    await activate(option);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith("b");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(listbox()).toBeNull();
  });
});

describe("基础 Dropdown", () => {
  async function renderDropdown() {
    const onSelect = vi.fn();
    await render(<DropdownHarness onSelect={onSelect} />);
    return onSelect;
  }

  it("连续三轮开关只切换一次", async () => {
    await renderDropdown();
    const trigger = triggerButton();
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

  it("长按触发按钮只关闭一次并能再次打开", async () => {
    await renderDropdown();
    const trigger = triggerButton();
    await activate(trigger);
    await act(async () => dialog()!.focus());
    await act(async () => {
      trigger.dispatchEvent(pointerEvent("pointerdown", 1));
      trigger.focus();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog()).not.toBeNull();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    await act(async () => {
      trigger.dispatchEvent(pointerEvent("pointerup", 0));
      trigger.dispatchEvent(clickEvent());
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
    await activate(trigger);
    expect(dialog()).not.toBeNull();
  });

  it("外部按压关闭且可以立即重开", async () => {
    await renderDropdown();
    const trigger = triggerButton();
    await activate(trigger);
    expect(dialog()).not.toBeNull();
    await pressOutside();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
    await activate(trigger);
    expect(dialog()).not.toBeNull();
  });

  it("Esc 关闭后可再次打开", async () => {
    await renderDropdown();
    const trigger = triggerButton();
    await activate(trigger);
    await pressEscape(dialog()!);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
    await activate(trigger);
    expect(dialog()).not.toBeNull();
  });

  it("内部按压保持打开，菜单项回调只触发一次并关闭", async () => {
    const onSelect = await renderDropdown();
    const trigger = triggerButton();
    await activate(trigger);
    await act(async () => {
      dialog()!.dispatchEvent(pointerEvent("pointerdown", 1));
    });
    expect(dialog()).not.toBeNull();

    const item = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "第二项",
    )!;
    await activate(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
  });
});

describe("usePopoverState", () => {
  async function renderHarness() {
    const onAction = vi.fn();
    await render(<PopoverHarness onAction={onAction} />);
    return onAction;
  }

  it("连续三轮开关只切换一次", async () => {
    await renderHarness();
    const trigger = triggerButton();
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

  it("长按触发按钮只关闭一次并能再次打开", async () => {
    await renderHarness();
    const trigger = triggerButton();
    await activate(trigger);
    await act(async () => dialog()!.focus());
    await act(async () => {
      trigger.dispatchEvent(pointerEvent("pointerdown", 1));
      trigger.focus();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog()).not.toBeNull();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    await act(async () => {
      trigger.dispatchEvent(pointerEvent("pointerup", 0));
      trigger.dispatchEvent(clickEvent());
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
    await activate(trigger);
    expect(dialog()).not.toBeNull();
  });

  it("外部按压关闭且可以立即重开", async () => {
    await renderHarness();
    const trigger = triggerButton();
    await activate(trigger);
    expect(dialog()).not.toBeNull();
    await pressOutside();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
    await activate(trigger);
    expect(dialog()).not.toBeNull();
  });

  it("Esc 关闭后可再次打开", async () => {
    await renderHarness();
    const trigger = triggerButton();
    await activate(trigger);
    await pressEscape(dialog()!);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
    await activate(trigger);
    expect(dialog()).not.toBeNull();
  });

  it("内部按压保持打开，内部操作回调只触发一次", async () => {
    const onAction = await renderHarness();
    const trigger = triggerButton();
    await activate(trigger);
    await act(async () => {
      dialog()!.dispatchEvent(pointerEvent("pointerdown", 1));
    });
    expect(dialog()).not.toBeNull();

    const action = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "内部操作",
    )!;
    await activate(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(dialog()).not.toBeNull();
  });
});
