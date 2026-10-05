import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { AgentEditorDialog, type AgentEditorValue } from "./AgentEditorDialog";
import { TOOL_CATALOG_NAMES } from "@/features/agents/tool-catalog";

/**
 * The tool picker is a whitelist: a submit persists the checked set
 * explicitly — even when everything in the catalog is checked — so unlisted
 * built-ins (and future ones) stay denied under the identity's `--tools`.
 */
describe("AgentEditorDialog tool whitelist", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const actEnvironment = globalThis as {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    void i18n.changeLanguage("zh");
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(initial: { id: string; name: string; prompt: string }) {
    const onSubmit = vi.fn<(value: AgentEditorValue) => void>();
    act(() =>
      root.render(
        <AgentEditorDialog
          initial={initial}
          onSubmit={onSubmit}
          onCancel={() => {}}
        />,
      ),
    );
    return onSubmit;
  }

  function submit() {
    // ModalShell portals through react-aria to document.body.
    const form = document.querySelector("form");
    expect(form).toBeTruthy();
    act(() => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
  }

  it("saves the explicit full tool list even when everything is checked", () => {
    const onSubmit = render({ id: "a1", name: "审查员", prompt: "严格审查。" });
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]?.tools).toEqual([...TOOL_CATALOG_NAMES]);
  });

  it("saves an empty list when every tool is cleared", () => {
    const onSubmit = render({ id: "a1", name: "审查员", prompt: "严格审查。" });
    const clearButton = Array.from(document.querySelectorAll("button")).find(
      (button) =>
        button.textContent?.includes(i18n.t("settings.agentToolsClearAll")),
    );
    expect(clearButton).toBeTruthy();
    act(() => {
      clearButton?.click();
    });
    submit();
    expect(onSubmit.mock.calls[0]?.[0]?.tools).toEqual([]);
  });

  it("keeps a stored subset intact on an untouched submit", () => {
    const onSubmit = vi.fn<(value: AgentEditorValue) => void>();
    act(() =>
      root.render(
        <AgentEditorDialog
          initial={{
            id: "a2",
            name: "轻量",
            prompt: "只读。",
            tools: ["Read", "Grep"],
          }}
          onSubmit={onSubmit}
          onCancel={() => {}}
        />,
      ),
    );
    submit();
    expect(onSubmit.mock.calls[0]?.[0]?.tools).toEqual(["Read", "Grep"]);
  });
});
