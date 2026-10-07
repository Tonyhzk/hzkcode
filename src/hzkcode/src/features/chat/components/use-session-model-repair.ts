import { useEffect } from "react";
import type { ActiveSession } from "../store/persistence";

/** Drops a dead per-tab model override.
 *
 *  The composer's model follows the user's explicit pick for this tab, else
 *  the channel default. A pick the channels no longer serve (an old relay's
 *  "hzk-model", a removed custom id) would otherwise surface as the engine
 *  name in the model slot, because the picker cannot find it in the model
 *  list. Clearing the override lets the resolution fall through to the
 *  channel default — what the channel is configured to serve — and the
 *  store's send path reads the same resolution, so display and send agree.
 *
 *  Validity uses the servable id set of the session's own channel
 *  (`sessionIds`), NOT the picker list: the picker list appends the stored
 *  current value so the selection never vanishes, which would make a stale
 *  stored value look servable. Gated on `ready` (channel config AND catalog
 *  loaded): until then the channel's own models are unknown and a valid pick
 *  would be judged dead. */
export function useSessionModelRepair({
  active,
  activeEngine,
  sessionIds,
  ready,
  repair,
}: {
  /** Active tab; drafts are covered too (their first send reads the same). */
  active: ActiveSession | null;
  activeEngine: string;
  /** Ids the session's channel can serve (see sessionIdsByEngine). */
  sessionIds: Record<string, Set<string>>;
  ready: Record<string, true>;
  repair: (
    engine: string,
    sessionId: string | null,
    workspacePath: string,
    staleStamp: string,
  ) => void;
}) {
  const served = sessionIds[activeEngine];
  const isReady = ready[activeEngine] === true;
  useEffect(() => {
    if (!active || active.engine !== activeEngine) return;
    if (!isReady || !served) return;
    const stamp = active.model;
    if (!stamp || served.has(stamp)) return;
    repair(active.engine, active.sessionId, active.workspacePath, stamp);
  }, [active, activeEngine, isReady, served, repair]);
}
