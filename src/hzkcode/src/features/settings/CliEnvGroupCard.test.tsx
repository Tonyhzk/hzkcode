import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { cliFeatureGroup } from "./cliFeatureEnv";
import { CliEnvGroupCard } from "./CliEnvGroupCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver (the tab switcher measures with it) and no
// CSS.escape (react-aria's listbox focus lookup calls it).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);
vi.stubGlobal("CSS", {
  ...(globalThis.CSS ?? {}),
  escape: (value: string) => value,
});

/** The Collapsible wrappers in render order; index 0 is the card body. */
const folds = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[style*="grid-template-rows"]')];

const opened = (fold: HTMLElement | undefined) =>
  fold?.style.gridTemplateRows === "1fr";

const pills = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];

const byText = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.trim() === text,
  );

const inputValues = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLInputElement>("input")].map((el) => el.value);

describe("CliEnvGroupCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    id: string,
    values: Record<string, string> = {},
    onChange: (envKey: string, value: string) => void = () => {},
  ) {
    act(() => {
      root.render(
        <CliEnvGroupCard
          group={cliFeatureGroup(id)}
          values={values}
          onChange={onChange}
        />,
      );
    });
  }

  it("主开关关闭时折叠正文，打开时展开并回传取值", () => {
    const onChange = vi.fn();
    render("memory", {}, onChange);
    expect(opened(folds(container)[0])).toBe(false);

    const master = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    act(() => master?.click());
    expect(onChange).toHaveBeenCalledWith("HZKCODE_ENABLE_USER_MEMORY", "1");

    render("memory", { HZKCODE_ENABLE_USER_MEMORY: "1" });
    expect(opened(folds(container)[0])).toBe(true);
  });

  it("高级设置默认折叠，存过值或点开后展开", () => {
    render("secondBrain", { HZKCODE_ENABLE_SECOND_BRAIN: "1" });
    // Body open, advanced folded: nothing stored beyond the master switch.
    expect(opened(folds(container)[0])).toBe(true);
    expect(opened(folds(container)[1])).toBe(false);

    const toggle = byText(container, i18n.t("settings.cliAdvanced"));
    act(() => toggle?.click());
    expect(opened(folds(container)[1])).toBe(true);

    render("secondBrain", {
      HZKCODE_ENABLE_SECOND_BRAIN: "1",
      HZKCODE_SECOND_BRAIN_INTERVAL_MS: "30000",
    });
    expect(opened(folds(container)[1])).toBe(true);
  });

  it("分段标签只渲染当前媒体的字段，切标签不改动取值", () => {
    const onChange = vi.fn();
    render(
      "mediaRead",
      { HZKCODE_READ_IMAGE_MODEL: "img-model", HZKCODE_READ_AUDIO_MODEL: "audio-model" },
      onChange,
    );
    expect(inputValues(container)).toContain("img-model");
    expect(inputValues(container)).not.toContain("audio-model");

    act(() => pills(container)[2]?.click());
    expect(inputValues(container)).toContain("audio-model");
    expect(inputValues(container)).not.toContain("img-model");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Perplexity 字段只在选中该搜索服务时出现，且密钥默认遮挡", () => {
    render("search", { HZKCODE_ENABLE_WEB_SEARCH: "1", HZKCODE_WEB_SEARCH_ADAPTER: "bing" });
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0);

    render("search", {
      HZKCODE_ENABLE_WEB_SEARCH: "1",
      HZKCODE_WEB_SEARCH_ADAPTER: "perplexity",
      HZKCODE_PERPLEXITY_API_KEY: "pplx-secret",
    });
    const secret = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(secret?.value).toBe("pplx-secret");
    const reveal = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (el) => el.className.includes("absolute right-2"),
    );
    act(() => reveal?.click());
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')).toBeNull();
  });
});
