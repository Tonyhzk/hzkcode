import { useMemo } from "react";
import { EFFORT_LEVELS, type EffortLevel } from "@/components/application/ai-chat/effort-levels";
import { normalizeTierAlias } from "@/features/settings/providers";
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
 * 引擎 3.5.1 之后，会话文件里保存的 model/effort 才是权威：用户没有在
 * 本会话重新选择时（control*Chosen 为假），菜单显示 state 的 override，
 * 其次 effective。override 里的 high/mid/low 档位别名必须原样保留。
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
  const sessionControl = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.sessionControl ?? null) : null,
  );
  const controlModelChosen = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.controlModelChosen ?? false) : false,
  );
  const controlEffortChosen = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.controlEffortChosen ?? false) : false,
  );
  const savedModel = sessionControl?.state
    ? (sessionControl.state.model.override ??
      sessionControl.state.model.effective)
    : null;
  const savedEffort = sessionControl?.state
    ? (sessionControl.state.effort.override ??
      sessionControl.state.effort.effective)
    : null;
  const tabModel = useMemo(() => {
    if (!active || active.engine !== activeEngine) return undefined;
    // 用户在本会话显式选过模型时以 tab/channel 为准；否则会话保存值优先，
    // 档位别名只做旧拼写归一，high/mid/low 保持不变。
    const pick =
      !controlModelChosen && savedModel
        ? savedModel
        : active.model || channelDefault || models[activeEngine];
    return pick ? normalizeTierAlias(pick) : undefined;
  }, [
    active,
    activeEngine,
    channelDefault,
    models,
    controlModelChosen,
    savedModel,
  ]);
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
    if (!controlEffortChosen) {
      // number/null 不在滑杆的能力范围内，不做猜测映射：只有合法档位
      // 字符串才覆盖显示。
      const controlled = asEffortLevel(
        typeof savedEffort === "string" ? savedEffort : null,
      );
      if (controlled) return controlled;
    }
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
    controlEffortChosen,
    savedEffort,
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
