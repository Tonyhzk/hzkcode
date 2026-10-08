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

const ENGINE = { id: "omp", available: true } as EngineInfo;
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
        { id: "high", name: "High", description: "Opus 4.7" },
        { id: "mid", name: "Mid", description: "Sonnet 4.5" },
        { id: "low", name: "Low" },
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
    // even when two tiers resolve to the same model. The retired [1m]
    // suffix strips off the displayed value.
    expect(byId.get("high")?.label).toBe("[High]deepseek-v4-pro");
    expect(byId.get("mid")?.label).toBe("[Mid]deepseek-v4.1-flash");
    // The catalog's built-in-model description would contradict the mapped
    // name, so it is dropped for mapped tiers only.
    expect(byId.get("mid")?.description).toBeUndefined();
    expect(byId.get("high")?.description).toBeUndefined();
    // The default alias has no explicit model configured, so it stands for
    // the mid tier (the app's default tier) and shows the bare model name
    // (no tag: it is the hidden internal fallback).
    expect(byId.get("default")?.label).toBe("deepseek-v4.1-flash");
    expect(byId.get("default")?.description).toBeUndefined();
    // Unmapped tiers keep the catalog presentation untouched.
    expect(byId.get("low")?.label).toBe("Low");
  });

  it("默认档存的是档位别名时解析成该档映射的模型", async () => {
    // The dialog's default-model picker stores tier aliases; the default row
    // must display the mapped model, not the bare "mid" (here via a legacy
    // "sonnet" spelling, which normalizes on read).
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
                HZKCODE_MODEL: "sonnet",
                HZKCODE_DEFAULT_MID_MODEL: "deepseek-v4.1-flash[1m]",
              },
            },
          },
        },
      },
    } as never);
    await show([engineInfo("claude", true)]);
    const byId = new Map(latest.modelsByEngine.claude.map((m) => [m.id, m]));
    expect(byId.get("default")?.label).toBe("deepseek-v4.1-flash");
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
      models: [{ id: "mid", name: "Mid" }],
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
    const mid = latest.modelsByEngine.claude.find((m) => m.id === "mid");
    expect(mid?.label).toBe("[Mid]glm-5.2");
  });
});

describe("useEngineModels default normalization", () => {
  const CLAUDE_CATALOG = {
    models: [
      { id: "default", name: "Default" },
      { id: "high", name: "High" },
      { id: "mid", name: "Mid" },
    ],
    authoritative: false,
  };

  it("目录为空或缺失时，渠道已映射档位仍生成选项（标签用映射模型）", async () => {
    // 探针返回空目录（或失败）时，档位别名不能从列表里消失：渠道默认
    // 值就是这些别名，找到不它就会退回显示引擎名。
    vi.mocked(ipc.listEngineModels).mockResolvedValue({
      models: [],
      authoritative: true,
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
    expect(byId.get("mid")?.label).toBe("[Mid]deepseek-v4.1-flash");
    expect(byId.get("high")?.label).toBe("[High]deepseek-v4-pro");
    expect(byId.get("low")).toBeUndefined();
    // 就绪判定此时已成立（配置与目录都返回），档位别名也必须被判定为可服务。
    expect(latest.readyEngines.claude).toBe(true);
    expect(latest.sessionIdsByEngine.claude?.has("mid")).toBe(true);
  });

  it("回落时把 stored=default 归一化到中档档位", async () => {
    engines = [engineInfo("claude", true)];
    vi.mocked(ipc.listEngineModels).mockResolvedValue(
      CLAUDE_CATALOG as unknown as EngineCatalog,
    );
    const pinModels = vi.fn(async () => {});
    // 渠道没有显式默认模型：default 即中阶层（应用默认档），归一化让选择器
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
    expect(pinModels).toHaveBeenCalledWith({ claude: "mid" });
  });

  it("stored 是旧别名时先归一写回（不按失效重置）", async () => {
    engines = [engineInfo("claude", true)];
    vi.mocked(ipc.listEngineModels).mockResolvedValue(
      CLAUDE_CATALOG as unknown as EngineCatalog,
    );
    const pinModels = vi.fn(async () => {});
    await render({ models: { claude: "sonnet" }, pinModels });
    expect(pinModels).toHaveBeenCalledWith({ claude: "mid" });
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

  it("新会话没有 stored 时 pin 到中档档位而非 default", async () => {
    engines = [engineInfo("claude", true)];
    vi.mocked(ipc.listEngineModels).mockResolvedValue(
      CLAUDE_CATALOG as unknown as EngineCatalog,
    );
    const pinModels = vi.fn(async () => {});
    await render({ models: {}, pinModels });
    expect(pinModels).toHaveBeenCalledWith({ claude: "mid" });
  });

  it("就绪门槛要求渠道配置与目录都已加载", async () => {
    engines = [engineInfo("claude", true)];
    vi.mocked(ipc.listEngineModels).mockResolvedValue(
      CLAUDE_CATALOG as unknown as EngineCatalog,
    );
    // 目录先返回、渠道配置延迟：此时选择器的渠道自定义模型还不可知，
    // 不能把合法选择判为失效（就绪前不做清理判定）。
    const { promise: configGate, resolve: releaseConfig } =
      Promise.withResolvers<unknown>();
    vi.mocked(ipc.getCliConfig).mockReturnValue(configGate as never);
    await render({ models: { claude: "claude-opus-5-5" }, pinModels: noopPin });
    expect(latest.readyEngines).toEqual({});
    await act(async () => {
      releaseConfig({});
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest.readyEngines).toEqual({ claude: true });
  });
});
