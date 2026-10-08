import type { CliConfig, EngineCatalog } from "@/lib/ipc";
import {
  isPseudoProvider,
  isTierSpell,
  normalizeTierAlias,
  providerCustomModels,
  providerModel,
  PSEUDO_LOCAL,
  stripContextSuffix,
  type EngineId,
} from "@/features/settings/providers";

/** Channel-record reads and the fallback-pick chain shared by the picker's
 *  model lists (use-engine-models) and the store's send resolution. Pure
 *  config math — no hooks — so a queue send resolves the same default the
 *  composer displays, on the session's own channel. */

/** Raw record of a channel. `channelId` empty → engine `section.current`. */
export function channelRaw(
  engineId: string,
  cliConfig: CliConfig | null,
  channelId?: string,
): unknown {
  const section = cliConfig?.[engineId as EngineId];
  const id = (channelId || section?.current || "").trim();
  if (!id || isPseudoProvider(id)) return undefined;
  return section?.providers?.[id];
}

export function configuredModel(
  engineId: string,
  cliConfig: CliConfig | null,
  channelId?: string,
): string {
  const raw = channelRaw(engineId, cliConfig, channelId);
  return raw ? providerModel(engineId as EngineId, raw).trim() : "";
}

/** Custom model ids of a channel record (`channelId` empty → engine default). */
export function channelCustomModels(
  engineId: string,
  cliConfig: CliConfig | null,
  channelId?: string,
): string[] {
  return providerCustomModels(channelRaw(engineId, cliConfig, channelId));
}

/** Tier → channel env key: the picker's tier ids (high/mid/low — the CLI's
 *  own alias spell since 3.1.1) run whichever model the active channel maps
 *  them to, so they must display that model instead of the bare tier name. */
export const TIER_ENV_KEYS: Record<string, string> = {
  high: "HZKCODE_DEFAULT_HIGH_MODEL",
  mid: "HZKCODE_DEFAULT_MID_MODEL",
  low: "HZKCODE_DEFAULT_LOW_MODEL",
};

/** Tier → the tier name the UI shows. The app speaks High/Mid/Low, matching
 *  the env variables and (since 3.1.1) the CLI's own aliases. */
export const TIER_LABELS: Record<string, string> = {
  high: "High",
  mid: "Mid",
  low: "Low",
};

/** The explicit default's effective value: raw ids pass through; a tier
 *  alias counts only while its tier is mapped — an unmapped alias would
 *  resolve to the CLI's built-in family default, which a relay may not
 *  serve, so the ladder keeps falling through. "" = unset. */
function effectiveExplicit(
  explicit: string,
  tiers: Record<string, string>,
): string {
  if (!explicit) return "";
  if (TIER_ENV_KEYS[explicit] && !tiers[explicit]) return "";
  return explicit;
}

/** Alias → configured model id of the channel (settingsConfig.env first,
 *  then the flat env shape — the same order providerModel reads). Values
 *  normalize on read: the retired context suffix is stripped and legacy
 *  family aliases map to their tier spell. The "default" alias stands for
 *  the explicit default model — displayed as the tier it names when the
 *  value is one of the tiers (the dialog's default picker stores "mid"
 *  etc.) — or the mid tier when that is blank (the app's default tier). */
export function channelTierModels(
  engineId: string,
  cliConfig: CliConfig | null,
  channelId?: string,
): Record<string, string> {
  const raw = channelRaw(engineId, cliConfig, channelId);
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const settingsEnv = (o.settingsConfig as Record<string, unknown> | undefined)?.env;
  const flatEnv = o.env;
  const pick = (key: string): string => {
    for (const source of [settingsEnv, flatEnv]) {
      if (source && typeof source === "object") {
        const value = (source as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim()) {
          const normalized = normalizeTierAlias(stripContextSuffix(value));
          // A tier binding must hold a concrete model id: the engine drops a
          // tier spelling when injecting, so reads treat it as unset too.
          if (isTierSpell(normalized)) return "";
          return normalized;
        }
      }
    }
    return "";
  };
  const out: Record<string, string> = {};
  for (const [alias, key] of Object.entries(TIER_ENV_KEYS)) {
    const value = pick(key);
    if (value) out[alias] = value;
  }
  const configured = effectiveExplicit(
    configuredModel(engineId, cliConfig, channelId),
    out,
  );
  const modelDefault =
    (configured && out[configured]) || configured || out.mid || out.high;
  if (modelDefault) out.default = modelDefault;
  return out;
}

