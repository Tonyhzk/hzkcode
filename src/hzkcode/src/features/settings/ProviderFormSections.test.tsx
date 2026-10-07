import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { EnvFieldControl } from "./ProviderFormSections";
import { CLAUDE_ENV_GROUPS, type EnvField } from "./providerPresets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MODEL_FIELD: EnvField = {
  envKey: "HZKCODE_MODEL",
  kind: "text",
  labelKey: "settings.cliFieldDefaultModel",
  oneM: true,
};

describe("EnvFieldControl 1M switch", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(value: string, onChange = vi.fn()) {
    act(() => {
      root.render(<EnvFieldControl field={MODEL_FIELD} value={value} onChange={onChange} />);
    });
    return onChange;
  }

  function switchInput(): HTMLInputElement {
    const input = container.querySelector('input[type="checkbox"]');
    if (!input) throw new Error("switch input not found");
    return input as HTMLInputElement;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("appends [1m] when switched on", () => {
    const onChange = render("deepseek-v4.1-flash");
    expect(switchInput().checked).toBe(false);
    act(() => switchInput().click());
    expect(onChange).toHaveBeenCalledWith("deepseek-v4.1-flash[1m]");
  });

  it("replaces another trailing suffix with [1m]", () => {
    const onChange = render("model-x[2m]");
    act(() => switchInput().click());
    expect(onChange).toHaveBeenCalledWith("model-x[1m]");
  });

  it("shows checked for a [1m] value and strips it when switched off", () => {
    const onChange = render("model-x[1m]");
    expect(switchInput().checked).toBe(true);
    act(() => switchInput().click());
    expect(onChange).toHaveBeenCalledWith("model-x");
  });

  it("disables the switch while the field is empty", () => {
    render("");
    expect(switchInput().disabled).toBe(true);
  });
});

/** 渠道对话框真实 schema 里的默认模型字段（档位下拉）。 */
const TIER_FIELD: EnvField = CLAUDE_ENV_GROUPS.flatMap((g) => g.fields).find(
  (f) => f.envKey === "HZKCODE_MODEL",
)!;

describe("EnvFieldControl 默认模型档位下拉", () => {
  let tierContainer: HTMLDivElement;
  let tierRoot: Root;

  beforeEach(() => {
    tierContainer = document.createElement("div");
    document.body.appendChild(tierContainer);
    tierRoot = createRoot(tierContainer);
  });

  afterEach(() => {
    act(() => tierRoot.unmount());
    tierContainer.remove();
  });

  function renderTier(value: string, onChange = vi.fn()) {
    act(() => {
      tierRoot.render(
        <EnvFieldControl field={TIER_FIELD} value={value} onChange={onChange} />,
      );
    });
    return onChange;
  }

  function customInputs(): HTMLInputElement[] {
    return [...tierContainer.querySelectorAll("input")].filter(
      (el) => (el as HTMLInputElement).type !== "checkbox",
    ) as HTMLInputElement[];
  }

  it("档位取值不出现自定义输入框（未设置时按中阶档展示）", () => {
    renderTier("");
    expect(customInputs()).toHaveLength(0);
    renderTier("sonnet");
    expect(customInputs()).toHaveLength(0);
  });

  it("自定义取值出现输入框，1M 开关作用于该值", () => {
    const onChange = renderTier("claude-opus-5-5");
    const inputs = customInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].value).toBe("claude-opus-5-5");
    const checkbox = tierContainer.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    act(() => checkbox.click());
    expect(onChange).toHaveBeenCalledWith("claude-opus-5-5[1m]");
  });
});
