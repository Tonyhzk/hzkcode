import { useMemo } from "react";
import { EFFORT_LEVELS, type EffortLevel } from "@/components/application/ai-chat/effort-levels";
import { useChatStore, type ActiveSession } from "../store";

/** Session records and history rows carry plain strings; anything that is not
 *  one of the picker's stops (a hand-edited settings file, an engine that
 *  reports its own vocabulary) is ignored instead of shown as a level. */
function asEffortLevel(value: string | null | undefined): EffortLevel | undefined {
  return value && (EFFORT_LEVELS as readonly string[]).includes(value)
    ? (value as EffortLevel)
    : undefined;
}

/** Channel the composer menus show for the active tab. Split from the model
 *  hook because the engine-model list (which feeds the channel default the
 *  model hook consumes) resolves against the session's channel: providers
 *  first, then the model list, then the model display. */
export function useTabDisplayProviders({
  active,
  activeEngine,
  sessionKey,
  providers,
}: {
  active: ActiveSession | null;
  activeEngine: string;
  sessionKey: string;
  providers: Record<string, string>;
}) {
  // Channel has no transcript scan: native files never record it. Tab
  // override only on a pending new-chat (same as effort).
  const sessionActiveProvider = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.activeProvider ?? null) : null,
  );
  const tabProvider = useMemo(() => {
    if (!active || active.engine !== activeEngine) return undefined;
    return (
      (active.sessionId === null ? active.provider : undefined) ||
      sessionActiveProvider ||
      providers[activeEngine]
    );
  }, [active, activeEngine, sessionActiveProvider, providers]);
  return useMemo(
    () =>
      tabProvider !== undefined
        ? { ...providers, [activeEngine]: tabProvider }
        : providers,
    [tabProvider, providers, activeEngine],
  );
}

/** Model/effort the composer menus show for the active tab.
 *
 * The model follows the USER, not the transcript: an explicit pick for this
 * tab, else the channel's default model (what the channel is configured to
 * serve). Values restored from history or engine-reported records are
 * deliberately not sources — a model recorded under an old channel config
 * may no longer exist, and resurrecting it surfaced dead ids (and the
 * engine-name fallback) in the composer. The send resolver reads the same
 * value (see repairSessionModel), so display and send never diverge.
 *
 * Subscribed as two narrow slices (strings, Object.is-compared) instead of
 * the bySession record: stream flushes swap that record every frame, and
 * the composer must not re-render with it (SessionTimeline owns that). */
export function useTabModelDisplay({
  active,
  activeEngine,
  sessionKey,
  models,
  efforts,
  channelDefault,
}: {
  active: ActiveSession | null;
  activeEngine: string;
  sessionKey: string;
  models: Record<string, string>;
  efforts: Record<string, EffortLevel>;
  /** The channel's default model for the active engine (see channelDefaults
   *  in use-engine-models); undefined until the config/catalog has loaded. */
  channelDefault?: string;
}) {
  const tabModel = useMemo(() => {
    if (!active || active.engine !== activeEngine) return undefined;
    // tab pick → the channel's default model → the stored pick (pre-config
    // only, while the channel context is still loading).
    return active.model || channelDefault || models[activeEngine];
  }, [active, activeEngine, channelDefault, models]);
  const sessionActiveEffort = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.activeEffort ?? null) : null,
  );
  const sessionHistoryEffort = useChatStore((s) => {
    if (!sessionKey) return null;
    const messages = s.bySession[sessionKey]?.messages;
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const effort = messages[i].effort;
      if (effort) return effort;
    }
    return null;
  });
  const tabEffort = useMemo(() => {
    if (!active || active.engine !== activeEngine) return undefined;
    return (
      asEffortLevel(active.sessionId === null ? active.effort : undefined) ||
      asEffortLevel(sessionActiveEffort) ||
      asEffortLevel(sessionHistoryEffort) ||
      asEffortLevel(efforts[activeEngine])
    );
  }, [
    active,
    activeEngine,
    sessionActiveEffort,
    sessionHistoryEffort,
    efforts,
  ]);
  const displayModels = useMemo(
    () =>
      tabModel !== undefined ? { ...models, [activeEngine]: tabModel } : models,
    [tabModel, models, activeEngine],
  );
  const displayEfforts = useMemo(() => {
    // Drop stored levels the ladder no longer knows (e.g. a persisted
    // "ultra" from before it was removed): an unknown key would render as a
    // raw i18n key and confuse the slider.
    const sanitized = Object.fromEntries(
      Object.entries(efforts).filter(([, level]) => asEffortLevel(level)),
    ) as Record<string, EffortLevel>;
    return tabEffort !== undefined
      ? { ...sanitized, [activeEngine]: tabEffort }
      : sanitized;
  }, [tabEffort, efforts, activeEngine]);
  return { displayModels, displayEfforts };
}
