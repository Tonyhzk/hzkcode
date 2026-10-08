import { describe, expect, it } from "vitest";
import type { CliConfig, EngineCatalog } from "@/lib/ipc";
import { PSEUDO_LOCAL } from "@/features/settings/providers";
import {
  channelDefaultPick,
  channelSelectableIds,
  channelTierModels,
  computeChannelDefaults,
  findChannelDefault,
} from "./channel-defaults";

type Env = Record<string, string>;

function config(
  channels: Record<string, Env>,
  current = "relay",
): CliConfig {
  const providers: Record<string, unknown> = {};
  for (const [id, env] of Object.entries(channels)) {
    providers[id] = { settingsConfig: { env } };
  }
  return { claude: { current, providers } } as unknown as CliConfig;
}

describe("channelDefaultPick", () => {
  it("显式默认模型优先", () => {
    const cfg = config({
      relay: {
        HZKCODE_MODEL: "glm-5.2",
        HZKCODE_DEFAULT_HIGH_MODEL: "high-x",
        HZKCODE_DEFAULT_MID_MODEL: "mid-x",
      },
    });
    expect(channelDefaultPick("claude", cfg, "relay")).toBe("glm-5.2");
  });

  it("选中阶但中阶未映射时继续兜底（不落到裸别名）", () => {
    // 下拉框把档位别名写进 HZKCODE_MODEL（如 "mid"）；该档未映射时裸别名
    // 会解析到 CLI 内置的家族模型（中转站未必提供），必须继续沿档位阶梯
    // 取已配置的值。读数同时剥离退役的 [1m] 后缀。
    const cfg = config({
      relay: {
        HZKCODE_MODEL: "mid",
        HZKCODE_DEFAULT_HIGH_MODEL: "deepseek-v4-pro[1m]",
      },
    });
    expect(channelDefaultPick("claude", cfg, "relay")).toBe("high");
    // 默认档的展示同样跳过未映射别名，显示高阶映射的具体模型。
    expect(channelTierModels("claude", cfg, "relay").default).toBe(
      "deepseek-v4-pro",
    );
    // 别名映射存在时保持别名（发送与显示一致）。
    const mapped = config({
      relay: {
        HZKCODE_MODEL: "mid",
        HZKCODE_DEFAULT_MID_MODEL: "deepseek-v4.1-flash[1m]",
      },
    });
    expect(channelDefaultPick("claude", mapped, "relay")).toBe("mid");
    expect(channelTierModels("claude", mapped, "relay").default).toBe(
      "deepseek-v4.1-flash",
    );
    // 仅自定义有值时落到自定义列表首项。
    const customOnly = {
      claude: {
        current: "relay",
        providers: {
          relay: {
            customModels: ["claude-opus-5-5"],
            settingsConfig: { env: { HZKCODE_MODEL: "mid" } },
          },
        },
      },
    } as unknown as CliConfig;
    expect(channelDefaultPick("claude", customOnly, "relay")).toBe(
      "claude-opus-5-5",
    );
  });

  it("存量旧别名读数归一为新档位", () => {
    // 3.1.0 渠道记录的 HZKCODE_MODEL 可能是旧别名；读取时归一为新拼写，
    // 避免旧值被判成失效或被当作字面模型名。
    const cfg = config({
      relay: {
        HZKCODE_MODEL: "sonnet",
        HZKCODE_DEFAULT_HIGH_MODEL: "high-x",
      },
    });
    expect(channelDefaultPick("claude", cfg, "relay")).toBe("high");
    expect(channelTierModels("claude", cfg, "relay").high).toBe("high-x");
  });

  it("档位拼写的绑定视为无效（与注入端一致）", () => {
    const cfg = config({
      relay: {
        HZKCODE_DEFAULT_HIGH_MODEL: "sonnet",
        HZKCODE_DEFAULT_MID_MODEL: "mid-x",
      },
    });
    const tiers = channelTierModels("claude", cfg, "relay");
    expect(tiers.high).toBeUndefined();
    expect(tiers.mid).toBe("mid-x");
    expect(channelDefaultPick("claude", cfg, "relay")).toBe("mid");
    const ids = channelSelectableIds("claude", cfg, "relay", undefined);
    expect(ids.has("high")).toBe(false);
    expect(ids.has("mid")).toBe(true);
  });

  it("按 中 → 高 → 低 的档位顺序兜底", () => {
    // Mid mapped: the default tier wins even though High is configured too.
    expect(
      channelDefaultPick(
        "claude",
        config({
          relay: {
            HZKCODE_DEFAULT_HIGH_MODEL: "high-x",
            HZKCODE_DEFAULT_MID_MODEL: "mid-x",
            HZKCODE_DEFAULT_LOW_MODEL: "low-x",
          },
        }),
        "relay",
      ),
    ).toBe("mid");
    // Mid missing: High takes over, then Low.
    expect(
      channelDefaultPick(
        "claude",
        config({ relay: { HZKCODE_DEFAULT_HIGH_MODEL: "high-x" } }),
        "relay",
      ),
    ).toBe("high");
    expect(
      channelDefaultPick(
        "claude",
        config({ relay: { HZKCODE_DEFAULT_LOW_MODEL: "low-x" } }),
        "relay",
      ),
    ).toBe("low");
  });

  it("没有档位映射时用自定义模型列表的首项", () => {
    const cfg = {
      claude: {
        current: "relay",
        providers: { relay: { customModels: ["claude-opus-5-5", "m2"] } },
      },
    } as unknown as CliConfig;
    expect(channelDefaultPick("claude", cfg, "relay")).toBe("claude-opus-5-5");
  });

  it("仅 settingsConfig.model 时作为渠道默认（与后端读取链一致）", () => {
    // The backend's resolve_model reads the legacy top-level field when no
    // env model is set; the frontend pick must read the same value instead
    // of falling through to the mid tier (which would override it).
    const cfg = {
      claude: {
        current: "relay",
        providers: { relay: { settingsConfig: { model: "legacy-default" } } },
      },
    } as unknown as CliConfig;
    expect(channelDefaultPick("claude", cfg, "relay")).toBe("legacy-default");
    expect(channelTierModels("claude", cfg, "relay").default).toBe(
      "legacy-default",
    );
  });

  it("什么都没有时落到中阶别名", () => {
    expect(channelDefaultPick("claude", config({ relay: {} }), "relay")).toBe(
      "mid",
    );
    expect(channelDefaultPick("claude", null, "relay")).toBe("mid");
  });
});

