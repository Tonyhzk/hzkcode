/** Preset tables and config templates for ProviderDialog, ported from the
 *  reference desktop-cc-gui's features/vendors/types.ts. */

import bailianIcon from "@lobehub/icons-static-svg/icons/bailian-color.svg";
import deepseekIcon from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi.svg";
import longcatIcon from "@lobehub/icons-static-svg/icons/longcat-color.svg";
import minimaxIcon from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import opencodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg";
import openrouterIcon from "@lobehub/icons-static-svg/icons/openrouter-color.svg";
import xiaomimimoIcon from "@lobehub/icons-static-svg/icons/xiaomimimo.svg";
import zhipuIcon from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import type { EngineId } from "./providers";

export interface ProviderPreset {
  /** Brand-literal display name (same convention as CLI_DISPLAY_NAMES). */
  name: string;
  baseUrl: string;
  model: string;
  /** Explicit provider mark; model inference is unsafe for relay presets
   *  whose default model belongs to a different brand (e.g. OpenCode Go). */
  iconSrc: string;
  /** Monochrome SVGs use currentColor, which stays black inside an <img>;
   *  invert them in dark mode so they remain visible. */
  iconClassName?: string;
  /** claude: extra env merged into the JSON config on preset pick —
   *  the capability tiers' model slots plus per-provider tuning vars. */
  env?: Record<string, string>;
}

/** Monochrome SVGs use currentColor, which stays black inside an <img>. */
const DARK_MONO_ICON_CLASS = "dark:invert";

/** Claude-only: the official direct endpoint. Selecting the official card
 *  locks API URL to this value, mirroring the reference's 官方直连 preset. */
export const OFFICIAL_BASE_URL = "https://api.anthropic.com";

/** One channel-level control in the dialog. `envKey` is the CLI variable it
 *  edits inside the channel's `settingsConfig.env`; the i18n keys sit next to
 *  it so the form renders as a loop over the schema. */
export interface EnvField {
  envKey: string;
  /** "text" = free text (model ids get the 拉取模型 datalist), "number" = a
   *  numeric threshold, "select" = fixed option list ("" = CLI default),
   *  "toggle" = on/off switch writing "1" / unset. */
  kind: "text" | "number" | "select" | "toggle";
  options?: readonly string[];
  /** select: option value → i18n label key. Present for labeled picks (the
   *  model-tier default); a stored value outside `options` then renders as
   *  the custom option — a free-text model id with its own 1M switch. */
  optionLabelKeys?: Record<string, string>;
  /** select: allow a value beyond `options` through the custom option. */
  allowCustom?: boolean;
  /** select: the option shown while nothing is stored (also what an unset
   *  value resolves to). */
  emptyShows?: string;
  labelKey: string;
  hintKey?: string;
  placeholderKey?: string;
  /** Model-id field: gets the 1M-context switch that appends/replaces the
   *  `[1m]` suffix on the value. */
  oneM?: boolean;
}

/** The channel fields the dialog exposes, grouped in display order. These are
 *  the per-channel variables the CLI reads — endpoint format, the model tiers
 *  and the compaction threshold. Global capability switches (search, OSS,
 *  Feishu, memory, …) are not per-channel and live elsewhere. */
export const CLAUDE_ENV_GROUPS: readonly {
  titleKey: string;
  fields: readonly EnvField[];
}[] = [
  {
    titleKey: "settings.cliGroupConnection",
    fields: [
      {
        envKey: "HZKCODE_API_MODE",
        kind: "select",
        options: ["", "anthropic", "responses", "chat_completions"],
        labelKey: "settings.cliFieldApiMode",
        hintKey: "settings.cliFieldApiModeHint",
      },
      {
        envKey: "HZKCODE_AUTO_COMPACT_WINDOW",
        kind: "number",
        labelKey: "settings.cliFieldCompactWindow",
        hintKey: "settings.cliFieldCompactWindowHint",
        placeholderKey: "settings.cliFieldCompactWindowPlaceholder",
      },
    ],
  },
  {
    titleKey: "settings.cliGroupModels",
    fields: [
      {
        // Tier picker, not a raw id: the default is one of the configured
        // tiers or a custom model; nothing stored shows (and resolves as)
        // the mid tier.
        envKey: "HZKCODE_MODEL",
        kind: "select",
        options: ["haiku", "sonnet", "opus"],
        optionLabelKeys: {
          haiku: "settings.cliFieldLowModel",
          sonnet: "settings.cliFieldMidModel",
          opus: "settings.cliFieldHighModel",
        },
        allowCustom: true,
        emptyShows: "sonnet",
        labelKey: "settings.cliFieldDefaultModel",
        hintKey: "settings.cliFieldDefaultModelHint",
      },
      {
        envKey: "HZKCODE_DEFAULT_HIGH_MODEL",
        kind: "text",
        labelKey: "settings.cliFieldHighModel",
        placeholderKey: "settings.cliFieldModelPlaceholder",
        oneM: true,
      },
      {
        envKey: "HZKCODE_DEFAULT_MID_MODEL",
        kind: "text",
        labelKey: "settings.cliFieldMidModel",
        placeholderKey: "settings.cliFieldModelPlaceholder",
        oneM: true,
      },
      {
        envKey: "HZKCODE_DEFAULT_LOW_MODEL",
        kind: "text",
        labelKey: "settings.cliFieldLowModel",
        placeholderKey: "settings.cliFieldModelPlaceholder",
        oneM: true,
      },
      {
        envKey: "HZKCODE_READ_MODEL",
        kind: "text",
        labelKey: "settings.cliFieldReadModel",
        hintKey: "settings.cliFieldReadModelHint",
        placeholderKey: "settings.cliFieldModelPlaceholder",
        oneM: true,
      },
    ],
  },
];

