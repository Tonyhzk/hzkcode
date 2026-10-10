import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getAppSettings: async () => structuredClone(mocks.settings),
    updateAppSettings: async (next: Record<string, unknown>) => {
      mocks.settings = structuredClone(next);
    },
  },
}));

import { AssistantsSection } from "./AssistantsSection";
import { ServicesSection } from "./ServicesSection";
import { ToolsSection } from "./ToolsSection";
import { BehaviorPane } from "./agents-prompts/BehaviorPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver; the media tabs measure their thumb with it.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const inputValues = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLInputElement>("input")].map((el) => el.value);

describe("功能开关拆出的设置页", () => {
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

  async function render(element: React.ReactElement) {
    await act(async () => {
      root.render(element);
    });
  }

  it("工具页渲染搜索 / 多模态读取 / 任务与计划三张卡", async () => {
    mocks.settings = {
      cliEnv: {
        HZKCODE_ENABLE_WEB_SEARCH: "1",
        HZKCODE_READ_MODEL: "gemini-3-pro",
        HZKCODE_ENABLE_PLAN_MODE: "1",
      },
    };
    await render(<ToolsSection />);
    expect(inputValues(container)).toContain("gemini-3-pro");
    // Search master, plan mode and the image tab's OSS upload switch.
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
  });

  it("后台助手页渲染记忆 / 第二大脑 / 分类器三张卡", async () => {
    mocks.settings = {
      cliEnv: {
        HZKCODE_ENABLE_USER_MEMORY: "1",
        HZKCODE_MEMORY_MODEL: "mem-2",
        HZKCODE_ENABLE_SECOND_BRAIN: "1",
        HZKCODE_AUTO_MODE_MODEL: "mid",
      },
    };
    await render(<AssistantsSection />);
    const values = inputValues(container);
    expect(values).toContain("mem-2");
    expect(values).toContain("mid");
  });

  it("外部服务页渲染 OSS 与飞书凭据，密钥默认遮挡", async () => {
    mocks.settings = {
      cliEnv: {
        HZKCODE_OSS_ENDPOINT: "https://oss.example.com",
        HZKCODE_OSS_ACCESS_KEY_SECRET: "oss-secret",
        HZKCODE_FEISHU_APP_ID: "cli_app",
      },
    };
    await render(<ServicesSection />);
    expect(inputValues(container)).toContain("https://oss.example.com");
    expect(inputValues(container)).toContain("cli_app");
    // The secrets keep their values but render behind password inputs.
    const masked = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    ].map((el) => el.value);
    expect(masked).toContain("oss-secret");
    const plain = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="text"]'),
    ].map((el) => el.value);
    expect(plain).not.toContain("oss-secret");
  });

  it("行为标签渲染工作状态汇报与上下文加载", async () => {
    mocks.settings = {
      cliEnv: {
        HZKCODE_REPORT_WORK_STATUS: "3",
        HZKCODE_LOAD_PARENT_SKILLS: "1",
      },
    };
    await render(<BehaviorPane />);
    // Two cards: 2 selects + 4 selects, none of them free-text inputs.
    expect(container.querySelectorAll("button[aria-pressed]")).toHaveLength(0);
    expect(container.querySelectorAll("[aria-expanded]").length).toBeGreaterThan(0);
  });
});
