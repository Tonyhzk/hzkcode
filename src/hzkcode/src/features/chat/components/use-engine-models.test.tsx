import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import type { EngineCatalog, EngineInfo } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { useEngineModels, type EngineModelsState } from "./use-engine-models";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getCliConfig: vi.fn(async () => ({})),
    getAppSettings: vi.fn(async () => ({})),
    listEngineModels: vi.fn(async () => ({ models: [], authoritative: false })),
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENGINE = { id: "omp", enabled: true, available: true } as EngineInfo;
// 模块级稳定引用:与应用内 zustand 提供的 engines 同形。探针记录存在 ref
// 里,数组身份抖动不再引发重复探测(见 use-engine-models 的探针 effect)。
const ENGINES = [ENGINE];
const WS_REMOTE = "//wsl$/Ubuntu/home/u/proj";

let container: HTMLDivElement;
let root: Root;
// 当前 render 的 engines(默认稳定引用;探针类用例按需替换)。
let engines: EngineInfo[] = ENGINES;
let latest: EngineModelsState;

const engineInfo = (id: string, available: boolean): EngineInfo => ({
  id,
  available,
  enabled: true,
  supportsImages: false,
  permissions: [],
});

const noopPin = async () => {};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  engines = ENGINES;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.mocked(ipc.listEngineModels).mockReset();
  vi.mocked(ipc.getCliConfig).mockResolvedValue({} as never);
});

function Harness({
  models,
  pinModels,
  workspacePath,
}: {
  models: Record<string, string>;
  pinModels: (updates: Record<string, string>, persist?: boolean) => Promise<void>;
  workspacePath?: string;
}) {
  latest = useEngineModels(engines, models, pinModels, {}, workspacePath);
  return null;
}

async function render(props: Parameters<typeof Harness>[0]) {
  await act(async () => {
    root.render(<Harness {...props} />);
    // 探针 promise 落地 + catalog 入 store 后的二次 effect 都跑完。
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** 让队列中的 promise 回调与随后的 re-render 全部落定:失控的探针循环
 *  会在这么长的窗口里打出成百上千次调用。 */
const settle = () =>
  act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 80);
    await promise;
  });

/** 探针类用例的渲染入口:可换 engines,渲染后等窗口落定。 */
async function show(next: EngineInfo[] | null, workspacePath?: string) {
  if (next) engines = next;
  await render({ models: {}, pinModels: noopPin, workspacePath });
  await settle();
}

describe("useEngineModels pin effect", () => {
  it("远端(remote)catalog 只做展示:永不触发 pin,不污染全局 models / persisted 默认", async () => {
    vi.mocked(ipc.listEngineModels).mockResolvedValue({
      models: [{ id: "remote-m1", name: "Remote M1" }],
      authoritative: true,
      remote: true,
    } as unknown as EngineCatalog);
    const pinModels = vi.fn(async () => {});
    // stored 与远端 catalog 不相交 —— 修复前这里会 volatile pin,进而在
    // 切回本地工作区时被 persisted pin 覆盖用户保存的默认模型。
    await render({ models: { omp: "user-pick" }, pinModels, workspacePath: WS_REMOTE });
    expect(pinModels).not.toHaveBeenCalled();
  });

  it("本地 authoritative catalog 仍重置过期 stored pick(persist 默认值不变)", async () => {
    vi.mocked(ipc.listEngineModels).mockResolvedValue({
      models: [{ id: "m1", name: "M1" }],
      authoritative: true,
    } as unknown as EngineCatalog);
    const pinModels = vi.fn(async () => {});
    await render({ models: { omp: "stale-id" }, pinModels });
    expect(pinModels).toHaveBeenCalledWith({ omp: "m1" });
  });
});