/** Every env key the dialog's controls own, in schema order. */
export const CLAUDE_ENV_FIELD_KEYS: readonly string[] = CLAUDE_ENV_GROUPS.flatMap(
  (group) => group.fields.map((field) => field.envKey),
);

/** The reference's default settings.json template for a new Claude channel. */
export function buildDefaultClaudeSettings(): Record<string, unknown> & {
  env: Record<string, string>;
} {
  return {
    alwaysThinkingEnabled: true,
    effortLevel: "xhigh",
    env: {
      HZKCODE_BASE_URL: "",
      HZKCODE_API_KEY: "",
      HZKCODE_API_MODE: "anthropic",
      HZKCODE_DEFAULT_HIGH_MODEL: "",
      HZKCODE_DEFAULT_MID_MODEL: "",
      HZKCODE_DEFAULT_LOW_MODEL: "",
      HZKCODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      HZKCODE_DISABLE_TELEMETRY: "1",
      HZKCODE_DISABLE_ERROR_REPORTING: "1",
      HZKCODE_MAX_THINKING_TOKENS: "31999",
      HZKCODE_MCP_TIMEOUT: "60000",
    },
  };
}

/** Fresh settings.json text for a claude channel: the default template with
 *  the endpoint, the user's token and any preset env merged in. */
export function claudeTemplateJson(
  baseUrl: string,
  apiKey: string,
  extraEnv: Record<string, string> = {},
): string {
  const config = buildDefaultClaudeSettings();
  config.env.HZKCODE_BASE_URL = baseUrl;
  config.env.HZKCODE_API_KEY = apiKey;
  for (const [key, val] of Object.entries(extraEnv)) {
    config.env[key] = val;
  }
  return JSON.stringify(config, null, 2);
}

// ── preset tables ───────────────────────────────────────────────────────────

/** Third-party relay presets, keyed by engine. Claude's table is ported from
 *  the reference's CLAUDE_PROVIDER_PRESETS (per-tier model env included). */
