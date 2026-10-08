import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { EnvFieldControl } from "./ProviderFormSections";
import { CLAUDE_ENV_GROUPS, type EnvField } from "./providerPresets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    renderTier("mid");
    expect(customInputs()).toHaveLength(0);
  });

  it("自定义取值出现输入框，且没有 1M 开关（后缀机制已移除）", () => {
    renderTier("claude-opus-5-5");
    const inputs = customInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].value).toBe("claude-opus-5-5");
    expect(tierContainer.querySelector('input[type="checkbox"]')).toBeNull();
  });
});