describe("useEngineModels probe dispatch", () => {
  it("探针失败只派发一次:不会被 pending 抖动反复重发", async () => {
    vi.mocked(ipc.listEngineModels).mockRejectedValue(new Error("DSH host 未运行"));
    await show([engineInfo("dsh", true)]);
    expect(ipc.listEngineModels).toHaveBeenCalledTimes(1);
    expect(latest.pendingEngines).toEqual({});
  });

  it("另一引擎的 catalog 落地不会连带重试失败引擎", async () => {
    vi.mocked(ipc.listEngineModels).mockImplementation(async (id: string) => {
      if (id === "dsh") throw new Error("DSH host 未运行");
      return { models: [{ id: "pi/m1", provider: "pi" }], authoritative: true };
    });
    await show([engineInfo("dsh", true), engineInfo("pi", true)]);
    expect(ipc.listEngineModels).toHaveBeenCalledTimes(2);
    expect(latest.catalogs.pi?.models[0]?.id).toBe("pi/m1");
    await settle();
    expect(ipc.listEngineModels).toHaveBeenCalledTimes(2);
  });

  it("refresh 重探所有引擎(失败者也算)", async () => {
    vi.mocked(ipc.listEngineModels).mockRejectedValue(new Error("down"));
    await show([engineInfo("dsh", true)]);
    expect(ipc.listEngineModels).toHaveBeenCalledTimes(1);
    vi.mocked(ipc.listEngineModels).mockResolvedValue({
      models: [{ id: "deepseek/x", provider: "deepseek" }],
      authoritative: true,
    });
    await act(async () => {
      await latest.refresh();
    });
    expect(ipc.listEngineModels).toHaveBeenCalledTimes(2);
    expect(latest.catalogs.dsh?.models[0]?.id).toBe("deepseek/x");
  });

  it("引擎可用性翻转后允许再探一次", async () => {
    vi.mocked(ipc.listEngineModels).mockRejectedValue(new Error("missing CLI"));
    await show([engineInfo("dsh", false)]);
    expect(ipc.listEngineModels).toHaveBeenCalledTimes(1);
    await show([engineInfo("dsh", true)]);
    expect(ipc.listEngineModels).toHaveBeenCalledTimes(2);
  });

  it("探针记录按工作区隔离", async () => {
    vi.mocked(ipc.listEngineModels).mockRejectedValue(new Error("down"));
    await show([engineInfo("dsh", true)], "/ws-a");
    expect(ipc.listEngineModels).toHaveBeenCalledTimes(1);
    await show(null, "/ws-b");
    expect(ipc.listEngineModels).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ipc.listEngineModels).mock.calls.map((call) => call[1])).toEqual([
      "/ws-a",
      "/ws-b",
    ]);
  });
});

describe("useEngineModels tier display names", () => {
  it("档位显示当前渠道配置的模型名（而不是别名），未映射档位保持目录名", async () => {
    vi.mocked(ipc.listEngineModels).mockResolvedValue({
      models: [
        { id: "default", name: "Default" },
        { id: "opus", name: "Opus", description: "Opus 4.5" },
        { id: "sonnet", name: "Sonnet", description: "Sonnet 4.5" },
        { id: "haiku", name: "Haiku" },
      ],
      authoritative: false,
    } as unknown as EngineCatalog);
    vi.mocked(ipc.getCliConfig).mockResolvedValue({
      claude: {
        current: "relay",
        providers: {
          relay: {
            settingsConfig: {
              env: {
                HZKCODE_DEFAULT_HIGH_MODEL: "deepseek-v4-pro[1m]",
                HZKCODE_DEFAULT_MID_MODEL: "deepseek-v4.1-flash[1m]",
              },
            },
          },
        },
      },
    } as never);
    await show([engineInfo("claude", true)]);
    const byId = new Map(latest.modelsByEngine.claude.map((m) => [m.id, m]));
    // Mapped tiers carry the "[tier]" tag so the rows stay tellable apart
    // even when two tiers resolve to the same model.
    expect(byId.get("opus")?.label).toBe("[opus]deepseek-v4-pro[1m]");
    expect(byId.get("sonnet")?.label).toBe("[sonnet]deepseek-v4.1-flash[1m]");
    // The catalog's built-in-model description would contradict the mapped
    // name, so it is dropped for mapped tiers only.
    expect(byId.get("sonnet")?.description).toBeUndefined();
    expect(byId.get("opus")?.description).toBeUndefined();
    // The default alias has no explicit model configured, so it stands for
    // the high tier (the CLI's "留空走高阶" fallback) and shows the bare
    // model name (no tag: it is the hidden internal fallback).
    expect(byId.get("default")?.label).toBe("deepseek-v4-pro[1m]");
    expect(byId.get("default")?.description).toBeUndefined();
    // Unmapped tiers keep the catalog presentation untouched.
    expect(byId.get("haiku")?.label).toBe("Haiku");
  });

  it("默认档优先显示显式配置的模型，高阶层回退不遮住它", async () => {
    vi.mocked(ipc.listEngineModels).mockResolvedValue({
      models: [{ id: "default", name: "Default" }],
      authoritative: false,
    } as unknown as EngineCatalog);
    vi.mocked(ipc.getCliConfig).mockResolvedValue({
      claude: {
        current: "relay",
        providers: {
          relay: {
            settingsConfig: {
              env: {
                HZKCODE_MODEL: "glm-5.2",
                HZKCODE_DEFAULT_HIGH_MODEL: "deepseek-v4-pro[1m]",
              },
            },
          },
        },
      },
    } as never);
    await show([engineInfo("claude", true)]);
    const byId = new Map(latest.modelsByEngine.claude.map((m) => [m.id, m]));
    expect(byId.get("default")?.label).toBe("glm-5.2");
  });

  it("渠道配置在扁平 env 形状里同样生效", async () => {
    vi.mocked(ipc.listEngineModels).mockResolvedValue({
      models: [{ id: "sonnet", name: "Sonnet" }],
      authoritative: false,
    } as unknown as EngineCatalog);
    vi.mocked(ipc.getCliConfig).mockResolvedValue({
      claude: {
        current: "relay",
        providers: {
          relay: { env: { HZKCODE_DEFAULT_MID_MODEL: "glm-5.2[1m]" } },
        },
      },
    } as never);
    await show([engineInfo("claude", true)]);
    const sonnet = latest.modelsByEngine.claude.find((m) => m.id === "sonnet");
    expect(sonnet?.label).toBe("[sonnet]glm-5.2[1m]");
  });
});

