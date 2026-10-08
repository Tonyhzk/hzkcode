/** Shared provider model for the CLI config section. */

import type { ProviderSection } from "@/lib/ipc";

export const ENGINE_IDS = ["claude"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];
/** Docs per engine — the CLI 管理 header "官方文档" link. */
export const ENGINE_DOCS_URLS: Record<EngineId, string> = {
  claude: "https://doc.hzkcode.houzhenkun.com",
};

export const PSEUDO_LOCAL = "__local_settings_json__";
/** Pseudo providers pinned at the top of every engine's list. */
export const PSEUDO_PROVIDER_IDS = [PSEUDO_LOCAL] as const;
export type PseudoProviderId = (typeof PSEUDO_PROVIDER_IDS)[number];

export const isPseudoProvider = (id: string): id is PseudoProviderId =>
  (PSEUDO_PROVIDER_IDS as readonly string[]).includes(id);

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/** Per-engine model env var, mirroring the backend provider_files::env_names() table. */
const ENV_MODEL_KEY: Partial<Record<EngineId, string>> = {
  claude: "HZKCODE_MODEL",
};

/**
 * Model id for the picker, read in the order the backend actually injects:
 * `settingsConfig.env.HZKCODE_MODEL`, then `env.HZKCODE_MODEL`, then the
 * flat `model` field, then the legacy top-level `settingsConfig.model` —
 * a record whose spellings disagree resolves to the one the engine will
 * honor. Values normalize on read: the retired context suffix is stripped
 * and the pre-3.1.1 family aliases map to their tier spell, so display,
 * send resolution and validity checks all agree on one spelling.
 */
export function providerModel(engine: EngineId, raw: unknown): string {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const key = ENV_MODEL_KEY[engine];
  if (!key) return "";
  const settingsConfig = o.settingsConfig as Record<string, unknown> | undefined;
  for (const source of [settingsConfig?.env, o.env]) {
    if (source && typeof source === "object") {
      const value = asString((source as Record<string, unknown>)[key]).trim();
      if (value) return normalizeTierAlias(stripContextSuffix(value));
    }
  }
  const flat = asString(o.model).trim();
  if (flat) return normalizeTierAlias(stripContextSuffix(flat));
  const legacy = asString(settingsConfig?.model).trim();
  if (legacy) return normalizeTierAlias(stripContextSuffix(legacy));
  return "";
}

/** The model-name context suffix the CLI retired in 3.1.2 (`model[1m]` /
 *  `model[2m]`); stored values may still carry it, so every read path strips
 *  it through [`stripContextSuffix`]. */
const MODEL_CONTEXT_SUFFIX = /(\[(1|2)m\])+$/i;

/** Model id with the retired context suffix removed. */
export function stripContextSuffix(model: string): string {
  return model.trim().replace(MODEL_CONTEXT_SUFFIX, "").trim();
}

/** The 3.1.1 tier rename: the old family aliases (opus/sonnet/haiku) became
 *  high/mid/low with no alias kept. Tier spells match case-insensitively
 *  (the CLI lowercases before matching) and normalize to their lowercase
 *  spell; whole-value match only, so real model ids that merely contain a
 *  family word (claude-sonnet-4-6) are untouched. */
export function normalizeTierAlias(model: string): string {
  const trimmed = model.trim();
  switch (trimmed.toLowerCase()) {
    case "opus":
      return "high";
    case "sonnet":
      return "mid";
    case "haiku":
      return "low";
    case "high":
    case "mid":
    case "low":
      return trimmed.toLowerCase();
    default:
      return trimmed;
  }
}

/** Whether the value is a capability-tier spelling (high/mid/low, any case).
 *  Tier bindings (HZKCODE_DEFAULT_*_MODEL) must hold concrete model ids —
 *  the engine drops a tier spelling there, so reads treat it as unset. */
export function isTierSpell(model: string): boolean {
  const normalized = normalizeTierAlias(model);
  return normalized === "high" || normalized === "mid" || normalized === "low";
}

/** Model-valued env keys whose retired suffix strips on read (the engine's
 *  injection-side normalization covers the same set). */
const MODEL_ENV_KEYS: readonly string[] = [
  "HZKCODE_MODEL",
  "HZKCODE_SMALL_FAST_MODEL",
  "HZKCODE_SUBAGENT_MODEL",
  "HZKCODE_DEFAULT_HIGH_MODEL",
  "HZKCODE_DEFAULT_MID_MODEL",
  "HZKCODE_DEFAULT_LOW_MODEL",
  "HZKCODE_READ_MODEL",
  "HZKCODE_READ_IMAGE_MODEL",
  "HZKCODE_READ_VIDEO_MODEL",
  "HZKCODE_READ_AUDIO_MODEL",
];

/** Main-loop models: only their suffix implies the conversation's 1M window. */
const MAIN_LOOP_ENV_KEYS: readonly string[] = [
  "HZKCODE_MODEL",
  "HZKCODE_DEFAULT_HIGH_MODEL",
  "HZKCODE_DEFAULT_MID_MODEL",
  "HZKCODE_DEFAULT_LOW_MODEL",
];

/** Editing a channel reads its env through the same legacy migration the
 *  engine applies when injecting:
 *
 *  - every model key loses the retired [1m]/[2m] suffix;
 *  - when a main-loop model carried the suffix and the channel has no
 *    explicit window, HZKCODE_MAX_CONTEXT_TOKENS=1000000 is added — the
 *    send-time derivation is only a fallback, so saving must land the 1M
 *    window in the config or it would fall back to the default once the
 *    user edits the model;
 *  - HZKCODE_MODEL / HZKCODE_SUBAGENT_MODEL (resolved by the CLI) map the
 *    old family aliases to the current tier spell.
 *
 *  Returns the original object when nothing changes. */