/** The pick a session lands on when it has no explicit model of its own: the
 *  channel's configured default, else the tier ladder — mid (the app's
 *  default tier), then high, then low — then the first custom model, and a
 *  bare mid alias as the last resort. Only ids the picker already offers are
 *  returned (tier aliases, never their mapped concrete names), so the value
 *  reads, selects and resolves exactly like a user pick. */
export function channelDefaultPick(
  engineId: string,
  cliConfig: CliConfig | null,
  channelId?: string,
): string {
  const tiers = channelTierModels(engineId, cliConfig, channelId);
  const explicit = effectiveExplicit(
    configuredModel(engineId, cliConfig, channelId),
    tiers,
  );
  if (explicit) return explicit;
  if (tiers.mid) return "mid";
  if (tiers.high) return "high";
  if (tiers.low) return "low";
  const custom = channelCustomModels(engineId, cliConfig, channelId)[0];
  if (custom) return custom;
  return "mid";
}

/** engine → channel id → default pick, for every configured channel plus the
 *  official/pseudo fallback key. The store recomputes this whenever the CLI
 *  config is (re)loaded, so the send path never depends on the UI having
 *  probed a channel first. */
export function computeChannelDefaults(
  cliConfig: CliConfig | null,
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  if (!cliConfig) return result;
  for (const [engineId, section] of Object.entries(cliConfig)) {
    if (!section) continue;
    const byChannel: Record<string, string> = {};
    for (const channelId of Object.keys(section.providers ?? {})) {
      byChannel[channelId] = channelDefaultPick(engineId, cliConfig, channelId);
    }
    // The official/pseudo key is the OFFICIAL resolution — a channel-less
    // pick (aliases resolve against the CLI's own config) — never the
    // current custom channel's default. Unknown/removed channels degrade
    // here too instead of borrowing the custom channel's mapping.
    byChannel[PSEUDO_LOCAL] = channelDefaultPick(engineId, null);
    result[engineId] = byChannel;
  }
  return result;
}

/** Ids the given channel can actually serve: the backend catalog's ids, the
 *  channel's MAPPED TIER ALIASES (independent of the catalog — a failed or
 *  empty probe must not invalidate the channel's configured tiers), the
 *  channel's own configured default and custom list. Unlike the picker's
 *  list this has no stored-value append and no other channel's models, so it
 *  is the verdict source for "is this override still servable" (and the
 *  global default's validation keeps its own merged set). */
export function channelSelectableIds(
  engineId: string,
  cliConfig: CliConfig | null,
  channelId: string | undefined,
  catalog: EngineCatalog | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const model of catalog?.models ?? []) ids.add(model.id);
  // Remote (WSL 发行版) catalog: the distro CLI's own list is the whole menu.
  if (catalog?.remote) return ids;
  const configured = configuredModel(engineId, cliConfig, channelId);
  if (configured) ids.add(configured);
  const tiers = channelTierModels(engineId, cliConfig, channelId);
  for (const alias of Object.keys(TIER_ENV_KEYS)) {
    if (tiers[alias]) ids.add(alias);
  }
  for (const id of channelCustomModels(engineId, cliConfig, channelId)) {
    ids.add(id);
  }
  return ids;
}

/** The channel default for one session's channel, degrading to the official
 *  key when the channel is unknown. */
export function findChannelDefault(
  defaults: Record<string, Record<string, string>>,
  engine: string,
  channelId: string | null | undefined,
): string | undefined {
  const byChannel = defaults[engine];
  if (!byChannel) return undefined;
  if (channelId && byChannel[channelId]) return byChannel[channelId];
  return byChannel[PSEUDO_LOCAL];
}
