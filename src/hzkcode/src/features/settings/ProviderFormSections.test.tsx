import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { EnvFieldControl } from "./ProviderFormSections";
import type { EnvField } from "./providerPresets";

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