describe("computeChannelDefaults / findChannelDefault", () => {
  it("官方键按无渠道记录解析，不借用当前自定义渠道的映射", () => {
    // 当前渠道只映射了高阶；官方配置的会话应拿到裸别名（无映射），
    // 而不是自定义渠道的高阶映射。
    const cfg = config({ relay: { HZKCODE_DEFAULT_HIGH_MODEL: "high-x" } });
    const defaults = computeChannelDefaults(cfg);
    expect(defaults.claude?.relay).toBe("high");
    expect(defaults.claude?.[PSEUDO_LOCAL]).toBe("mid");
    // 会话显式选择官方配置：解析到官方键而不是当前渠道。
    expect(findChannelDefault(defaults, "claude", PSEUDO_LOCAL)).toBe("mid");
  });

  it("未知/已删除渠道退化到官方键，引擎缺失时无值", () => {
    const defaults = computeChannelDefaults(
      config({ relay: { HZKCODE_DEFAULT_MID_MODEL: "mid-x" } }),
    );
    expect(findChannelDefault(defaults, "claude", "removed-chan")).toBe("mid");
    expect(findChannelDefault(defaults, "omp", "relay")).toBeUndefined();
    expect(findChannelDefault({}, "claude", "relay")).toBeUndefined();
  });

  it("配置未加载时不产出任何默认值", () => {
    expect(computeChannelDefaults(null)).toEqual({});
  });
});

describe("channelSelectableIds", () => {
  const CATALOG = {
    models: [
      { id: "default", name: "Default" },
      { id: "high", name: "High" },
      { id: "mid", name: "Mid" },
      { id: "low", name: "Low" },
    ],
    authoritative: false,
  } as unknown as EngineCatalog;

  it("只收集该渠道的默认、三档与自定义，不混入其他渠道的模型", () => {
    // 两个渠道模型互不相交：A 的自定义与默认只属于 A。
    const cfg = {
      claude: {
        current: "chan-b",
        providers: {
          "chan-a": {
            customModels: ["a-only"],
            settingsConfig: { env: { HZKCODE_MODEL: "a-default" } },
          },
          "chan-b": {
            customModels: ["b-only"],
            settingsConfig: { env: { HZKCODE_MODEL: "b-default" } },
          },
        },
      },
    } as unknown as CliConfig;
    const a = channelSelectableIds("claude", cfg, "chan-a", CATALOG);
    expect(a.has("a-only")).toBe(true);
    expect(a.has("a-default")).toBe(true);
    expect(a.has("b-only")).toBe(false);
    expect(a.has("b-default")).toBe(false);
    // 目录里的档位别名对所有渠道都可用。
    expect(a.has("mid")).toBe(true);
    const b = channelSelectableIds("claude", cfg, "chan-b", CATALOG);
    expect(b.has("b-only")).toBe(true);
    expect(b.has("a-only")).toBe(false);
  });

  it("远端目录即全部可选集合", () => {
    const remote = {
      models: [{ id: "remote-m1", name: "Remote M1" }],
      authoritative: true,
      remote: true,
    } as unknown as EngineCatalog;
    const ids = channelSelectableIds(
      "claude",
      config({ relay: { HZKCODE_MODEL: "local-x" } }),
      "relay",
      remote,
    );
    expect([...ids]).toEqual(["remote-m1"]);
  });

  it("目录缺失或为空时，已映射档位别名仍在可选集合", () => {
    // 探针失败/空目录时档位别名不能缺席：渠道默认值（mid 等）必须
    // 仍被视为可服务，否则会被判失效并显示成引擎名。
    const cfg = config({
      relay: { HZKCODE_DEFAULT_MID_MODEL: "mid-x" },
    });
    const withoutCatalog = channelSelectableIds("claude", cfg, "relay", undefined);
    expect(withoutCatalog.has("mid")).toBe(true);
    expect(withoutCatalog.has("high")).toBe(false);
    const emptyCatalog = channelSelectableIds(
      "claude",
      cfg,
      "relay",
      { models: [], authoritative: true } as unknown as EngineCatalog,
    );
    expect(emptyCatalog.has("mid")).toBe(true);
  });
});
