import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCliEnv, type CliEnvStore } from "./useCliEnv";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Whole-settings store standing in for the backend. */
const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  /** Read latency: the snapshot is taken at call time, returned later. */
  readDelayMs: 0,
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getAppSettings: async () => {
      const snapshot = structuredClone(mocks.settings);
      if (mocks.readDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, mocks.readDelayMs));
      }
      return snapshot;
    },
    updateAppSettings: async (next: Record<string, unknown>) => {
      mocks.settings = structuredClone(next);
    },
  },
}));

function Harness({ store }: { store: { current: CliEnvStore | null } }) {
  store.current = useCliEnv();
  return null;
}

describe("useCliEnv", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const store: { current: CliEnvStore | null } = { current: null };

  beforeEach(() => {
    vi.useFakeTimers();
    store.current = null;
    mocks.readDelayMs = 0;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    vi.useRealTimers();
  });

  async function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<Harness store={store} />);
    });
  }

  const flushDebounce = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
  };

  const savedEnv = () =>
    (mocks.settings.cliEnv ?? {}) as Record<string, string>;

  it("写入前重读最新设置，只合并改动过的键", async () => {
    mocks.settings = {
      cliEnv: { HZKCODE_ENABLE_WEB_SEARCH: "1" },
      systemProxyUrl: "http://127.0.0.1:7890",
    };
    await mount();
    // While our edit is still debouncing, another page writes a cliEnv key
    // and the proxy page saves a URL.
    mocks.settings.cliEnv = {
      HZKCODE_ENABLE_WEB_SEARCH: "1",
      HZKCODE_REPORT_WORK_STATUS: "2",
    };
    mocks.settings.systemProxyEnabled = true;

    act(() => store.current?.setEnv("HZKCODE_MEMORY_MODEL", "mem-1"));
    await flushDebounce();

    expect(savedEnv()).toEqual({
      HZKCODE_ENABLE_WEB_SEARCH: "1",
      HZKCODE_REPORT_WORK_STATUS: "2",
      HZKCODE_MEMORY_MODEL: "mem-1",
    });
    expect(mocks.settings.systemProxyEnabled).toBe(true);
    expect(mocks.settings.systemProxyUrl).toBe("http://127.0.0.1:7890");
  });

  it("清空的值从 cliEnv 里删除", async () => {
    mocks.settings = { cliEnv: { HZKCODE_MEMORY_MODEL: "mem-1" } };
    await mount();

    act(() => store.current?.setEnv("HZKCODE_MEMORY_MODEL", ""));
    await flushDebounce();

    expect(savedEnv()).toEqual({});
  });

  it("卸载时立刻写入还没到防抖时间的改动", async () => {
    mocks.settings = { cliEnv: {} };
    await mount();

    act(() => store.current?.setEnv("HZKCODE_WEB_SEARCH_ADAPTER", "tavily"));
    act(() => root?.unmount());
    root = null;
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });

    expect(savedEnv()).toEqual({ HZKCODE_WEB_SEARCH_ADAPTER: "tavily" });
  });

  it("两个实例同时写入时串行执行，慢读取下两边改动都保留", async () => {
    mocks.settings = { cliEnv: {} };
    const other: { current: CliEnvStore | null } = { current: null };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <>
          <Harness store={store} />
          <Harness store={other} />
        </>,
      );
    });
    mocks.readDelayMs = 100;

    act(() => {
      store.current?.setEnv("HZKCODE_MEMORY_MODEL", "mem-1");
      other.current?.setEnv("HZKCODE_PROXY_URL", "http://127.0.0.1:10808");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(savedEnv()).toEqual({
      HZKCODE_MEMORY_MODEL: "mem-1",
      HZKCODE_PROXY_URL: "http://127.0.0.1:10808",
    });
  });
});