export const PRESETS: Partial<Record<EngineId, ProviderPreset[]>> = {
  claude: [
    {
      name: "智谱GLM",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      model: "glm-5.2",
      iconSrc: zhipuIcon,
      env: {
        HZKCODE_DEFAULT_LOW_MODEL: "glm-5.2",
        HZKCODE_DEFAULT_MID_MODEL: "glm-5.2",
        HZKCODE_DEFAULT_HIGH_MODEL: "glm-5.2",
      },
    },
    {
      name: "Kimi",
      baseUrl: "https://api.moonshot.cn/anthropic",
      model: "kimi-k3",
      iconSrc: kimiIcon,
      iconClassName: DARK_MONO_ICON_CLASS,
      env: {
        HZKCODE_DEFAULT_LOW_MODEL: "kimi-k3",
        HZKCODE_DEFAULT_MID_MODEL: "kimi-k3",
        HZKCODE_DEFAULT_HIGH_MODEL: "kimi-k3",
      },
    },
    {
      name: "Kimi Coding",
      baseUrl: "https://api.kimi.com/coding/",
      model: "kimi-k3",
      iconSrc: kimiIcon,
      iconClassName: DARK_MONO_ICON_CLASS,
      env: {
        HZKCODE_DEFAULT_LOW_MODEL: "kimi-k3",
        HZKCODE_DEFAULT_MID_MODEL: "kimi-k3",
        HZKCODE_DEFAULT_HIGH_MODEL: "kimi-k3",
        HZKCODE_MAX_CONTEXT_TOKENS: "262144",
        HZKCODE_AUTO_COMPACT_WINDOW: "262144",
      },
    },
    {
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/anthropic",
      model: "deepseek-v4-pro[1m]",
      iconSrc: deepseekIcon,
      env: {
        HZKCODE_DEFAULT_LOW_MODEL: "deepseek-v4-flash",
        HZKCODE_DEFAULT_MID_MODEL: "deepseek-v4-pro[1m]",
        HZKCODE_DEFAULT_HIGH_MODEL: "deepseek-v4-pro[1m]",
        HZKCODE_EFFORT_LEVEL: "max",
      },
    },
    {
      name: "MiniMax",
      baseUrl: "https://api.minimaxi.com/anthropic",
      model: "MiniMax-M2.1",
      iconSrc: minimaxIcon,
      env: {
        HZKCODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        HZKCODE_DEFAULT_LOW_MODEL: "MiniMax-M2.1",
        HZKCODE_DEFAULT_MID_MODEL: "MiniMax-M2.1",
        HZKCODE_DEFAULT_HIGH_MODEL: "MiniMax-M2.1",
      },
    },
    {
      name: "Xiaomi MiMo",
      baseUrl: "https://api.xiaomimimo.com/anthropic",
      model: "mimo-v2.5-pro",
      iconSrc: xiaomimimoIcon,
      iconClassName: DARK_MONO_ICON_CLASS,
      env: {
        HZKCODE_DEFAULT_LOW_MODEL: "mimo-v2.5-pro",
        HZKCODE_DEFAULT_MID_MODEL: "mimo-v2.5-pro",
        HZKCODE_DEFAULT_HIGH_MODEL: "mimo-v2.5-pro",
      },
    },
    {
      name: "Xiaomi MiMo Plan",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
      model: "mimo-v2.5-pro",
      iconSrc: xiaomimimoIcon,
      iconClassName: DARK_MONO_ICON_CLASS,
      env: {
        HZKCODE_DEFAULT_LOW_MODEL: "mimo-v2.5-pro",
        HZKCODE_DEFAULT_MID_MODEL: "mimo-v2.5-pro",
        HZKCODE_DEFAULT_HIGH_MODEL: "mimo-v2.5-pro",
      },
    },
    { name: "Bailian", baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic", model: "", iconSrc: bailianIcon },
    { name: "Bailian Coding", baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic", model: "", iconSrc: bailianIcon },
    {
      name: "LongCat",
      baseUrl: "https://api.longcat.chat/anthropic",
      model: "LongCat-2.0",
      iconSrc: longcatIcon,
      env: {
        HZKCODE_DEFAULT_LOW_MODEL: "LongCat-2.0",
        HZKCODE_DEFAULT_MID_MODEL: "LongCat-2.0",
        HZKCODE_DEFAULT_HIGH_MODEL: "LongCat-2.0",
        HZKCODE_MAX_OUTPUT_TOKENS: "131072",
        HZKCODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
    {
      name: "OpenCode Go",
      baseUrl: "https://opencode.ai/zen/go",
      model: "deepseek-v4-flash",
      iconSrc: opencodeIcon,
      iconClassName: DARK_MONO_ICON_CLASS,
      env: {
        HZKCODE_DEFAULT_LOW_MODEL: "deepseek-v4-flash",
        HZKCODE_DEFAULT_MID_MODEL: "deepseek-v4-flash",
        HZKCODE_DEFAULT_HIGH_MODEL: "deepseek-v4-flash",
      },
    },
    {
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api",
      model: "anthropic/claude-sonnet-4.5",
      iconSrc: openrouterIcon,
      env: {
        HZKCODE_DEFAULT_LOW_MODEL: "anthropic/claude-haiku-4.5",
        HZKCODE_DEFAULT_MID_MODEL: "anthropic/claude-sonnet-4.5",
        HZKCODE_DEFAULT_HIGH_MODEL: "anthropic/claude-opus-4.5",
      },
    },
  ],
};

/** The preset matching the current URL; the empty 自定义 URL matches nothing. */
export function findMatchedPreset(
  presets: ProviderPreset[],
  baseUrl: string,
): ProviderPreset | undefined {
  return presets.find((p) => p.baseUrl === baseUrl && p.baseUrl !== "");
}

/** The reference's isOfficialAnthropicEndpoint: empty and api.anthropic.com
 *  (any scheme/path) count as official. */
export function isOfficialAnthropicEndpoint(baseUrl: string): boolean {
  const normalized = baseUrl.trim().toLowerCase();
  if (normalized === "") return true;
  try {
    return new URL(normalized).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}
