/** Global CLI feature variables the app owns, grouped as the settings pages
 *  present them. The app stores them in its own settings and injects them into
 *  every engine spawn, so a packaged install configures the CLI without a
 *  shell profile. None of these are per-channel: a channel carries only its
 *  endpoint, credential, model tiers and the compaction threshold (see
 *  CLAUDE_ENV_GROUPS). */
import type { ComponentType } from "react";
import AudioLines from "lucide-react/dist/esm/icons/audio-lines";
import Image from "lucide-react/dist/esm/icons/image";
import Video from "lucide-react/dist/esm/icons/video";
import type { EnvField } from "./providerPresets";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/** Thinking budgets the CLI accepts for its side queries. */
const THINKING_LEVELS = ["", "none", "low", "medium", "high", "xhigh", "max"] as const;
/** Chat protocols a side query may pick; "" follows the main channel. */
const API_CHANNELS = ["", "anthropic", "responses", "chat_completions"] as const;
/** Read-tool API formats; "" follows the CLI default (gemini). */
const READ_API_FORMATS = ["", "gemini", "openai"] as const;
/** The read tool rejects the openai format for audio. */
const AUDIO_API_FORMATS = ["", "gemini"] as const;
/** Tri-state switches: "" follows the CLI default, "1" on, "0" off. */
const SWITCH_OPTIONS = ["", "1", "0"] as const;
const URL_PLACEHOLDER = "settings.cliEnvUrlPlaceholder";

const TRI_OFF_LABELS = {
  "": "settings.cliOptDefaultOff",
  "1": "settings.cliOptOn",
  "0": "settings.cliOptOff",
};
const TRI_ON_LABELS = { ...TRI_OFF_LABELS, "": "settings.cliOptDefaultOn" };
const THINKING_LABELS = {
  "": "settings.cliOptFollowModel",
  none: "settings.cliOptThinkingNone",
  low: "settings.cliOptThinkingLow",
  medium: "settings.cliOptThinkingMedium",
  high: "settings.cliOptThinkingHigh",
  xhigh: "settings.cliOptThinkingXhigh",
  max: "settings.cliOptThinkingMax",
};
const CHANNEL_LABELS = {
  "": "settings.cliOptFollowChannel",
  anthropic: "settings.cliOptChannelAnthropic",
  responses: "settings.cliOptChannelResponses",
  chat_completions: "settings.cliOptChannelChat",
};
const READ_FORMAT_LABELS = {
  "": "settings.cliOptDefaultGemini",
  gemini: "settings.cliOptFormatGemini",
  openai: "settings.cliOptFormatOpenai",
};

export interface CliEnvGroup {
  /** Stable id; pages pick their groups through `cliFeatureGroup`. */
  id: string;
  titleKey: string;
  /** One-line hint under the card title. */
  descKey: string;
  /** Segmented switcher inside the card; fields with a `tabKey` show under
   *  the matching tab, the rest stay above it. */
  tabs?: readonly { id: string; labelKey: string; icon?: IconComponent }[];
  fields: readonly EnvField[];
}

