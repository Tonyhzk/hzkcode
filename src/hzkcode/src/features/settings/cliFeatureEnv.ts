/** Global CLI feature variables the app owns. The app stores them in its own
 *  settings and injects them into every engine spawn, so a packaged install
 *  configures the CLI without a shell profile. None of these are per-channel:
 *  a channel carries only its endpoint, credential, model tiers and the
 *  compaction threshold (see CLAUDE_ENV_GROUPS). */
import type { EnvField } from "./providerPresets";

/** Thinking budgets the CLI accepts for its side queries. */
const THINKING_LEVELS = ["", "none", "low", "medium", "high", "xhigh", "max"] as const;
/** Chat protocols a side query may pick; "" follows the main channel. */
const API_CHANNELS = ["", "anthropic", "responses", "chat_completions"] as const;
/** Read-tool API formats; "" follows the CLI default (gemini). */
const READ_API_FORMATS = ["", "gemini", "openai"] as const;
/** Tri-state behaviour switches: "" follows the CLI default, "1" on, "0" off. */
const SWITCH_OPTIONS = ["", "1", "0"] as const;
const URL_PLACEHOLDER = "settings.cliEnvUrlPlaceholder";

export const CLI_FEATURE_GROUPS: readonly {
  titleKey: string;
  fields: readonly EnvField[];
}[] = [
  {
    titleKey: "settings.cliFeatureSearch",
    fields: [
      {
        envKey: "HZKCODE_ENABLE_WEB_SEARCH",
        kind: "toggle",
        labelKey: "settings.cliEnvWebSearch",
        hintKey: "settings.cliEnvWebSearchHint",
      },
      {
        envKey: "HZKCODE_WEB_SEARCH_ADAPTER",
        kind: "select",
        options: ["", "perplexity", "tavily", "exa", "brave", "bing", "api"],
        labelKey: "settings.cliEnvSearchAdapter",
      },
      {
        envKey: "HZKCODE_PERPLEXITY_ENDPOINT_URL",
        kind: "text",
        labelKey: "settings.cliEnvPerplexityEndpoint",
        placeholderKey: URL_PLACEHOLDER,
      },
      {
        envKey: "HZKCODE_PERPLEXITY_API_KEY",
        kind: "text",
        labelKey: "settings.cliEnvPerplexityKey",
      },
      {
        envKey: "HZKCODE_PERPLEXITY_PROXY_URL",
        kind: "text",
        labelKey: "settings.cliEnvPerplexityProxy",
        placeholderKey: URL_PLACEHOLDER,
      },
    ],
  },
  {
    titleKey: "settings.cliFeatureOss",
    fields: [
      {
        envKey: "HZKCODE_FILE_READ_IMAGE_USE_OSS",
        kind: "toggle",
        labelKey: "settings.cliEnvImageViaOss",
        hintKey: "settings.cliEnvImageViaOssHint",
      },
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
    titleKey: "settings.cliFeatureFeishu",
    fields: [
      { envKey: "HZKCODE_FEISHU_APP_ID", kind: "text", labelKey: "settings.cliEnvFeishuAppId" },
      {
        envKey: "HZKCODE_FEISHU_APP_SECRET",
        kind: "text",
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
  {
    titleKey: "settings.cliFeatureMemory",
    fields: [
      {
        envKey: "HZKCODE_ENABLE_USER_MEMORY",
        kind: "toggle",
        labelKey: "settings.cliEnvUserMemory",
        hintKey: "settings.cliEnvUserMemoryHint",
      },
      { envKey: "HZKCODE_MEMORY_MODEL", kind: "text", labelKey: "settings.cliEnvMemoryModel" },
      {
        envKey: "HZKCODE_MEMORY_THINKING_LEVEL",
        kind: "select",
        options: THINKING_LEVELS,
        labelKey: "settings.cliEnvThinkingLevel",
      },
      {
        envKey: "HZKCODE_MEMORY_CHANNEL",
        kind: "select",
        options: API_CHANNELS,
        labelKey: "settings.cliEnvApiChannel",
      },
      {
        envKey: "HZKCODE_MEMORY_THINKING_BUDGET",
        kind: "number",
        labelKey: "settings.cliEnvMemoryBudget",
      },
      {
        envKey: "HZKCODE_MEMORY_TIMEOUT_MS",
        kind: "number",
        labelKey: "settings.cliEnvMemoryTimeout",
      },
      {
        envKey: "HZKCODE_MEMORY_POLL_MS",
        kind: "number",
        labelKey: "settings.cliEnvMemoryPoll",
      },
      {
        envKey: "HZKCODE_MEMORY_IDLE_EXIT_MS",
        kind: "number",
        labelKey: "settings.cliEnvMemoryIdleExit",
      },
    ],
  },
  {
    titleKey: "settings.cliFeatureSecondBrain",
    fields: [
      {
        envKey: "HZKCODE_ENABLE_SECOND_BRAIN",
        kind: "toggle",
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
        labelKey: "settings.cliEnvThinkingLevel",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_CHANNEL",
        kind: "select",
        options: API_CHANNELS,
        labelKey: "settings.cliEnvApiChannel",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_INTERVAL_MS",
        kind: "number",
        labelKey: "settings.cliEnvSecondBrainInterval",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_MIN_NEW_RESPONSES",
        kind: "number",
        labelKey: "settings.cliEnvSecondBrainMinResponses",
        hintKey: "settings.cliEnvSecondBrainMinResponsesHint",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_TIMEOUT_MS",
        kind: "number",
        labelKey: "settings.cliEnvSecondBrainTimeout",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_THINKING_BUDGET",
        kind: "number",
        labelKey: "settings.cliEnvSecondBrainBudget",
      },
      {
        envKey: "HZKCODE_SECOND_BRAIN_STREAM",
        kind: "toggle",
        labelKey: "settings.cliEnvStreamRequest",
        hintKey: "settings.cliEnvStreamRequestHint",
      },
    ],
  },
  {
    titleKey: "settings.cliFeatureAutoMode",
    fields: [
      { envKey: "HZKCODE_AUTO_MODE_MODEL", kind: "text", labelKey: "settings.cliEnvAutoModeModel" },
      {
        envKey: "HZKCODE_AUTO_MODE_THINKING_LEVEL",
        kind: "select",
        options: THINKING_LEVELS,
        labelKey: "settings.cliEnvThinkingLevel",
      },
      {
        envKey: "HZKCODE_AUTO_MODE_CHANNEL",
        kind: "select",
        options: API_CHANNELS,
        labelKey: "settings.cliEnvApiChannel",
      },
      {
        envKey: "HZKCODE_AUTO_MODE_PROTOCOL",
        kind: "select",
        options: ["", "tools", "xml"],
        labelKey: "settings.cliEnvAutoModeProtocol",
      },
      {
        envKey: "HZKCODE_AUTO_MODE_STREAM",
        kind: "toggle",
        labelKey: "settings.cliEnvStreamRequest",
        hintKey: "settings.cliEnvStreamRequestHint",
      },
    ],
  },
  {
    titleKey: "settings.cliFeatureInterface",
    fields: [
      {
        envKey: "HZKCODE_RESPONSES_WEBSOCKET",
        kind: "toggle",
        labelKey: "settings.cliEnvResponsesWebsocket",
        hintKey: "settings.cliEnvResponsesWebsocketHint",
      },
      {
        envKey: "HZKCODE_PROXY_URL",
        kind: "text",
        labelKey: "settings.cliEnvProxyUrl",
        placeholderKey: URL_PLACEHOLDER,
      },
      {
        envKey: "HZKCODE_PROXY_ENABLED",
        kind: "select",
        options: SWITCH_OPTIONS,
        labelKey: "settings.cliEnvProxyEnabled",
        hintKey: "settings.cliEnvProxyEnabledHint",
      },
    ],
  },
  {
    titleKey: "settings.cliFeatureMediaRead",
    fields: [
      {
        envKey: "HZKCODE_READ_MODEL",
        kind: "text",
        labelKey: "settings.cliEnvReadModel",
        hintKey: "settings.cliEnvReadModelHint",
      },
      { envKey: "HZKCODE_READ_IMAGE_MODEL", kind: "text", labelKey: "settings.cliEnvReadImageModel" },
      {
        envKey: "HZKCODE_READ_IMAGE_API_FORMAT",
        kind: "select",
        options: READ_API_FORMATS,
        labelKey: "settings.cliEnvReadImageFormat",
      },
      {
        envKey: "HZKCODE_READ_IMAGE_API_URL",
        kind: "text",
        labelKey: "settings.cliEnvReadImageUrl",
        placeholderKey: URL_PLACEHOLDER,
      },
      { envKey: "HZKCODE_READ_IMAGE_API_KEY", kind: "text", labelKey: "settings.cliEnvReadImageKey" },
      { envKey: "HZKCODE_READ_VIDEO_MODEL", kind: "text", labelKey: "settings.cliEnvReadVideoModel" },
      {
        envKey: "HZKCODE_READ_VIDEO_API_FORMAT",
        kind: "select",
        options: READ_API_FORMATS,
        labelKey: "settings.cliEnvReadVideoFormat",
      },
      {
        envKey: "HZKCODE_READ_VIDEO_API_URL",
        kind: "text",
        labelKey: "settings.cliEnvReadVideoUrl",
        placeholderKey: URL_PLACEHOLDER,
      },
      { envKey: "HZKCODE_READ_VIDEO_API_KEY", kind: "text", labelKey: "settings.cliEnvReadVideoKey" },
      { envKey: "HZKCODE_READ_AUDIO_MODEL", kind: "text", labelKey: "settings.cliEnvReadAudioModel" },
      {
        envKey: "HZKCODE_READ_AUDIO_API_FORMAT",
        kind: "select",
        options: READ_API_FORMATS,
        labelKey: "settings.cliEnvReadAudioFormat",
      },
      {
        envKey: "HZKCODE_READ_AUDIO_API_URL",
        kind: "text",
        labelKey: "settings.cliEnvReadAudioUrl",
        placeholderKey: URL_PLACEHOLDER,
      },
      { envKey: "HZKCODE_READ_AUDIO_API_KEY", kind: "text", labelKey: "settings.cliEnvReadAudioKey" },
    ],
  },
  {
    titleKey: "settings.cliFeatureBehavior",
    fields: [
      {
        envKey: "HZKCODE_REPORT_WORK_STATUS",
        kind: "select",
        options: ["", "0", "1", "2", "3"],
        labelKey: "settings.cliEnvWorkStatus",
        hintKey: "settings.cliEnvWorkStatusHint",
      },
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
      {
        envKey: "HZKCODE_LOAD_PARENT_CLAUDE_MD",
        kind: "select",
        options: SWITCH_OPTIONS,
        labelKey: "settings.cliEnvLoadParentClaudeMd",
        hintKey: "settings.cliEnvTriStateHint",
      },
      {
        envKey: "HZKCODE_LOAD_NESTED_CLAUDE_MD",
        kind: "select",
        options: SWITCH_OPTIONS,
        labelKey: "settings.cliEnvLoadNestedClaudeMd",
        hintKey: "settings.cliEnvTriStateHint",
      },
      {
        envKey: "HZKCODE_LOAD_PARENT_SKILLS",
        kind: "select",
        options: SWITCH_OPTIONS,
        labelKey: "settings.cliEnvLoadParentSkills",
        hintKey: "settings.cliEnvTriStateHint",
      },
      {
        envKey: "HZKCODE_LOAD_NESTED_SKILLS",
        kind: "select",
        options: SWITCH_OPTIONS,
        labelKey: "settings.cliEnvLoadNestedSkills",
        hintKey: "settings.cliEnvTriStateHint",
      },
    ],
  },
];

/** Every variable the feature card owns. */
export const CLI_FEATURE_KEYS: readonly string[] = CLI_FEATURE_GROUPS.flatMap(
  (group) => group.fields.map((field) => field.envKey),
);