describe("useEngineModels default normalization", () => {
  const CLAUDE_CATALOG = {
    models: [
      { id: "default", name: "Default" },
      { id: "opus", name: "Opus" },
      { id: "sonnet", name: "Sonnet" },
    ],
    authoritative: false,
  };

  it("回落时把 stored=default 归一化到 opus 档", async () => {
    engines = [engineInfo("claude", true)];
    vi.mocked(ipc.listEngineModels).mockResolvedValue(
      CLAUDE_CATALOG as unknown as EngineCatalog,
    );
    const pinModels = vi.fn(async () => {});
    // 渠道没有显式默认模型：default 即高阶层（留空走高阶），归一化让选择器
    // 能标出当前档位。
    vi.mocked(ipc.getCliConfig).mockResolvedValue({
      claude: {
        current: "relay",
        providers: {
          relay: {
            settingsConfig: { env: { HZKCODE_DEFAULT_HIGH_MODEL: "deepseek-v4-pro[1m]" } },
          },
        },
      },
    } as never);
    await render({ models: { claude: "default" }, pinModels });
    expect(pinModels).toHaveBeenCalledWith({ claude: "opus" });
  });

  it("渠道配了显式默认模型时保持 default", async () => {
    engines = [engineInfo("claude", true)];
    vi.mocked(ipc.listEngineModels).mockResolvedValue(
      CLAUDE_CATALOG as unknown as EngineCatalog,
    );
    const pinModels = vi.fn(async () => {});
    vi.mocked(ipc.getCliConfig).mockResolvedValue({
      claude: {
        current: "relay",
        providers: {
          relay: { settingsConfig: { env: { HZKCODE_MODEL: "glm-5.2" } } },
        },
      },
    } as never);
    await render({ models: { claude: "default" }, pinModels });
    expect(pinModels).not.toHaveBeenCalled();
  });

  it("新会话没有 stored 时 pin 到第一个真实档位而非 default", async () => {
    engines = [engineInfo("claude", true)];
    vi.mocked(ipc.listEngineModels).mockResolvedValue(
      CLAUDE_CATALOG as unknown as EngineCatalog,
    );
    const pinModels = vi.fn(async () => {});
    await render({ models: {}, pinModels });
    expect(pinModels).toHaveBeenCalledWith({ claude: "opus" });
  });
});