export const CLI_FEATURE_GROUPS: readonly CliEnvGroup[] = [
  {
    id: "search",
    titleKey: "settings.cliFeatureSearch",
    descKey: "settings.cliFeatureSearchDesc",
    fields: [
      {
        envKey: "HZKCODE_ENABLE_WEB_SEARCH",
        kind: "toggle",
        master: true,
        labelKey: "settings.cliEnvWebSearch",
        hintKey: "settings.cliEnvWebSearchHint",
      },
      {
        envKey: "HZKCODE_WEB_SEARCH_ADAPTER",
        kind: "select",
        options: ["", "api", "bing", "brave", "exa", "perplexity", "tavily"],
        optionLabelKeys: {
          "": "settings.cliOptDefaultBing",
          api: "settings.cliOptSearchApi",
          bing: "settings.cliOptSearchBing",
          brave: "settings.cliOptSearchBrave",
          exa: "settings.cliOptSearchExa",
          perplexity: "settings.cliOptSearchPerplexity",
          tavily: "settings.cliOptSearchTavily",
        },
        labelKey: "settings.cliEnvSearchAdapter",
      },
      {
        envKey: "HZKCODE_PERPLEXITY_ENDPOINT_URL",
        kind: "text",
        labelKey: "settings.cliEnvPerplexityEndpoint",
        placeholderKey: URL_PLACEHOLDER,
        showWhen: { envKey: "HZKCODE_WEB_SEARCH_ADAPTER", oneOf: ["perplexity"] },
      },
      {
        envKey: "HZKCODE_PERPLEXITY_API_KEY",
        kind: "text",
        secret: true,
        labelKey: "settings.cliEnvPerplexityKey",
        showWhen: { envKey: "HZKCODE_WEB_SEARCH_ADAPTER", oneOf: ["perplexity"] },
      },
      {
        envKey: "HZKCODE_PERPLEXITY_PROXY_URL",
        kind: "text",
        advanced: true,
        labelKey: "settings.cliEnvPerplexityProxy",
        placeholderKey: URL_PLACEHOLDER,
        showWhen: { envKey: "HZKCODE_WEB_SEARCH_ADAPTER", oneOf: ["perplexity"] },
      },
    ],
  },
  {
    id: "mediaRead",
    titleKey: "settings.cliFeatureMediaRead",
    descKey: "settings.cliFeatureMediaReadDesc",
    tabs: [
      { id: "image", labelKey: "settings.cliTabImage", icon: Image },
      { id: "video", labelKey: "settings.cliTabVideo", icon: Video },
      { id: "audio", labelKey: "settings.cliTabAudio", icon: AudioLines },
    ],
    fields: [
      {
        envKey: "HZKCODE_READ_MODEL",
        kind: "text",
        labelKey: "settings.cliEnvReadModel",
        hintKey: "settings.cliEnvReadModelHint",
      },
      {
        envKey: "HZKCODE_READ_IMAGE_MODEL",
        kind: "text",
        tabKey: "image",
        labelKey: "settings.cliEnvModelName",
      },
      {
        envKey: "HZKCODE_READ_IMAGE_API_FORMAT",
        kind: "select",
        options: READ_API_FORMATS,
        optionLabelKeys: READ_FORMAT_LABELS,
        tabKey: "image",
        labelKey: "settings.cliEnvApiFormat",
      },
      {
        envKey: "HZKCODE_READ_IMAGE_API_URL",
        kind: "text",
        tabKey: "image",
        labelKey: "settings.cliEnvApiUrl",
        placeholderKey: URL_PLACEHOLDER,
      },
      {
        envKey: "HZKCODE_READ_IMAGE_API_KEY",
        kind: "text",
        secret: true,
        tabKey: "image",
        labelKey: "settings.cliEnvApiKey",
      },
      {
        envKey: "HZKCODE_READ_VIDEO_MODEL",
        kind: "text",
        tabKey: "video",
        labelKey: "settings.cliEnvModelName",
      },
      {
        envKey: "HZKCODE_READ_VIDEO_API_FORMAT",
        kind: "select",
        options: READ_API_FORMATS,
        optionLabelKeys: READ_FORMAT_LABELS,
        tabKey: "video",
        labelKey: "settings.cliEnvApiFormat",
      },
      {
        envKey: "HZKCODE_READ_VIDEO_API_URL",
        kind: "text",
        tabKey: "video",
        labelKey: "settings.cliEnvApiUrl",
        placeholderKey: URL_PLACEHOLDER,
      },
      {
        envKey: "HZKCODE_READ_VIDEO_API_KEY",
        kind: "text",
        secret: true,
        tabKey: "video",
        labelKey: "settings.cliEnvApiKey",
      },
      {
        envKey: "HZKCODE_READ_AUDIO_MODEL",
        kind: "text",
        tabKey: "audio",
        labelKey: "settings.cliEnvModelName",
      },
      {
        envKey: "HZKCODE_READ_AUDIO_API_FORMAT",
        kind: "select",
        options: AUDIO_API_FORMATS,
        optionLabelKeys: READ_FORMAT_LABELS,
        tabKey: "audio",
        labelKey: "settings.cliEnvApiFormat",
      },
      {
        envKey: "HZKCODE_READ_AUDIO_API_URL",
        kind: "text",
        tabKey: "audio",
        labelKey: "settings.cliEnvApiUrl",
        placeholderKey: URL_PLACEHOLDER,
      },
      {
        envKey: "HZKCODE_READ_AUDIO_API_KEY",
        kind: "text",
        secret: true,
        tabKey: "audio",
        labelKey: "settings.cliEnvApiKey",
      },
      {
        envKey: "HZKCODE_FILE_READ_IMAGE_USE_OSS",
        kind: "toggle",
        tabKey: "image",
        labelKey: "settings.cliEnvImageViaOss",
        hintKey: "settings.cliEnvImageViaOssHint",
      },
    ],
  },
  {
    id: "taskPlan",
    titleKey: "settings.cliFeatureTaskPlan",
    descKey: "settings.cliFeatureTaskPlanDesc",
    fields: [
      {
        envKey: "HZKCODE_ENABLE_TASKS",
        kind: "toggle",
        labelKey: "settings.cliEnvEnableTasks",
        hintKey: "settings.cliEnvEnableTasksHint",
      },
      {
        envKey: "HZKCODE_ENABLE_PLAN_MODE",
        kind: "toggle",
        labelKey: "settings.cliEnvEnablePlanMode",
        hintKey: "settings.cliEnvEnablePlanModeHint",
      },
    ],
  },
  {
    id: "memory",
    titleKey: "settings.cliFeatureMemory",
    descKey: "settings.cliFeatureMemoryDesc",
    fields: [
      {
        envKey: "HZKCODE_ENABLE_USER_MEMORY",
        kind: "toggle",
        master: true,
        labelKey: "settings.cliEnvUserMemory",
        hintKey: "settings.cliEnvUserMemoryHint",
      },
      {
        envKey: "HZKCODE_MEMORY_MODEL",
        kind: "text",
        labelKey: "settings.cliEnvMemoryModel",
      },
      {
        envKey: "HZKCODE_MEMORY_THINKING_LEVEL",
        kind: "select",
        options: THINKING_LEVELS,
        optionLabelKeys: THINKING_LABELS,
        labelKey: "settings.cliEnvThinkingLevel",
      },
      {
        envKey: "HZKCODE_MEMORY_CHANNEL",
        kind: "select",
        options: API_CHANNELS,
        optionLabelKeys: CHANNEL_LABELS,
        labelKey: "settings.cliEnvApiChannel",
      },
      {
        envKey: "HZKCODE_MEMORY_THINKING_BUDGET",
        kind: "number",
        advanced: true,
        labelKey: "settings.cliEnvMemoryBudget",
      },
      {
        envKey: "HZKCODE_MEMORY_TIMEOUT_MS",
        kind: "number",
        advanced: true,
        labelKey: "settings.cliEnvMemoryTimeout",
      },
      {
        envKey: "HZKCODE_MEMORY_POLL_MS",
        kind: "number",
        advanced: true,
        labelKey: "settings.cliEnvMemoryPoll",
      },
      {
        envKey: "HZKCODE_MEMORY_IDLE_EXIT_MS",
        kind: "number",
        advanced: true,
        labelKey: "settings.cliEnvMemoryIdleExit",
      },
    ],
  },
  {
    id: "secondBrain",
    titleKey: "settings.cliFeatureSecondBrain",
    descKey: "settings.cliFeatureSecondBrainDesc",
    fields: [
      {
        envKey: "HZKCODE_ENABLE_SECOND_BRAIN",
        kind: "toggle",
        master: true,
        labelKey: "settings.cliEnvSecondBrain",
        hintKey: "settings.cliEnvSecondBrainHint",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_MODEL",
        kind: "text",
        labelKey: "settings.cliEnvSecondBrainModel",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_THINKING_LEVEL",
        kind: "select",
        options: THINKING_LEVELS,
        optionLabelKeys: THINKING_LABELS,
        labelKey: "settings.cliEnvThinkingLevel",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_CHANNEL",
        kind: "select",
        options: API_CHANNELS,
        optionLabelKeys: CHANNEL_LABELS,
        labelKey: "settings.cliEnvApiChannel",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_MIN_NEW_RESPONSES",
        kind: "number",
        labelKey: "settings.cliEnvSecondBrainMinResponses",
        hintKey: "settings.cliEnvSecondBrainMinResponsesHint",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_INTERVAL_MS",
        kind: "number",
        advanced: true,
        labelKey: "settings.cliEnvSecondBrainInterval",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_TIMEOUT_MS",
        kind: "number",
        advanced: true,
        labelKey: "settings.cliEnvSecondBrainTimeout",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_THINKING_BUDGET",
        kind: "number",
        advanced: true,
        labelKey: "settings.cliEnvSecondBrainBudget",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_STREAM",
        kind: "toggle",
        advanced: true,
        labelKey: "settings.cliEnvStreamRequest",
        hintKey: "settings.cliEnvStreamRequestHint",
      },
    ],
  },
  {
    id: "autoMode",
    titleKey: "settings.cliFeatureAutoMode",
    descKey: "settings.cliFeatureAutoModeDesc",
    fields: [
      {
        envKey: "HZKCODE_AUTO_MODE_MODEL",
        kind: "text",
        labelKey: "settings.cliEnvAutoModeModel",
      },
      {
        envKey: "HZKCODE_AUTO_MODE_THINKING_LEVEL",
        kind: "select",
        options: THINKING_LEVELS,
        optionLabelKeys: THINKING_LABELS,
        labelKey: "settings.cliEnvThinkingLevel",
      },
      {
        envKey: "HZKCODE_AUTO_MODE_CHANNEL",
        kind: "select",
        options: API_CHANNELS,
        optionLabelKeys: CHANNEL_LABELS,
        labelKey: "settings.cliEnvApiChannel",
      },
      {
        envKey: "HZKCODE_AUTO_MODE_PROTOCOL",
        kind: "select",
        options: ["", "xml", "tools"],
        optionLabelKeys: {
          "": "settings.cliOptDefaultXml",
          xml: "settings.cliOptProtocolXml",
          tools: "settings.cliOptProtocolTools",
        },
        advanced: true,
        labelKey: "settings.cliEnvAutoModeProtocol",
      },
      {
        envKey: "HZKCODE_AUTO_MODE_STREAM",
        kind: "toggle",
        advanced: true,
        labelKey: "settings.cliEnvStreamRequest",
        hintKey: "settings.cliEnvStreamRequestHint",
      },
    ],
  },
  {
    id: "sessionProxy",
    titleKey: "settings.cliFeatureSessionProxy",
    descKey: "settings.cliFeatureSessionProxyDesc",
    fields: [
      {
        envKey: "HZKCODE_PROXY_ENABLED",
        kind: "select",
        options: SWITCH_OPTIONS,
        optionLabelKeys: {
          "": "settings.cliOptProxyFollow",
          "1": "settings.cliOptProxyAddress",
          "0": "settings.cliOptProxyDirect",
        },
        labelKey: "settings.cliEnvProxyEnabled",
      },
      {
        envKey: "HZKCODE_PROXY_URL",
        kind: "text",
        labelKey: "settings.cliEnvProxyUrl",
        placeholderKey: URL_PLACEHOLDER,
      },
    ],
  },
  {
    id: "workStatus",
    titleKey: "settings.cliFeatureWorkStatus",
    descKey: "settings.cliFeatureWorkStatusDesc",
    fields: [
      {
        envKey: "HZKCODE_REPORT_WORK_STATUS",
        kind: "select",
        options: ["", "0", "1", "2", "3"],
        optionLabelKeys: {
          "": "settings.cliOptDefaultWork",
          "0": "settings.cliOptWorkStart",
          "1": "settings.cliOptWorkKey",
          "2": "settings.cliOptWorkStaged",
          "3": "settings.cliOptWorkEvery",
        },
        labelKey: "settings.cliEnvWorkStatus",
      },
    ],
  },
  {
    id: "contextLoad",
    titleKey: "settings.cliFeatureContextLoad",
    descKey: "settings.cliFeatureContextLoadDesc",
    fields: [
      {
        envKey: "HZKCODE_LOAD_PARENT_CLAUDE_MD",
        kind: "select",
        options: SWITCH_OPTIONS,
        optionLabelKeys: TRI_OFF_LABELS,
        labelKey: "settings.cliEnvLoadParentClaudeMd",
      },
      {
        envKey: "HZKCODE_LOAD_NESTED_CLAUDE_MD",
        kind: "select",
        options: SWITCH_OPTIONS,
        optionLabelKeys: TRI_ON_LABELS,
        labelKey: "settings.cliEnvLoadNestedClaudeMd",
      },
      {
        envKey: "HZKCODE_LOAD_PARENT_SKILLS",
        kind: "select",
        options: SWITCH_OPTIONS,
        optionLabelKeys: TRI_OFF_LABELS,
        labelKey: "settings.cliEnvLoadParentSkills",
      },
      {
        envKey: "HZKCODE_LOAD_NESTED_SKILLS",
        kind: "select",
        options: SWITCH_OPTIONS,
        optionLabelKeys: TRI_OFF_LABELS,
        labelKey: "settings.cliEnvLoadNestedSkills",
      },
    ],
  },
  {
    id: "oss",
    titleKey: "settings.cliFeatureOss",
    descKey: "settings.cliFeatureOssDesc",
    fields: [
      {
        envKey: "HZKCODE_OSS_ENDPOINT",
        kind: "text",
        labelKey: "settings.cliEnvOssEndpoint",
        placeholderKey: URL_PLACEHOLDER,
      },
      { envKey: "HZKCODE_OSS_BUCKET", kind: "text", labelKey: "settings.cliEnvOssBucket" },
      {
        envKey: "HZKCODE_OSS_ACCESS_KEY_ID",
        kind: "text",
        labelKey: "settings.cliEnvOssKeyId",
      },
      {
        envKey: "HZKCODE_OSS_ACCESS_KEY_SECRET",
        kind: "text",
        secret: true,
        labelKey: "settings.cliEnvOssKeySecret",
      },
      {
        envKey: "HZKCODE_OSS_PATH",
        kind: "text",
        labelKey: "settings.cliEnvOssPath",
        placeholderKey: "settings.cliEnvOssPathPlaceholder",
      },
    ],
  },
  {
    id: "feishu",
    titleKey: "settings.cliFeatureFeishu",
    descKey: "settings.cliFeatureFeishuDesc",
    fields: [
      { envKey: "HZKCODE_FEISHU_APP_ID", kind: "text", labelKey: "settings.cliEnvFeishuAppId" },
      {
        envKey: "HZKCODE_FEISHU_APP_SECRET",
        kind: "text",
        secret: true,
        labelKey: "settings.cliEnvFeishuAppSecret",
      },
      {
        envKey: "HZKCODE_FEISHU_OPEN_ID",
        kind: "text",
        labelKey: "settings.cliEnvFeishuOpenId",
        hintKey: "settings.cliEnvFeishuOpenIdHint",
      },
    ],
  },
];

/** The group registered under `id`; a page asking for a missing id is a bug. */
export function cliFeatureGroup(id: string): CliEnvGroup {
  const group = CLI_FEATURE_GROUPS.find((candidate) => candidate.id === id);
  if (!group) throw new Error(`unknown CLI feature group: ${id}`);
  return group;
}

/** Every variable the feature cards own. */
export const CLI_FEATURE_KEYS: readonly string[] = CLI_FEATURE_GROUPS.flatMap(
  (group) => group.fields.map((field) => field.envKey),
);