export function migrateChannelEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  const ensure = (): Record<string, unknown> => (next ??= { ...env });
  let mainHadSuffix = false;
  for (const key of MODEL_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== "string") continue;
    const stripped = stripContextSuffix(value);
    if (!stripped) continue;
    const isResolved = key === "HZKCODE_MODEL" || key === "HZKCODE_SUBAGENT_MODEL";
    const out = isResolved ? normalizeTierAlias(stripped) : stripped;
    if (stripped !== value.trim() && MAIN_LOOP_ENV_KEYS.includes(key)) {
      mainHadSuffix = true;
    }
    if (out !== value) ensure()[key] = out;
  }
  const window = env.HZKCODE_MAX_CONTEXT_TOKENS;
  // Scalar truth mirrors the engine's collection rules: a non-empty string
  // or any number/boolean counts as an explicitly configured window and is
  // never overwritten.
  const windowConfigured =
    (typeof window === "string" && window.trim() !== "") ||
    typeof window === "number" ||
    typeof window === "boolean";
  if (mainHadSuffix && !windowConfigured) {
    ensure().HZKCODE_MAX_CONTEXT_TOKENS = "1000000";
  }
  return next ?? env;
}

/**
 * Per-engine env keys backing the flat baseUrl/apiKey/model fields, mirroring
 * the backend provider_files::env_names() table. Imported channels carry these
 * inside settingsConfig.env/env, and the backend lets raw env win over flat
 * fields — so an edit must strip them or the new values are dead.
 */
const ENV_CONVENTION_KEYS: Partial<Record<EngineId, string[]>> = {
  claude: ["HZKCODE_BASE_URL", "HZKCODE_API_KEY", "HZKCODE_MODEL"],
};

/** Copy `raw` with the convention env keys removed (empty maps/objects
 *  dropped), so edited flat fields take effect. Unknown keys are preserved. */
export function stripConventionEnv(engine: EngineId, raw: unknown): Record<string, unknown> {
  const keys = ENV_CONVENTION_KEYS[engine];
  const o = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
  if (!keys) return o;
  const keySet = new Set(keys);
  const strip = (env: unknown): Record<string, unknown> | undefined => {
    if (!env || typeof env !== "object") return undefined;
    const rest = Object.fromEntries(
      Object.entries(env as Record<string, unknown>).filter(([k]) => !keySet.has(k)),
    );
    return Object.keys(rest).length > 0 ? rest : undefined;
  };
  const env = strip(o.env);
  if (env) o.env = env;
  else delete o.env;
  if (o.settingsConfig && typeof o.settingsConfig === "object") {
    const sc = { ...(o.settingsConfig as Record<string, unknown>) };
    const scEnv = strip(sc.env);
    if (scEnv) sc.env = scEnv;
    else delete sc.env;
    if (Object.keys(sc).length > 0) o.settingsConfig = sc;
    else delete o.settingsConfig;
  }
  return o;
}

/** claude edit-dialog seed: the channel's settings.json text — its
 *  settingsConfig, or the flat env escape hatch wrapped in an object.
 *  "" when neither exists (the dialog falls back to the default template). */
export function claudeSettingsJson(raw: unknown): string {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sc = o.settingsConfig;
  if (sc && typeof sc === "object" && Object.keys(sc).length > 0) {
    return JSON.stringify(sc, null, 2);
  }
  const env = o.env;
  if (env && typeof env === "object" && Object.keys(env).length > 0) {
    return JSON.stringify({ env }, null, 2);
  }
  return "";
}

/** User-added model ids stored on the channel record (`customModels`). */
export function providerCustomModels(raw: unknown): string[] {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(o.customModels)) return [];
  const ids = o.customModels
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

/** Batch input for the channel dialog's 自定义模型 list: split on commas
 *  (half- or full-width), trim, and drop empty/duplicate ids. */
export function mergeCustomModels(existing: string[], text: string): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const part of text.split(/[,，]/)) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** One channel row of an engine's provider map, flattened for the UI. */
export interface ProviderEntry {
  /** Map key — the id `set_current_provider` expects. */
  id: string;
  name: string;
  remark: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Untouched stored record, merged back on save so unknown fields survive. */
  raw: unknown;
}

/** Display-ready channel list: pseudo ids are never stored in the map, so no
 *  filtering is needed; display name falls back to the id. */
export function providerEntries(
  engine: EngineId,
  section: ProviderSection | undefined,
): ProviderEntry[] {
  if (!section) return [];
  return Object.entries(section.providers).map(([id, raw]) => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      id,
      name: asString(o.name).trim() || id,
      remark: asString(o.remark),
      baseUrl: asString(o.baseUrl),
      apiKey: asString(o.apiKey),
      model: providerModel(engine, raw),
      raw,
    };
  });
}

/**
 * Window event fired after any CLI config mutation so the chat tree
 * (ChatConversation's model picker) refetches — it caches getCliConfig on
 * mount and never re-reads otherwise.
 */
export const CLI_CONFIG_CHANGED_EVENT = "hzkcode:cli-config-changed";

export function notifyCliConfigChanged() {
  window.dispatchEvent(new Event(CLI_CONFIG_CHANGED_EVENT));
}

/** Per-engine default channel (`section.current`). Unset / empty → 官方配置. */
export function engineCurrents(
  config: Pick<Record<EngineId, ProviderSection | undefined>, EngineId>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ENGINE_IDS) {
    const current = config[id]?.current?.trim();
    out[id] = current || PSEUDO_LOCAL;
  }
  return out;
}
