import { create } from "zustand";
import {
  ipc,
  type SessionMeta,
  type SessionPage,
  type Workspace,
  type WorkspaceGroup,
  type EngineInfo,
} from "@/lib/ipc";
import type { EffortLevel } from "@/components/application/ai-chat/cli-menu";
import { pruneMentionIndex } from "@/components/application/ai-chat/mention-files";
import { pruneSlashCommands } from "@/components/application/ai-chat/slash-commands";
import { stripAgentBlock } from "./components/agent-block";
import { listenEngineEvents, listenSessionsChanged } from "@/lib/events";
import { errorText } from "@/lib/errors";
import { readStoredJson, writeStored } from "@/lib/storage";
import { windowContext } from "@/lib/window-context";
import { newId } from "@/lib/id";
import { subscribeTauriEvent } from "@/hooks/use-tauri-event";
import {
  CLI_CONFIG_CHANGED_EVENT,
  engineCurrents,
  normalizeTierAlias,
  notifyCliConfigChanged,
} from "@/features/settings/providers";
import {
  ENGINE_PREF_KEY,
  PERMISSION_PREF_KEY,
  dedupeTabs,
  persistTabs,
  readPersistedActive,
  readPersistedTabs,
  sameTab,
  sessionKey,
  type ActiveSession,
} from "./store/persistence";
import {
  EMPTY_SESSION,
  applyStreamParts,
  drainPending,
  lastRowIndexByUuid,
  moveStreamingFlag,
  patchSession,
  pendingRewindByRun,
  resolveSessionModel,
  resolveSessionEffort,
  resolveSessionProvider,
  routeRun,
  rememberSettledRun,
  runRouting,
  setStreamingFlag,
  settleLiveRows,
  untrackRun,
} from "./store/stream";
import {
  computeChannelDefaults,
  findChannelDefault,
} from "./store/channel-defaults";
import { mergeUsage, parseUsage } from "./usage";
import {
  dropRunUsage,
  firstLineTitle,
  handleEngineEvents,
  optimisticMeta,
  patchGrantBySeq,
  rememberModelForRun,
  rememberEffortForRun,
  patchPermissionByRequestId,
  patchQuestionByRequestId,
  rememberProviderForRun,
  settleOrphanedRuns,
  upsertSessionMetaInto,
} from "./store/engine-events";
import { effectivePermission, readPermissionPref } from "./store/permissions";
import i18n from "@/lib/i18n";
import {
  clearSelectedAgent,
  getRecordedAgent,
  getSelectedAgent,
  migrateRecordedAgent,
  migrateSelectedAgent,
  selectSelectedAgent,
  setRecordedAgent,
} from "@/features/agents/selected-agent";
import { useAgentStore } from "@/features/agents/agent-store";
import { persistSettings } from "./store/settings-persist";
import {
  listExternalSessionMetas,
  setSessionSourcesChangedCallback,
} from "@/features/plugins/runtime/session-source";
import { emitSessionActivated } from "@/features/plugins/runtime/events";
import { appendCommittedRows, mergeExternalSessions, preserveUnscannedSessions, visibleSessions } from "./store/session-utils";
import type { ChatStore } from "./store/types";

// Facade re-exports: callers keep importing everything from "../store".
export { parseDraftSessionKey, sessionKey } from "./store/persistence";
export type { ActiveSession } from "./store/persistence";
export type { QueuedMessage, SessionState } from "./store/stream";
export type { ChatStore } from "./store/types";
export { effectivePermission } from "./store/permissions";
export { sortedWorkspaceGroups } from "./store/session-utils";

/** Unlisteners for the module-scope event subscriptions set up in init. */
const eventTeardowns: Array<() => void> = [];
function omitKey(rec: Record<string, boolean>, key: string) {
  const next = { ...rec };
  delete next[key];
  return next;
}

/** Load a page of session history, routing remote (plugin-fed, e.g. WSL
 *  distro CLI) transcripts through the host's remote fetch instead of the
 *  local db lookup. `meta` is looked up from the current session catalog
 *  when not supplied (usage refresh can't key by workspace). */
function loadHistoryPage(
  engine: string,
  sessionId: string,
  workspacePath: string,
  limit?: number,
  beforeSeq?: number | null,
  meta?: SessionMeta,
): Promise<SessionPage> {
  const m =
    meta ??
    useChatStore
      .getState()
      .sessions.find(
        (s) =>
          s.engine === engine &&
          s.sessionId === sessionId &&
          s.workspacePath === workspacePath,
      );
  if (m?.remote && m.remotePath) {
    return ipc.loadRemoteSessionPage(
      workspacePath,
      engine,
      sessionId,
      m.remotePath,
      limit,
      beforeSeq,
    );
  }
  return beforeSeq === undefined
    ? ipc.loadSessionPage(engine, sessionId, limit)
    : ipc.loadSessionPage(engine, sessionId, limit, beforeSeq);
}

/** Whether a transcript prompt entry and the local echo hold the same text:
 *  the file carries the agent block a send appended (history parsing keeps
 *  it), so compare after stripping it — and by equality, since containment
 *  would let a short "继续" match any old prompt carrying the word. */
function textsAlign(historyText: string, localText: string): boolean {
  return (
    stripAgentBlock(historyText).text.trim() ===
    stripAgentBlock(localText).text.trim()
  );
}

/** Pending per-session rewind points (sessionKey → message uuid): see
 *  setRewindAnchor. Persisted so a restart keeps an unspent rewind — the
 *  transcript is untouched until the send carrying it runs. */
const REWIND_ANCHORS_KEY = "hzkcode.rewindAnchors:v1";
function readRewindAnchors(): Record<string, string> {
  return (
    readStoredJson(REWIND_ANCHORS_KEY, (value) =>
      value && typeof value === "object"
        ? (value as Record<string, string>)
        : null,
    ) ?? {}
  );
}

export const useChatStore = create<ChatStore>((set, get) => {
  /** Activate a tab: existing sessions lazy-load via selectSession, pending chats just set. */
  function activateTab(tab: ActiveSession | null) {
    if (!tab) {
      set({ active: null });
      persistTabs(get().openTabs, null);
      emitSessionActivated(null, null);
      return;
    }
    if (tab.sessionId)
      void get().selectSession(tab.engine, tab.sessionId, tab.workspacePath);
    else {
      // A pending tab sends with its own engine, so the picker must follow it
      // — otherwise the chip shows one CLI while sends go to another.
      const syncEngine = tab.engine !== get().activeEngine;
      if (syncEngine) writeStored(ENGINE_PREF_KEY, tab.engine);
      set(
        syncEngine
          ? { active: tab, activeEngine: tab.engine }
          : { active: tab },
      );
      persistTabs(get().openTabs, tab);
      emitSessionActivated(tab.engine, null);
    }
  }

  /** Stamp a per-tab composer override (model/effort) onto the active tab, so
   * the picker follows each session across tab switches. Persists with the
   * tab list; no-op without an active tab. */
  function stampActiveTab(patch: Partial<ActiveSession>) {
    set((s) => {
      const current = s.active;
      if (!current) return {};
      const active: ActiveSession = { ...current, ...patch };
      const openTabs = s.openTabs.map((t) =>
        sameTab(t, current.engine, current.sessionId, current.workspacePath)
          ? active
          : t,
      );
      persistTabs(openTabs, active);
      return { openTabs, active };
    });
  }

  /** Reopen cache for closed tabs: keys whose bySession entry survives tab
   * close so selectSession skips a backend reload, most-recently-closed
   * last. Bounded — the oldest non-streaming entries beyond the cap are
   * evicted, so the cache cannot grow forever. */
  const CLOSED_CACHE_LIMIT = 10;
  const closedTabCache: string[] = [];

  function rememberClosedTab(key: string) {
    const i = closedTabCache.indexOf(key);
    if (i >= 0) closedTabCache.splice(i, 1);
    closedTabCache.push(key);
    // Keys whose tab is open again are not "closed" anymore.
    const openKeys = new Set(
      get().openTabs.map((t) =>
        sessionKey(t.engine, t.sessionId, t.workspacePath),
      ),
    );
    for (let j = closedTabCache.length - 1; j >= 0; j--) {
      if (openKeys.has(closedTabCache[j])) closedTabCache.splice(j, 1);
    }
    let overflow = closedTabCache.length - CLOSED_CACHE_LIMIT;
    if (overflow <= 0) return;
    const evict: string[] = [];
    for (const cached of closedTabCache) {
      if (overflow <= 0) break;
      // A streaming closed tab still receives events — never evict it.
      if (get().streamingByKey[cached]) continue;
      evict.push(cached);
      overflow--;
    }
    if (evict.length === 0) return;
    for (const cached of evict) {
      closedTabCache.splice(closedTabCache.indexOf(cached), 1);
    }
    set((s) => {
      const bySession = { ...s.bySession };
      for (const cached of evict) delete bySession[cached];
      return { bySession };
    });
  }

  /** Remove a tab; when it was active, fall back to its nearest neighbor. */
  function removeTab(
    engine: string,
    sessionId: string | null,
    workspacePath: string,
  ) {
    const s = get();
    const idx = s.openTabs.findIndex((t) =>
      sameTab(t, engine, sessionId, workspacePath),
    );
    if (idx < 0) return;
    const openTabs = s.openTabs.filter((_, i) => i !== idx);
    set({ openTabs });
    rememberClosedTab(sessionKey(engine, sessionId, workspacePath));
    if (s.active && sameTab(s.active, engine, sessionId, workspacePath)) {
      activateTab(openTabs[Math.min(idx, openTabs.length - 1)] ?? null);
    } else {
      persistTabs(openTabs, s.active);
    }
  }

  /** The CLI requires a non-empty agent description in `--agents` JSON; the
   *  GUI stores no separate field, so derive one from the prompt's first
   *  non-empty line. */
  function agentDescription(name: string, prompt: string): string {
    const line = prompt
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    const base = line ?? name;
    return base.length > 120 ? `${base.slice(0, 117)}…` : base;
  }

  /**
   * Send a prompt to a specific tab. Unlike the public `send` action this is
   * not bound to the active session, so the queue can drain on a background
   * tab after its turn finishes there.
   */
  async function sendPrompt(
    tab: ActiveSession,
    prompt: string,
    images: string[],
  ) {
    if (!prompt.trim() && images.length === 0) return;
    // A pinned agent becomes this session's CLI main-thread agent: the
    // launch carries its definition as `--agents` JSON and selects it with
    // `--agent`, so headless sessions run under the agent's system prompt
    // and the CLI re-derives it on resume.
    let selectedAgent = getSelectedAgent(tab.workspacePath, tab.sessionId);
    // The persisted pin snapshots the record picked at selection time; edits
    // made later in settings must still apply to pinned sessions, so refresh
    // it from the catalog (built-in picks resolve their own prompt below).
    if (selectedAgent && selectedAgent.source !== "builtIn") {
      const pinned = selectedAgent;
      const fresh = useAgentStore
        .getState()
        .agents.find((agent) => agent.id === pinned.id);
      if (fresh) selectedAgent = { ...pinned, ...fresh };
    }
    // Built-in resolve failures are re-flagged after the optimistic-turn
    // patch below (which resets `error` for the new turn).
    let agentResolveError: string | null = null;
    let agentName: string | null = null;
    let agentsJson: string | null = null;
    // Identity overrides for this send: tool whitelist, model and effort.
    let agentTools: string[] | null = null;
    let identityModel: string | null = null;
    let identityEffort: string | null = null;
    if (selectedAgent) {
      let resolvedName = selectedAgent.name;
      let resolvedPrompt: string | null = null;
      if (selectedAgent.source === "builtIn") {
        // Built-in picks store no prompt: resolve the current catalog prompt
        // at send time. A since-disabled catalog entry fails the resolve —
        // drop the stale pin, surface the session error banner, and still
        // send without an agent.
        try {
          const resolved = await ipc.resolveEnabledBuiltInAgent(selectedAgent.id);
          resolvedName = resolved.name;
          resolvedPrompt = resolved.prompt ?? null;
        } catch {
          clearSelectedAgent(tab.workspacePath, tab.sessionId);
          agentResolveError = i18n.t("chat.agentUnavailable");
        }
      } else {
        resolvedPrompt = selectedAgent.prompt ?? null;
      }
      if (agentResolveError === null) {
        // The CLI rejects an empty prompt in an agent definition, and the
        // definition is what carries the identity on resume — so an identity
        // that only configures tools/model gets a minimal prompt line
        // instead of silently losing everything at send time.
        resolvedPrompt =
          resolvedPrompt?.trim() ||
          i18n.t("chat.agentDefaultPrompt", { name: resolvedName });
        agentName = resolvedName;
        // 3.1.0：自定义身份缺省不注入内置规范、CLAUDE.md/Rules 与个人
        // 记忆。身份限定后按限定集合下发；未限定时显式声明全量——GUI 的
        // 智能体是叠加在完整上下文上的角色预设，保持既有行为。
        const context = selectedAgent.context ?? [
          "prompts",
          "claudemd",
          "memory",
        ];
        // The whitelist rides the launch flag below: the headless path does
        // not read a definition's tool list. An empty list (disable every
        // tool) is preserved as-is.
        agentTools = selectedAgent.tools ?? null;
        identityModel = selectedAgent.model
          ? normalizeTierAlias(selectedAgent.model)
          : null;
        identityEffort = selectedAgent.effort ?? null;
        agentsJson = JSON.stringify({
          [resolvedName]: {
            description: agentDescription(resolvedName, resolvedPrompt),
            prompt: resolvedPrompt,
            context,
            // The definition carries the other knobs too, so a session later
            // resumed from the terminal keeps them (the launch flags are the
            // headless source of truth).
            ...(agentTools ? { tools: agentTools } : {}),
            ...(identityModel ? { model: identityModel } : {}),
            ...(identityEffort ? { effort: identityEffort } : {}),
          },
        });
      }
    }
    const engine = tab.engine;
    const key = sessionKey(engine, tab.sessionId, tab.workspacePath);
    // Identity switch on a conversation that already has messages clones it
    // (the CLI's /agents semantics): the original session keeps its identity,
    // the new one continues under the picked identity. Drafts and empty
    // conversations switch in place — the host reports nothing to clone.
    // The baseline is the identity this app last sent with; when it has no
    // record yet (a CLI-created session, or a cleared store), the identity
    // recorded in the session file itself stands in.
    let recordedAgent = getRecordedAgent(tab.workspacePath, tab.sessionId);
    if (recordedAgent === undefined && tab.sessionId) {
      try {
        recordedAgent = await ipc.getSessionAgentSetting(engine, tab.sessionId);
      } catch {
        recordedAgent = undefined;
      }
    }
    if (
      tab.sessionId &&
      agentResolveError === null &&
      (recordedAgent ?? null) !== (agentName ?? null)
    ) {
      let cloned: { sessionId: string; cloned: boolean } | null = null;
      try {
        cloned = await ipc.cloneSession(engine, tab.sessionId, tab.workspacePath);
      } catch (error) {
        patchSession(set, key, { error: errorText(error) });
        return;
      }
      if (cloned.cloned && cloned.sessionId !== tab.sessionId) {
        // The clone carries the new pick; the source session goes back to
        // the identity it was running under (the recorded baseline), so
        // returning there resumes that identity instead of cloning again.
        const previous = recordedAgent ?? null;
        const previousDefinition =
          previous === null
            ? null
            : (useAgentStore
                .getState()
                .agents.find((agent) => agent.name === previous) ?? null);
        const previousBuiltIn =
          previousDefinition || previous === null
            ? undefined
            : useAgentStore
                .getState()
                .builtInAgents.find((agent) => agent.name === previous);
        if (previousDefinition) {
          selectSelectedAgent(
            tab.workspacePath,
            tab.sessionId,
            previousDefinition,
          );
        } else if (previousBuiltIn) {
          selectSelectedAgent(tab.workspacePath, tab.sessionId, {
            id: previousBuiltIn.id,
            name: previousBuiltIn.name,
            source: "builtIn",
          });
        } else {
          // No previous identity, or its definition is gone (deleted or
          // disabled): the source is identity-less, matching what the CLI
          // can restore for it.
          clearSelectedAgent(tab.workspacePath, tab.sessionId);
          setRecordedAgent(tab.workspacePath, tab.sessionId, null);
        }
        setRecordedAgent(tab.workspacePath, cloned.sessionId, agentName);
        if (selectedAgent) {
          selectSelectedAgent(tab.workspacePath, cloned.sessionId, selectedAgent);
        } else {
          clearSelectedAgent(tab.workspacePath, cloned.sessionId);
        }
        await get().refreshSessions();
        await get().selectSession(engine, cloned.sessionId, tab.workspacePath);
        const nextTab = get().active;
        if (nextTab?.sessionId === cloned.sessionId) {
          return sendPrompt(nextTab, prompt, images);
        }
        patchSession(set, key, { error: i18n.t("chat.agentCloneFailed") });
        return;
      }
    }
    // The channel this send spawns on: the session's own channel, else the
    // engine's current one. Hoisted so the model resolve below reads the
    // same channel's default.
    const provider =
      resolveSessionProvider(
        tab,
        get().bySession[key],
        get().providers[engine],
      ) ?? null;
    // The rewind point THIS send carries — read from the SHARED persisted map
    // at send time, never this window's cached copy: another window may have
    // set, moved, or cancelled the point since this one loaded. No entry =
    // no rewind. Consumed only when the run settles (see pendingRewindByRun).
    const rewindForSend = readRewindAnchors()[key] ?? null;
    // The model the next turn runs: the session's explicit pick, else the
    // default of the channel it spawns on — what that channel is configured
    // to serve (transcript history is deliberately not a source; see
    // resolveSessionModel). A pinned identity's model wins over both — the
    // identity pins its own model (see the identity editor).
    const model =
      identityModel ||
      resolveSessionModel(
        tab,
        findChannelDefault(get().channelDefaults, engine, provider),
        get().models[engine],
      ) ||
      null;
    // Remember what this session runs, spelled as the picker spells it: the
    // engine's own transcript keeps only the bare model name, so this record
    // is what a restart or another client reads back (see
    // ipc.rememberSessionModel). A brand-new session has no id yet — its
    // `session` event carries the model instead.
    if (model) {
      if (tab.sessionId) {
        void ipc
          .rememberSessionModel(engine, tab.sessionId, model)
          .catch(() => {});
      } else {
        rememberModelForRun(key, model);
      }
    }
    // Same override rule as the model: a pinned identity's level wins when
    // set.
    const effort =
      identityEffort ??
      resolveSessionEffort(tab, get().bySession[key], get().efforts[engine]) ??
      null;
    // Remember the level the way the model is remembered: the picker follows
    // the session, so a reopened session — here, in another window, or on the
    // phone — keeps running the level it ran instead of the engine default.
    if (effort) {
      if (tab.sessionId) {
        void ipc
          .rememberSessionEffort?.(engine, tab.sessionId, effort)
          ?.catch(() => {});
      } else {
        rememberEffortForRun(key, effort);
      }
    }
    if (provider) {
      if (tab.sessionId) {
        void ipc
          .rememberSessionProvider?.(engine, tab.sessionId, provider)
          ?.catch(() => {});
      } else {
        rememberProviderForRun(key, provider);
      }
    }
    // A rewinded send continues from the surviving prefix: trim the in-memory
    // conversation at the anchor (inclusive) before anything appends, so the
    // streaming reply stays visible and the withdrawn tail cannot resurface
    // in memory. The display anchor is dropped with it — the list itself now
    // is the range; the PERSISTED anchor stays until the run settles (a send
    // that never lands must rewind again on the retry).
    if (rewindForSend) {
      set((s) => {
        const cur = s.bySession[key];
        if (!cur) return {};
        const index = lastRowIndexByUuid(cur.messages, rewindForSend);
        if (index < 0) return {};
        return {
          bySession: {
            ...s.bySession,
            [key]: {
              ...cur,
              messages: cur.messages.slice(0, index + 1),
              rewindAnchor: null,
            },
          },
        };
      });
    }
    // Optimistic user message.
    set((s) => ({
      streamingByKey: setStreamingFlag(s.streamingByKey, key, true),
    }));
    appendCommittedRows(
      set,
      key,
      [
        {
          role: "user",
          text: prompt,
          ts: new Date().toISOString(),
          images: images.length ? [...images] : undefined,
        },
      ],
      {
        streaming: true,
        error: null,
        interrupted: false,
        turnStartedAt: Date.now(),
        activeModel: model,
        activeEffort: effort,
        activeProvider: provider,
        // The tail indicator counts this reply, not the one before it.
        turnUsage: null,
      },
    );
    // Refresh independently: a slow history read must not delay sending or Stop.
    void get().refreshSessionUsage(key);
    const requestedRunId = `run-${newId()}`;
    settleOrphanedRuns(set, routeRun(requestedRunId, key));
    if (agentResolveError) {
      patchSession(set, key, { error: agentResolveError });
    }
    // Register the rewind anchor under the provisional run id BEFORE the
    // invocation: a whole turn can settle before the invoke resolves, and
    // its consume must find the entry. A backend that renames the run
    // migrates it below.
    if (rewindForSend) pendingRewindByRun.set(requestedRunId, rewindForSend);
    try {
      const result = await ipc.sendMessage({
        runId: requestedRunId,
        engine,
        workspacePath: tab.workspacePath,
        sessionId: tab.sessionId,
        prompt,
        imagePaths: images.length ? images : null,
        model,
        effort,
        permission: effectivePermission(
          get().engines,
          engine,
          get().permission,
        ),
        providerId: provider,
        agentName,
        agentsJson,
        agentTools,
        // Session proxy switch (the composer's 会话开关, the CLI's /proxy):
        // null keeps the app/shell default for this send.
        proxyEnabled: get().bySession[key]?.proxyEnabled ?? null,
        // Session second-brain switch (the CLI's /second-brain).
        secondBrainEnabled: get().bySession[key]?.secondBrainEnabled ?? null,
        // Session context-window override (the CLI's /maxtokens): null keeps
        // the app/shell default for this send.
        autoCompactWindow: get().bySession[key]?.autoCompactWindow ?? null,
        // Pending conversation rewind (the 回退 action): the CLI truncates
        // the resumed transcript to this message, inclusive, before the run.
        rewindTo: rewindForSend,
      });
      // Record the identity only after the send landed: a failed spawn or a
      // permission denial keeps the previous value, so the retry still
      // clones on an identity change.
      setRecordedAgent(
        tab.workspacePath,
        result.sessionId ?? tab.sessionId,
        agentName,
      );
      // Older backends choose their own id. Retire the provisional route —
      // and carry the pending rewind anchor over to the real id.
      if (result.runId !== requestedRunId) {
        runRouting.delete(requestedRunId);
        untrackRun(requestedRunId);
        const pendingRewind = pendingRewindByRun.get(requestedRunId);
        if (pendingRewind) {
          pendingRewindByRun.delete(requestedRunId);
          pendingRewindByRun.set(result.runId, pendingRewind);
        }
      }
      // A whole turn can finish while invoke is still pending. Its session
      // event has then moved the state and done has removed the routing entry.
      const knownKey = runRouting.get(result.runId) ?? Object.keys(get().bySession).find(
        (candidate) => get().bySession[candidate]?.settledRunIds?.includes(result.runId),
      );
      const settled = knownKey && get().bySession[knownKey]?.settledRunIds?.includes(result.runId);
      // A turn that settled while invoke was pending still needs the adoption
      // when its session announcement never arrived (an older backend, or a
      // done that carried the id silently): without it the tab stays pending
      // forever and no one clears its streaming flag. If onSession already
      // migrated the state, bySession[key] is gone and this stays a no-op.
      const stillPending = get().bySession[key] !== undefined;
      if (result.sessionId && !tab.sessionId
          && (!settled || (knownKey && get().bySession[knownKey]?.interrupted) || stillPending)) {
        // Preassigned native id (grok): adopt immediately.
        migrateSelectedAgent(tab.workspacePath, result.sessionId);
        migrateRecordedAgent(tab.workspacePath, result.sessionId);
        const newKey = sessionKey(
          engine,
          result.sessionId,
          tab.workspacePath,
        );
        if (model) {
          void ipc
            .rememberSessionModel?.(engine, result.sessionId, model)
            ?.catch(() => {});
        }
        if (effort) {
          void ipc
            .rememberSessionEffort?.(engine, result.sessionId, effort)
            ?.catch(() => {});
        }
        if (provider) {
          void ipc
            .rememberSessionProvider?.(engine, result.sessionId, provider)
            ?.catch(() => {});
        }
        settleOrphanedRuns(set, routeRun(result.runId, newKey));
        set((s) => {
          const bySession = { ...s.bySession };
          if (bySession[key]) {
            bySession[newKey] = bySession[key];
            if (newKey !== key) delete bySession[key];
          }
          // Stamp only the tab that owns this run; blanketing every pending
          // tab of this engine+workspace would create duplicate session tabs.
          let stamped = false;
          const openTabs = dedupeTabs(
            s.openTabs.map((t) => {
              if (
                stamped ||
                t.engine !== engine ||
                t.sessionId !== null ||
                t.workspacePath !== tab.workspacePath
              ) {
                return t;
              }
              stamped = true;
              return { ...t, sessionId: result.sessionId, effort: undefined };
            }),
          );
          // Only the active tab adopts the native id on `active`; a
          // background drain leaves the user's current tab untouched.
          const active =
            s.active &&
            s.active.engine === engine &&
            s.active.sessionId === null &&
            s.active.workspacePath === tab.workspacePath
              ? { ...s.active, sessionId: result.sessionId, effort: undefined }
              : s.active;
          return {
            bySession,
            openTabs,
            active,
            streamingByKey: moveStreamingFlag(s.streamingByKey, key, newKey),
          };
        });
        persistTabs(get().openTabs, get().active);
        // Sidebar row + tab title pick the new session up immediately
        // instead of waiting for the post-turn rescan.
        upsertSessionMetaInto(
          set,
          optimisticMeta(
            engine,
            result.sessionId,
            tab.workspacePath,
            firstLineTitle(prompt),
          ),
        );
      } else if (!runRouting.has(result.runId) && !settled && get().bySession[key]) {
        // The engine can announce its session id while the invoke is in
        // flight; onSession rekeys the run to the native key then, and
        // routing it back to the pre-send key would strand the live turn
        // there while the tab renders the native key. If the pending state
        // is already gone the turn migrated (and possibly settled): routing
        // the id back would resurrect a dead pending key on the next event.
        settleOrphanedRuns(set, routeRun(result.runId, key));
      }
      // Stop can precede native spawn while invoke is still in flight.
      // Retry the interrupt now that the backend has registered the child.
      // A native id adopted
      // just above moved the state to a new key, so read the key the turn
      // actually lives under.
      const liveKey = runRouting.get(result.runId) ?? knownKey ?? (
        result.sessionId && !tab.sessionId
          ? sessionKey(engine, result.sessionId, tab.workspacePath)
          : key);
      if (get().bySession[liveKey]?.interrupted) {
        patchSession(set, liveKey, { settledRunIds: rememberSettledRun(get().bySession[liveKey], result.runId) });
        runRouting.delete(result.runId);
        untrackRun(result.runId);
        dropRunUsage(result.runId);
        await Promise.all([
          ipc.interruptSession(result.runId).catch(() => false),
          ...(result.sessionId
            ? [ipc.interruptSession(result.sessionId).catch(() => false)]
            : []),
        ]);
      }
    } catch (error) {
      const failedKey = runRouting.get(requestedRunId) ?? key;
      runRouting.delete(requestedRunId);
      untrackRun(requestedRunId);
      dropRunUsage(requestedRunId);
      set((s) => ({
        streamingByKey: setStreamingFlag(s.streamingByKey, failedKey, false),
      }));
      patchSession(set, failedKey, {
        error: String(error),
        streaming: false,
        turnStartedAt: null,
      });
      // The send never became a turn, so no engine event will report one:
      // without this the rest of the queue waits for a settle that is not
      // coming. Each drain consumes one item, so a run of failures empties
      // the queue instead of looping.
      void get().refreshSessionUsage(failedKey);
      if (!get().bySession[failedKey]?.interrupted) drainQueue(failedKey);
    }
  }

  /** Flag a finished background session as unseen so the sidebar shows the
   * green dot until the user opens it; the watched active tab never flags. */
  function markUnseenIfBackground(key: string) {
    const active = get().active;
    const activeKey = active
      ? sessionKey(active.engine, active.sessionId, active.workspacePath)
      : null;
    if (key === activeKey) return;
    set((s) => (s.unseen[key] ? {} : { unseen: { ...s.unseen, [key]: true } }));
  }

  /** After a turn ends, send the oldest queued message for that session. */
  function drainQueue(key: string) {
    const s = get();
    const session = s.bySession[key];
    if (!session || session.streaming || session.queue.length === 0) return;
    const tab = s.openTabs.find(
      (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
    );
    if (!tab) return;
    const [head, ...rest] = session.queue;
    set((prev) => ({
      bySession: {
        ...prev.bySession,
        [key]: { ...(prev.bySession[key] ?? EMPTY_SESSION), queue: rest },
      },
    }));
    void sendPrompt(tab, head.text, head.images);
  }

  /** Migrate the engine pref off an entry that is gone (e.g. a removed
   * engine). An empty list means listEngines failed — leave the pref alone
   * rather than guessing. */
  function ensureUsableEngine(engines: EngineInfo[]) {
    if (engines.length === 0 || engines.some((e) => e.id === get().activeEngine))
      return;
    get().setActiveEngine(engines.find((e) => e.available)?.id ?? engines[0].id);
  }

  return {
    workspaces: [],
    sessions: [],
    engines: [],
    active: null,
    openTabs: [],
    activeEngine: localStorage.getItem(ENGINE_PREF_KEY) ?? "claude",
    permission: readPermissionPref(),
    efforts: {},
    models: {},
    channelDefaults: {},
    providers: {},
    threadLimit: 10,
    workspaceGroups: [],
    workspaceAliases: {},
    archivedWorkspaces: [],
    sendShortcut: "enter",
    thinkingAutoCollapse: true,
    detailedDisplay: false,
    bySession: {},
    streamingByKey: {},
    unseen: {},
    drafts: {},
    pendingMention: null,
    actionError: null,
    initialized: false,

    init: async () => {
      if (get().initialized) return;
      set({ initialized: true });
      eventTeardowns.push(
        subscribeTauriEvent(() =>
          listenEngineEvents((events) =>
            handleEngineEvents(events, {
              set,
              get,
              drainQueue,
              markUnseenIfBackground,
              upsertSessionMeta: (meta) => upsertSessionMetaInto(set, meta),
              refreshSessionUsage: (k) => get().refreshSessionUsage(k),
              refreshSessionUuids: (k) => get().refreshSessionUuids(k),
              refreshRewindable: (k) => get().refreshRewindable(k),
            }),
          ),
        ),
        subscribeTauriEvent(() =>
          listenSessionsChanged(() => void get().refreshSessions()),
        ),
      );
      // Settings' channel edits: re-filter picker options without a restart.
      const onCliConfigChanged = () => void get().refreshEngines();
      window.addEventListener(CLI_CONFIG_CHANGED_EVENT, onCliConfigChanged);
      eventTeardowns.push(() =>
        window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, onCliConfigChanged),
      );
      const [workspaces, sessions, engines] = await Promise.all([
        ipc.listWorkspaces().catch(() => [] as Workspace[]),
        ipc.listSessions().catch(() => [] as SessionMeta[]),
        ipc.listEngines().catch(() => [] as EngineInfo[]),
      ]);
      // Plugin session sources (remote/容器内 CLI) merge under the local
      // scan so WSL 等远端会话进侧栏,且重启时已开标签不至于因“会话表无
      // 此会话”被清掉。
      setSessionSourcesChangedCallback(() => void get().refreshSessions());
      const external = await listExternalSessionMetas();
      const allSessions = mergeExternalSessions(
        sessions,
        external,
        workspaces.map((w) => w.path),
      );
      set({
        workspaces,
        sessions: visibleSessions(allSessions, engines),
        engines,
      });
      ensureUsableEngine(engines);
      // Restore persisted tabs; drop ones whose engine, workspace or session
      // is gone. A stale tab from a since-removed CLI engine must not come
      // back and hijack the engine picker.
      const restoredTabs = readPersistedTabs().filter(
        (t) =>
          engines.some((e) => e.id === t.engine) &&
          workspaces.some((w) => w.path === t.workspacePath) &&
          (t.sessionId === null ||
            allSessions.some(
              (s) => s.engine === t.engine && s.sessionId === t.sessionId,
            )),
      );
      set({ openTabs: restoredTabs });
      const persistedActive = readPersistedActive();
      const activeTab =
        persistedActive &&
        restoredTabs.some((t) =>
          sameTab(
            t,
            persistedActive.engine,
            persistedActive.sessionId,
            persistedActive.workspacePath,
          ),
        )
          ? persistedActive
          : (restoredTabs[0] ?? null);
      if (activeTab) activateTab(activeTab);
      // A window created for one specific conversation (?ctx=chat) focuses it
      // after the restore pass; its own tab list starts empty, so this is the
      // window's only active tab.
      if (windowContext.kind === "chat") {
        void get().selectSession(
          windowContext.engine,
          windowContext.sessionId,
          windowContext.workspacePath,
        );
      }
      ipc
        .getAppSettings()
        .then((settings) =>
          set({
            efforts: (settings.defaultEfforts ?? {}) as Record<
              string,
              EffortLevel
            >,
            models: settings.defaultModels ?? {},
            threadLimit: settings.sidebarThreadLimit ?? 5,
            workspaceGroups: settings.workspaceGroups ?? [],
            workspaceAliases: settings.workspaceAliases ?? {},
            archivedWorkspaces: settings.archivedWorkspaces ?? [],
            sendShortcut: settings.composerSendShortcut ?? "enter",
            thinkingAutoCollapse: settings.thinkingAutoCollapse ?? true,
            detailedDisplay: settings.detailedDisplay ?? false,
          }),
        )
        .catch(() => {});
      ipc
        .getCliConfig?.()
        ?.then((config) =>
          set({
            providers: engineCurrents(config),
            channelDefaults: computeChannelDefaults(config),
          }),
        )
        .catch(() => {});
    },

    refreshSessions: async () => {
      const [sessions, external] = await Promise.all([
        ipc.listSessions().catch(() => null),
        listExternalSessionMetas(),
      ]);
      if (!sessions) return;
      const merged = mergeExternalSessions(
        sessions,
        external,
        get().workspaces.map((w) => w.path),
      );
      set((s) => {
        const visible = visibleSessions(
          preserveUnscannedSessions(merged, s.sessions, s.bySession),
          s.engines,
        );
        const bySession = { ...s.bySession };
        for (const meta of merged) {
          const key = sessionKey(meta.engine, meta.sessionId, meta.workspacePath);
          const current = bySession[key];
          if (!current) continue;
          bySession[key] = {
            ...current,
            activeModel: meta.model ?? current.activeModel,
            activeEffort: meta.effort ?? current.activeEffort,
            activeProvider: meta.provider ?? current.activeProvider,
          };
        }
        return { sessions: visible, bySession };
      });
    },

    refreshEngines: async () => {
      const [engines, sessions, external, config] = await Promise.all([
        ipc.listEngines().catch(() => null),
        ipc.listSessions().catch(() => null),
        listExternalSessionMetas(),
        ipc.getCliConfig?.().catch(() => null) ?? Promise.resolve(null),
      ]);
      if (!engines) return;
      set((s) => ({
        engines,
        ...(sessions
          ? {
              sessions: visibleSessions(
                preserveUnscannedSessions(
                  mergeExternalSessions(
                    sessions,
                    external,
                    s.workspaces.map((w) => w.path),
                  ),
                  s.sessions,
                  s.bySession,
                ),
                engines,
              ),
            }
          : {}),
        ...(config
          ? {
              providers: engineCurrents(config),
              channelDefaults: computeChannelDefaults(config),
            }
          : {}),
      }));
      ensureUsableEngine(engines);
    },

    refreshWorkspaces: async () => {
      const workspaces = await ipc.listWorkspaces().catch(() => null);
      if (workspaces) set({ workspaces });
    },

    addWorkspace: async (path, meta) => {
      try {
        await ipc.addWorkspace(path, meta);
        await get().refreshWorkspaces();
        set({ actionError: null });
      } catch (error) {
        set({ actionError: errorText(error) });
      }
    },

    reorderWorkspaces: async (ids) => {
      // Optimistic: listed ids first in the given order, the rest keep their
      // relative order after them.
      const order = new Map(ids.map((id, index) => [id, index]));
      set((s) => ({
        workspaces: [...s.workspaces].sort(
          (a, b) =>
            (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        ),
      }));
      try {
        await ipc.reorderWorkspaces(ids);
      } catch {
        await get().refreshWorkspaces();
      }
    },

    removeWorkspace: async (id) => {
      try {
        const removedPath = get().workspaces.find((w) => w.id === id)?.path;
        await ipc.removeWorkspace(id);
        await get().refreshWorkspaces();
        set({ actionError: null });
        if (!removedPath) return;
        // The composer's per-root picker caches die with the workspace.
        pruneMentionIndex(removedPath);
        pruneSlashCommands(removedPath);
        // Evict cached session state belonging to the removed workspace:
        // real session keys come from the list cache, pending-chat keys
        // carry the path in the key itself.
        const dead = new Set<string>();
        for (const sess of get().sessions) {
          if (sess.workspacePath === removedPath) {
            dead.add(sessionKey(sess.engine, sess.sessionId, ""));
          }
        }
        const current = get();
        for (const key of [
          ...Object.keys(current.bySession),
          ...Object.keys(current.drafts),
          ...Object.keys(current.unseen),
        ]) {
          if (key.startsWith("new:") && key.endsWith(`:${removedPath}`)) {
            dead.add(key);
          }
        }
        if (dead.size > 0) {
          for (let i = closedTabCache.length - 1; i >= 0; i--) {
            if (dead.has(closedTabCache[i])) closedTabCache.splice(i, 1);
          }
          set((s) => {
            const bySession = { ...s.bySession };
            const drafts = { ...s.drafts };
            const unseen = { ...s.unseen };
            for (const key of dead) {
              delete bySession[key];
              delete drafts[key];
              delete unseen[key];
            }
            return { bySession, drafts, unseen };
          });
        }
        const openTabs = get().openTabs.filter(
          (t) => t.workspacePath !== removedPath,
        );
        set({ openTabs });
        const active = get().active;
        if (active && active.workspacePath === removedPath) {
          activateTab(openTabs[0] ?? null);
        } else {
          persistTabs(openTabs, active);
        }
      } catch (error) {
        set({ actionError: errorText(error) });
      }
    },

    selectSession: async (engine, sessionId, workspacePath) => {
      const key = sessionKey(engine, sessionId, workspacePath);
      // The session remembers the model it ran, and our own record is the
      // only place that carries the provider ("agentrouter qunyou/x", while
      // the engine transcript keeps the bare "x"). Without it a session
      // reopened here — after a restart, or in another window — showed the
      // engine default and sent that instead.
      const remembered = get().sessions.find(
        (x) => x.engine === engine && x.sessionId === sessionId,
      )?.model;
      if (remembered && !get().bySession[key]?.activeModel) {
        patchSession(set, key, { activeModel: remembered });
      }
      // Same for the reasoning level: the picker and the next send follow the
      // session, so an unset level adopts the one this session last ran.
      const rememberedEffort = get().sessions.find(
        (x) => x.engine === engine && x.sessionId === sessionId,
      )?.effort;
      if (rememberedEffort && !get().bySession[key]?.activeEffort) {
        patchSession(set, key, { activeEffort: rememberedEffort });
      }
      const rememberedProvider = get().sessions.find(
        (x) => x.engine === engine && x.sessionId === sessionId,
      )?.provider;
      if (rememberedProvider && !get().bySession[key]?.activeProvider) {
        patchSession(set, key, { activeProvider: rememberedProvider });
      }
      // A pending rewind survives restarts and other windows (the transcript
      // is untouched until the send carrying it runs): hydrate the in-memory
      // copy from the shared map.
      const pendingRewind = readRewindAnchors()[key];
      if (pendingRewind && !get().bySession[key]?.rewindAnchor) {
        patchSession(set, key, { rewindAnchor: pendingRewind });
      }
      const syncEngine = engine !== get().activeEngine;
      if (syncEngine) writeStored(ENGINE_PREF_KEY, engine);
      set((s) => {
        // Native sessions read effort from SessionState/database. Strip the
        // legacy per-tab field so an old localStorage value cannot shadow it.
        const stored = s.openTabs.find((t) =>
          sameTab(t, engine, sessionId, workspacePath),
        );
        const tab: ActiveSession = stored
          ? { ...stored, effort: undefined, provider: undefined }
          : { engine, sessionId, workspacePath };
        const openTabs = stored
          ? s.openTabs.map((t) => (t === stored ? tab : t))
          : [...s.openTabs, tab];
        persistTabs(openTabs, tab);
        const unseen = key in s.unseen ? omitKey(s.unseen, key) : s.unseen;
        return { openTabs, active: tab, unseen, activeEngine: engine };
      });
      emitSessionActivated(engine, sessionId);
      const existing = get().bySession[key];
      if (existing && existing.messages.length > 0) return;
      patchSession(set, key, { loading: true });
      try {
        const page = await loadHistoryPage(engine, sessionId, workspacePath, 100);
        patchSession(set, key, {
          messages: page.messages,
          subagentHistory: page.subagentHistory,
          nextBefore: page.nextBefore,
          loading: false,
          // Live "usage" events only cover fresh turns; a resumed session
          // adopts the newest usage snapshot carried by its history.
          usage:
            [...page.messages].reverse().find((m) => m.usage)?.usage ?? null,
        });
        // A pending rewind may point at a message in an earlier page than
        // the last one sessions open with: load older pages (bounded) until
        // the anchor is located, so the timeline truncates instead of
        // falling back to the full tail. Not finding it within the bound
        // leaves the send-side rewind intact (the CLI truncates regardless).
        const anchor = readRewindAnchors()[key];
        if (anchor) {
          let attempts = 0;
          while (attempts < 5) {
            const current = get().bySession[key];
            if (!current) break;
            if (current.messages.some((m) => m.uuid === anchor)) break;
            if (current.nextBefore === null) break;
            attempts++;
            const older = await loadHistoryPage(
              engine,
              sessionId,
              workspacePath,
              100,
              current.nextBefore,
            );
            // Merge against the LATEST state: messages appended while the
            // page was in flight (a send, streaming rows) must survive.
            const latest = get().bySession[key];
            if (!latest) break;
            patchSession(set, key, {
              messages: [...older.messages, ...latest.messages],
              nextBefore: older.nextBefore,
            });
          }
        }
      } catch (error) {
        patchSession(set, key, { loading: false, error: String(error) });
      }
    },

    startNewChat: (workspacePath) => {
      // One pending chat per workspace+engine: re-focus it instead of
      // piling up empty "new" tabs.
      set((s) => {
        const existing = s.openTabs.find(
          (t) =>
            t.sessionId === null &&
            t.engine === s.activeEngine &&
            t.workspacePath === workspacePath,
        );
        const tab: ActiveSession = existing ?? {
          engine: s.activeEngine,
          sessionId: null,
          workspacePath,
        };
        const openTabs = existing ? s.openTabs : [...s.openTabs, tab];
        persistTabs(openTabs, tab);
        return { openTabs, active: tab };
      });
    },

    closeTab: (engine, sessionId, workspacePath) => {
      removeTab(engine, sessionId, workspacePath);
    },
    focusTab: (engine, sessionId, workspacePath) => {
      // Reuse the stored tab so its per-tab model/effort overrides apply.
      const stored = get().openTabs.find((t) =>
        sameTab(t, engine, sessionId, workspacePath),
      );
      activateTab(stored ?? { engine, sessionId, workspacePath });
    },
    moveTab: (engine, sessionId, workspacePath, toIndex) => {
      const s = get();
      const from = s.openTabs.findIndex((t) =>
        sameTab(t, engine, sessionId, workspacePath),
      );
      if (from < 0) return;
      const openTabs = [...s.openTabs];
      const [tab] = openTabs.splice(from, 1);
      openTabs.splice(Math.max(0, Math.min(toIndex, openTabs.length)), 0, tab);
      set({ openTabs });
      persistTabs(openTabs, s.active);
    },

    setActiveEngine: (engine) => {
      writeStored(ENGINE_PREF_KEY, engine);
      set((s) => {
        const active = s.active;
        // A pending (never-sent) tab has no backend session yet, so it
        // follows the picker: retarget it to the newly selected engine.
        // Otherwise the chip shows the new CLI while sends still go to the
        // engine the tab was created with.
        if (!active || active.sessionId !== null || active.engine === engine) {
          return { activeEngine: engine };
        }
        const oldKey = sessionKey(active.engine, null, active.workspacePath);
        // First turn still in flight (native id not yet assigned): event
        // routing is keyed to the old engine, so leave the tab untouched.
        if (s.bySession[oldKey]?.streaming) return { activeEngine: engine };
        const newKey = sessionKey(engine, null, active.workspacePath);
        const existing = s.openTabs.find(
          (t) =>
            !sameTab(
              t,
              active.engine,
              active.sessionId,
              active.workspacePath,
            ) &&
            t.sessionId === null &&
            t.engine === engine &&
            t.workspacePath === active.workspacePath,
        );
        // Carry unsent drafts / session state over to the new key.
        const bySession = { ...s.bySession };
        const drafts = { ...s.drafts };
        if (bySession[oldKey] && !bySession[newKey])
          bySession[newKey] = bySession[oldKey];
        delete bySession[oldKey];
        if (drafts[oldKey] !== undefined && drafts[newKey] === undefined) {
          drafts[newKey] = drafts[oldKey];
        }
        delete drafts[oldKey];
        let openTabs: ActiveSession[];
        let nextActive: ActiveSession;
        if (existing) {
          // A pending tab for this engine+workspace already exists: fold
          // into it instead of stacking a duplicate.
          openTabs = s.openTabs.filter(
            (t) =>
              !sameTab(
                t,
                active.engine,
                active.sessionId,
                active.workspacePath,
              ),
          );
          nextActive = existing;
        } else {
          // Engine retarget: the old engine's model/effort overrides don't
          // apply to the new one — drop them so defaults resolve fresh.
          nextActive = {
            ...active,
            engine,
            model: undefined,
            effort: undefined,
            provider: undefined,
          };
          openTabs = s.openTabs.map((t) =>
            sameTab(t, active.engine, active.sessionId, active.workspacePath)
              ? nextActive
              : t,
          );
        }
        persistTabs(openTabs, nextActive);
        return {
          activeEngine: engine,
          openTabs,
          active: nextActive,
          bySession,
          drafts,
          streamingByKey: moveStreamingFlag(s.streamingByKey, oldKey, newKey),
        };
      });
    },

    setPermission: (permission) => {
      writeStored(PERMISSION_PREF_KEY, permission);
      set({ permission });
    },
    setEffort: async (engine, effort) => {
      const active = get().active;
      if (active?.engine === engine && active.sessionId) {
        const key = sessionKey(engine, active.sessionId, active.workspacePath);
        patchSession(set, key, { activeEffort: effort });
        void ipc.rememberSessionEffort(engine, active.sessionId, effort).catch(() => {});
        return;
      }
      set({ efforts: { ...get().efforts, [engine]: effort } });
      if (active?.engine === engine) stampActiveTab({ effort });
      await persistSettings((settings) => ({
        defaultEfforts: { ...settings.defaultEfforts, [engine]: effort },
      }));
    },
    setModel: async (engine, model) => {
      const active = get().active;
      // Model choice is a property of the CONVERSATION: picking one inside a
      // session must not rewrite the engine-wide default, or a second session
      // of the same CLI would silently switch models with it. Only a pending
      // "new chat" tab (no session yet) edits the default — that tab is where
      // the next conversation's starting choice is made.
      if (!active || active.sessionId === null) {
        const models = { ...get().models };
        if (model) models[engine] = model;
        else delete models[engine];
        set({ models });
        await persistSettings((settings) => {
          const defaultModels = { ...settings.defaultModels };
          if (model) defaultModels[engine] = model;
          else delete defaultModels[engine];
          return { defaultModels };
        });
      }
      if (active?.engine === engine) {
        // Empty = "CLI default": clear the tab override so the session falls
        // back to its own history/model default again.
        stampActiveTab({ model: model || undefined });
      }
    },
    /** Drop a dead per-tab model override (the tab names a model its channel
     *  no longer serves), so the resolution falls through to the channel
     *  default instead of the engine-name placeholder. */
    repairSessionModel: (engine, sessionId, workspacePath, staleStamp) => {
      set((s) => {
        // staleStamp arrives normalized (the hook normalizes before the
        // servability check); a stored legacy alias ("sonnet") matches its
        // tier ("mid") here so the stale pick still clears.
        const clear = (t: ActiveSession): ActiveSession =>
          t.model && normalizeTierAlias(t.model) === staleStamp
            ? { ...t, model: undefined }
            : t;
        let changed = false;
        const openTabs = s.openTabs.map((t) => {
          if (!sameTab(t, engine, sessionId, workspacePath)) return t;
          const next = clear(t);
          if (next !== t) changed = true;
          return next;
        });
        let active = s.active;
        if (active && sameTab(active, engine, sessionId, workspacePath)) {
          const next = clear(active);
          if (next !== active) {
            active = next;
            changed = true;
          }
        }
        if (!changed) return {};
        persistTabs(openTabs, active);
        return { openTabs, active };
      });
    },
    setProvider: async (engine, providerId) => {
      const active = get().active;
      try {
        if (active?.engine === engine && active.sessionId) {
          await ipc.rememberSessionProvider(engine, active.sessionId, providerId);
          const key = sessionKey(engine, active.sessionId, active.workspacePath);
          patchSession(set, key, { activeProvider: providerId });
          if (get().active === active) stampActiveTab({ provider: undefined });
        } else {
          await ipc.setCurrentProvider(engine, providerId);
          set({ providers: { ...get().providers, [engine]: providerId } });
          if (get().active === active && active?.engine === engine) {
            stampActiveTab({ provider: providerId || undefined });
          }
          notifyCliConfigChanged();
        }
        set({ actionError: null });
      } catch (error) {
        // Migration conflicts and failed writes must not leave a checkmark
        // on a channel the backend never accepted.
        set({ actionError: errorText(error) });
      }
    },
    pinModels: async (updates, persist = true) => {
      const entries = Object.entries(updates).filter(([, model]) =>
        model.trim(),
      );
      if (entries.length === 0) return;
      const models = { ...get().models };
      for (const [engine, model] of entries) models[engine] = model;
      set({ models });
      if (!persist) return;
      await persistSettings((settings) => ({
        defaultModels: {
          ...settings.defaultModels,
          ...Object.fromEntries(entries),
        },
      }));
    },

    setThreadLimit: (limit) => {
      set({ threadLimit: Math.max(1, Math.floor(limit)) });
    },
    createWorkspaceGroup: async (name) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Group name is required.");
      const current = get().workspaceGroups;
      if (current.some((g) => g.name === trimmed)) {
        throw new Error("Group name already exists.");
      }
      const group: WorkspaceGroup = {
        id: newId(),
        name: trimmed,
        sortOrder:
          current.reduce((max, g) => Math.max(max, g.sortOrder ?? -1), -1) + 1,
      };
      const workspaceGroups = [...current, group];
      set({ workspaceGroups });
      await persistSettings((settings) => ({
        workspaceGroups: [...(settings.workspaceGroups ?? []), group],
      }));
      return group;
    },
    renameWorkspaceGroup: async (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Group name is required.");
      const current = get().workspaceGroups;
      if (current.some((g) => g.id !== id && g.name === trimmed)) {
        throw new Error("Group name already exists.");
      }
      set({
        workspaceGroups: current.map((g) =>
          g.id === id ? { ...g, name: trimmed } : g,
        ),
      });
      await persistSettings((settings) => ({
        workspaceGroups: (settings.workspaceGroups ?? []).map((g) =>
          g.id === id ? { ...g, name: trimmed } : g,
        ),
      }));
      return true;
    },
    reorderWorkspaceGroups: async (orderedIds) => {
      const current = get().workspaceGroups;
      const byId = new Map(current.map((g) => [g.id, g]));
      const ordered = orderedIds
        .map((id) => byId.get(id))
        .filter((g): g is WorkspaceGroup => Boolean(g));
      // Groups missing from the submitted order keep trailing positions.
      const orderedIdSet = new Set(orderedIds);
      const rest = current.filter((g) => !orderedIdSet.has(g.id));
      const workspaceGroups = [...ordered, ...rest].map((g, i) => ({
        ...g,
        sortOrder: i,
      }));
      set({ workspaceGroups });
      await persistSettings(() => ({ workspaceGroups }));
    },
    deleteWorkspaceGroup: async (id) => {
      const affected = get().workspaces.filter((w) => w.groupId === id);
      const workspaceGroups = get().workspaceGroups.filter((g) => g.id !== id);
      set({
        workspaceGroups,
        workspaces: get().workspaces.map((w) =>
          w.groupId === id ? { ...w, groupId: null } : w,
        ),
      });
      await persistSettings((settings) => ({
        workspaceGroups: (settings.workspaceGroups ?? []).filter(
          (g) => g.id !== id,
        ),
      }));
      // Members of the deleted group fall back to ungrouped.
      await Promise.all(
        affected.map((w) => ipc.setWorkspaceGroup(w.id, null).catch(() => {})),
      );
    },
    assignWorkspaceGroup: async (workspaceId, groupId) => {
      const valid =
        groupId && get().workspaceGroups.some((g) => g.id === groupId);
      const resolved = valid ? groupId : null;
      set({
        workspaces: get().workspaces.map((w) =>
          w.id === workspaceId ? { ...w, groupId: resolved } : w,
        ),
      });
      try {
        await ipc.setWorkspaceGroup(workspaceId, resolved);
      } catch (error) {
        // Roll back to the persisted truth.
        await get().refreshWorkspaces();
        throw error;
      }
    },
    setWorkspaceAlias: async (workspaceId, alias) => {
      // An alias equal to the folder name is no alias at all — same rule the
      // sidebar display applies — so it clears the entry instead of storing.
      const name = get().workspaces.find((w) => w.id === workspaceId)?.name;
      const trimmed = alias?.trim() ?? "";
      const resolved = trimmed && trimmed !== name ? trimmed : null;
      const workspaceAliases = { ...get().workspaceAliases };
      if (resolved) workspaceAliases[workspaceId] = resolved;
      else delete workspaceAliases[workspaceId];
      set({ workspaceAliases });
      await persistSettings((settings) => {
        const next = { ...(settings.workspaceAliases ?? {}) };
        if (resolved) next[workspaceId] = resolved;
        else delete next[workspaceId];
        return { workspaceAliases: next };
      });
    },
    setWorkspaceArchived: async (workspaceId, archived) => {
      const current = get().archivedWorkspaces;
      const archivedWorkspaces = archived
        ? current.includes(workspaceId)
          ? current
          : [...current, workspaceId]
        : current.filter((id) => id !== workspaceId);
      if (archivedWorkspaces === current) return;
      set({ archivedWorkspaces });
      await persistSettings((settings) => {
        const next = (settings.archivedWorkspaces ?? []).filter(
          (id) => id !== workspaceId,
        );
        if (archived) next.push(workspaceId);
        return { archivedWorkspaces: next };
      });
    },
    setSendShortcut: (shortcut) => {
      set({ sendShortcut: shortcut });
    },
    setThinkingAutoCollapse: (autoCollapse) => {
      set({ thinkingAutoCollapse: autoCollapse });
    },
    setDetailedDisplay: (detailed) => {
      set({ detailedDisplay: detailed });
    },

    setDraft: (key, text) => {
      set((s) => ({ drafts: { ...s.drafts, [key]: text } }));
    },
    requestMention: (path) => {
      set((s) => ({
        pendingMention: { path, nonce: (s.pendingMention?.nonce ?? 0) + 1 },
      }));
    },

    clearPendingMention: () => {
      set({ pendingMention: null });
    },

    dismissActionError: () => {
      set({ actionError: null });
    },
    dismissSessionError: (key) => {
      patchSession(set, key, { error: null });
    },

    loadEarlier: async () => {
      const { active, bySession } = get();
      if (!active?.sessionId) return;
      const key = sessionKey(
        active.engine,
        active.sessionId,
        active.workspacePath,
      );
      const state = bySession[key];
      if (!state?.nextBefore || state.loading) return;
      patchSession(set, key, { loading: true });
      try {
        const page = await loadHistoryPage(
          active.engine,
          active.sessionId,
          active.workspacePath,
          100,
          state.nextBefore,
        );
        patchSession(set, key, {
          messages: [
            ...page.messages,
            ...(get().bySession[key] ?? EMPTY_SESSION).messages,
          ],
          nextBefore: page.nextBefore,
          subagentHistory: page.subagentHistory,
          loading: false,
        });
      } catch {
        patchSession(set, key, { loading: false });
      }
    },

    send: async (prompt, images) => {
      const { active } = get();
      if (active) await sendPrompt(active, prompt, images);
    },

    respondToGrant: async (key, seq, accept) => {
      const message = get().bySession[key]?.messages.find((m) => m.seq === seq);
      if (!message || message.role !== "grant" || message.grant?.status !== "pending") {
        return;
      }
      if (!accept) {
        patchGrantBySeq(set, key, seq, () => ({ status: "declined" }));
        return;
      }
      const path = message.path;
      if (!path) return;
      try {
        await ipc.grantRoot(path);
        patchGrantBySeq(set, key, seq, (grant) => ({
          ...grant,
          status: "granted",
        }));
      } catch (error) {
        patchSession(set, key, { error: errorText(error) });
      }
    },

    respondToQuestion: async (key, seq, answers) => {
      const message = get().bySession[key]?.messages.find((m) => m.seq === seq);
      const question = message?.question;
      if (
        !message ||
        message.role !== "question" ||
        !question ||
        question.status !== "pending"
      ) {
        return;
      }
      try {
        await ipc.answerQuestion(question.runId, question.requestId, answers);
        patchQuestionByRequestId(set, key, question.requestId, (cur) => ({
          ...cur,
          status: answers ? ("answered" as const) : ("dismissed" as const),
          ...(answers ? { answers } : {}),
        }));
      } catch (error) {
        // The answer never reached the process (the run is gone): surface it;
        // a later question_settled event resolves the still-pending card.
        patchSession(set, key, { error: errorText(error) });
      }
    },

    respondToPermission: async (key, seq, behavior) => {
      const message = get().bySession[key]?.messages.find((m) => m.seq === seq);
      const permission = message?.permission;
      if (
        !message ||
        message.role !== "permission" ||
        !permission ||
        permission.status !== "pending"
      ) {
        return;
      }
      try {
        await ipc.answerPermission(permission.runId, permission.requestId, behavior);
        patchPermissionByRequestId(set, key, permission.requestId, (cur) => ({
          ...cur,
          status: behavior === "allow" ? ("allowed" as const) : ("denied" as const),
        }));
      } catch (error) {
        // The answer never reached the process (the run is gone): surface it;
        // a later question_settled event resolves the still-pending card.
        patchSession(set, key, { error: errorText(error) });
      }
    },

    resendLastUser: async (key) => {
      const s = get();
      if (s.streamingByKey[key]) return; // a turn is already running
      const state = s.bySession[key];
      const messages = state?.messages ?? [];
      // A pending rewind narrows "the last prompt" to the surviving range:
      // retry must not resurrect a withdrawn prompt.
      const anchor = state?.rewindAnchor ?? null;
      const anchorIndex = anchor
        ? lastRowIndexByUuid(messages, anchor)
        : -1;
      const scope =
        anchorIndex >= 0 ? messages.slice(0, anchorIndex + 1) : messages;
      const lastUser = [...scope].reverse().find((m) => m.role === "user");
      if (!lastUser) return;
      const tab =
        s.openTabs.find(
          (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
        ) ?? s.active;
      if (tab) await sendPrompt(tab, lastUser.text, lastUser.images ?? []);
    },

    /** 「重试」（消息操作栏）：撤回最后一轮后重问——待回退点设在「该提问
     *  之前的最后一个可定位节点」上（截断到它为止、不含提问本身），重发的
     *  提问成为该轮唯一的一份，旧提问与旧回复都不在截断后的链上。首条提问
     *  没有可截断的前置节点（`--resume-session-at` 无法表达「截断到空」），
     *  改在新会话里重问。与 resendLastUser（GrantCard 批准后重发）区分：
     *  那个是「再发一次」，不改动已有轮次。 */
    retryLastTurn: async (key) => {
      const s = get();
      if (s.streamingByKey[key]) return; // a turn is already running
      const state = s.bySession[key];
      const messages = state?.messages ?? [];
      const anchor = state?.rewindAnchor ?? null;
      const anchorIndex = anchor
        ? lastRowIndexByUuid(messages, anchor)
        : -1;
      const scope =
        anchorIndex >= 0 ? messages.slice(0, anchorIndex + 1) : messages;
      const lastUser = [...scope].reverse().find((m) => m.role === "user");
      if (!lastUser) return;
      const tab =
        s.openTabs.find(
          (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
        ) ?? s.active;
      if (!tab) return;
      // Locate the prompt by array position, not by its uuid: a round that
      // just settled may still carry a local echo row without a uuid yet
      // (the backfill lands up to 400ms later, or never when the CLI failed
      // before writing it) — the anchor only needs the node BEFORE it.
      const userIndex = scope.lastIndexOf(lastUser);
      if (userIndex === 0 && tab.sessionId) {
        // The prompt is the session's first message: `--resume-session-at`
        // cannot express "truncate to nothing" (it needs a resolvable
        // uuid), so re-ask it in a fresh session — nothing precedes it, so
        // the new session is equivalent, and the old prompt/reply cannot
        // pile up as a duplicate in the same transcript.
        get().startNewChat(tab.workspacePath);
        const fresh = get().active;
        if (fresh) {
          await sendPrompt(fresh, lastUser.text, lastUser.images ?? []);
        }
        return;
      }
      let prevUuid: string | null = null;
      for (let i = userIndex - 1; i >= 0; i--) {
        const uuid = scope[i].uuid;
        if (uuid) {
          prevUuid = uuid;
          break;
        }
      }
      if (prevUuid && tab.sessionId) {
        get().setRewindAnchor(key, prevUuid);
      }
      await sendPrompt(tab, lastUser.text, lastUser.images ?? []);
    },

    /** Per-session proxy switch (the composer's 会话开关, the CLI's /proxy):
     *  true = 开启, false = 关闭, null = 跟随默认。每次发送随进程注入。 */
    setSessionProxy: (key, value) => {
      patchSession(set, key, { proxyEnabled: value });
    },

    /** Per-session second-brain switch (the CLI's /second-brain on|off). */
    setSessionSecondBrain: (key, value) => {
      patchSession(set, key, { secondBrainEnabled: value });
    },

    /** Per-session context-window override (the CLI's /maxtokens): a positive
     *  token count pinned on every send; null 跟随默认。 */
    setSessionAutoCompactWindow: (key, value) => {
      patchSession(set, key, { autoCompactWindow: value });
    },
    /** Set (or clear) a session's pending rewind point: the next send passes
     *  it as the CLI's `--resume-session-at` (truncate to that message,
     *  inclusive). Persisted — the transcript stays untouched until that
     *  send, so a restart keeps the pending point. */
    setRewindAnchor: (key, uuid) => {
      patchSession(set, key, { rewindAnchor: uuid });
      const anchors = readRewindAnchors();
      if (uuid) anchors[key] = uuid;
      else delete anchors[key];
      writeStored(REWIND_ANCHORS_KEY, JSON.stringify(anchors));
    },
    consumeRewindAnchor: (key, anchor) => {
      // The effective point may live only in the persisted map (another
      // window set it; this window never hydrated it).
      const current =
        get().bySession[key]?.rewindAnchor ?? readRewindAnchors()[key] ?? null;
      if (current !== anchor) return;
      patchSession(set, key, { rewindAnchor: null });
      const anchors = readRewindAnchors();
      delete anchors[key];
      writeStored(REWIND_ANCHORS_KEY, JSON.stringify(anchors));
    },
    rewindWorkspaceFiles: async (key, messageId) => {
      const s = get();
      const tab =
        s.openTabs.find(
          (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
        ) ?? s.active;
      if (!tab?.sessionId) return;
      try {
        await ipc.rewindFiles(
          tab.engine,
          tab.sessionId,
          tab.workspacePath,
          messageId,
        );
        set({ actionError: null });
      } catch (error) {
        set({ actionError: errorText(error) });
      }
    },

    applyEditedMessage: (key, uuid, text) => {
      set((s) => {
        const session = s.bySession[key];
        if (!session) return {};
        let changed = false;
        const messages = session.messages.map((m) => {
          if (m.uuid !== uuid || m.role !== "user" || m.text === text) return m;
          changed = true;
          return { ...m, text };
        });
        if (!changed) return {};
        return {
          bySession: { ...s.bySession, [key]: { ...session, messages } },
        };
      });
    },

    /** Fork the conversation at one message (the CLI's /branch): the host
     *  writes the new session file next to the source, then the branch opens
     *  like any other session. */
    branchFromMessage: async (key, targetUuid) => {
      const s = get();
      const tab =
        s.openTabs.find(
          (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
        ) ?? s.active;
      if (!tab?.sessionId) return;
      try {
        const result = await ipc.branchSession(
          tab.engine,
          tab.sessionId,
          tab.workspacePath,
          targetUuid,
        );
        await get().refreshSessions();
        await get().selectSession(tab.engine, result.sessionId, tab.workspacePath);
      } catch (error) {
        set({ actionError: errorText(error) });
      }
    },

    queueMessage: (text, images) => {
      const { active } = get();
      if (!active || (!text.trim() && images.length === 0)) return;
      const key = sessionKey(
        active.engine,
        active.sessionId,
        active.workspacePath,
      );
      set((s) => {
        const prev = s.bySession[key] ?? EMPTY_SESSION;
        return {
          bySession: {
            ...s.bySession,
            [key]: {
              ...prev,
              queue: [
                ...prev.queue,
                { id: newId(), text, images, queuedAt: Date.now() },
              ],
            },
          },
        };
      });
    },

    removeQueued: (id) => {
      const { active } = get();
      if (!active) return;
      const key = sessionKey(
        active.engine,
        active.sessionId,
        active.workspacePath,
      );
      set((s) => {
        const prev = s.bySession[key];
        if (!prev) return {};
        return {
          bySession: {
            ...s.bySession,
            [key]: {
              ...prev,
              queue: prev.queue.filter((item) => item.id !== id),
            },
          },
        };
      });
    },
    clearQueue: () => {
      const { active } = get();
      if (!active) return;
      const key = sessionKey(
        active.engine,
        active.sessionId,
        active.workspacePath,
      );
      set((s) => {
        const prev = s.bySession[key];
        if (!prev || prev.queue.length === 0) return {};
        return {
          bySession: {
            ...s.bySession,
            [key]: { ...prev, queue: [] },
          },
        };
      });
    },

    /** Jump the queue with one message. An engine takes one prompt at a time,
     *  so "now" means stopping the turn in flight; the row moves to the head
     *  and the stop's own park is lifted, so the exit drain sends this message
     *  instead of waiting the turn out. The rows behind it follow on the next
     *  settle. */
    sendQueuedNow: async (id) => {
      const { active } = get();
      if (!active) return;
      const key = sessionKey(
        active.engine,
        active.sessionId,
        active.workspacePath,
      );
      const session = get().bySession[key];
      const item = session?.queue.find((entry) => entry.id === id);
      if (!item || !session) return;
      const running = session.streaming;
      set((s) => {
        const prev = s.bySession[key] ?? EMPTY_SESSION;
        return {
          bySession: {
            ...s.bySession,
            [key]: {
              ...prev,
              queue: [item, ...prev.queue.filter((entry) => entry.id !== id)],
              interrupted: false,
            },
          },
        };
      });
      if (running) await get().interrupt();
      drainQueue(key);
    },

    interrupt: async () => {
      const { active } = get();
      if (!active) return;
      const key = sessionKey(
        active.engine,
        active.sessionId,
        active.workspacePath,
      );
      // Settle locally FIRST: the killed run's done event can arrive while
      // the kill IPCs below are still in flight, and onDone drains the queue
      // whenever interrupted is still false — that would fire the next
      // queued message right after the user pressed stop.
      const pending = drainPending(key);
      set((s) => {
        const cur = s.bySession[key] ?? EMPTY_SESSION;
        const messages = settleLiveRows(
          pending
            ? applyStreamParts(cur.messages, pending.parts, pending.model)
            : cur.messages,
        );
        return {
          bySession: {
            ...s.bySession,
            [key]: {
              ...cur,
              messages,
              streaming: false,
              interrupted: true,
              turnStartedAt: null,
            },
          },
          streamingByKey: setStreamingFlag(s.streamingByKey, key, false),
        };
      });
      // Registry is keyed by native session id once known; before that the
      // run id routes. Try both.
      if (active.sessionId)
        await ipc.interruptSession(active.sessionId).catch(() => false);
      const deadRunIds: string[] = [];
      for (const [runId, routed] of runRouting) {
        if (routed === key) deadRunIds.push(runId);
      }
      // Independent kills, one IPC call per routed run — fired together.
      await Promise.all(
        deadRunIds.map((runId) =>
          ipc.interruptSession(runId).catch(() => false),
        ),
      );
      // The runs are dead: drop their routing and usage entries so the maps
      // cannot grow forever. (A late done event would also remove them.)
      for (const runId of deadRunIds) {
        patchSession(set, key, { settledRunIds: rememberSettledRun(get().bySession[key], runId) });
        runRouting.delete(runId);
        untrackRun(runId);
        dropRunUsage(runId);
      }
      // Refresh without holding Stop: the read can take three loads with
      // backoff, and Stop must complete immediately (every other caller
      // fires and forgets).
      void get().refreshSessionUsage(key);
    },

    deleteSession: async (engine, sessionId) => {
      // 远程(插件会话源,如 WSL 发行版内 CLI)会话没有本地 db 行,本地
      // delete_session 只会 "session not found";走远程通道删 remotePath。
      const meta = get().sessions.find(
        (x) => x.engine === engine && x.sessionId === sessionId,
      );
      try {
        if (meta?.remote && meta.remotePath) {
          await ipc.deleteRemoteSession(meta.workspacePath, engine, meta.remotePath);
        } else {
          await ipc.deleteSession(engine, sessionId);
        }
      } catch (error) {
        set({ actionError: errorText(error) });
        return;
      }
      set({ actionError: null });
      const key = sessionKey(engine, sessionId, "");
      const tab = get().openTabs.find(
        (t) => t.engine === engine && t.sessionId === sessionId,
      );
      set((s) => {
        // Permanent delete: the cached session state is dead weight.
        const bySession = { ...s.bySession };
        const drafts = { ...s.drafts };
        delete bySession[key];
        delete drafts[key];
        return {
          sessions: s.sessions.filter(
            (x) => !(x.engine === engine && x.sessionId === sessionId),
          ),
          bySession,
          drafts,
          unseen: omitKey(s.unseen, key),
        };
      });
      // The closed-tab reopen cache must not keep the dead key either.
      const cacheIdx = closedTabCache.indexOf(key);
      if (cacheIdx >= 0) closedTabCache.splice(cacheIdx, 1);
      if (tab) {
        // removeTab activates the neighboring tab when the deleted one was active.
        removeTab(engine, sessionId, tab.workspacePath);
      } else {
        set((s) => ({
          active:
            s.active?.sessionId === sessionId && s.active.engine === engine
              ? null
              : s.active,
        }));
      }
    },

    pinSession: async (engine, sessionId, pinned) => {
      try {
        await ipc.pinSession(engine, sessionId, pinned);
        await get().refreshSessions();
        set({ actionError: null });
      } catch (error) {
        set({ actionError: errorText(error) });
      }
    },

    renameSession: async (engine, sessionId, title) => {
      try {
        await ipc.renameSession(engine, sessionId, title);
        await get().refreshSessions();
        set({ actionError: null });
      } catch (error) {
        set({ actionError: errorText(error) });
      }
    },

    compactContext: async (key?: string) => {
      const { active, streamingByKey, openTabs } = get();
      const targetKey =
        key ??
        (active
          ? sessionKey(active.engine, active.sessionId, active.workspacePath)
          : "");
      if (!targetKey) return;
      if (streamingByKey[targetKey]) return;
      const targetTab =
        openTabs.find(
          (t) =>
            sessionKey(t.engine, t.sessionId, t.workspacePath) === targetKey,
        ) ?? active;
      if (!targetTab) return;

      // Track the compaction turn completion so callers (and UI) can await it.
      let cleanup: (() => void) | undefined;
      const completionPromise = new Promise<void>((resolve) => {
        let started = false;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const unsub = useChatStore.subscribe(() => {
          const currentStreaming = get().streamingByKey;
          const isStreaming = Boolean(
            currentStreaming[targetKey] ||
              (targetTab.sessionId &&
                currentStreaming[
                  sessionKey(
                    targetTab.engine,
                    targetTab.sessionId,
                    targetTab.workspacePath,
                  )
                ]),
          );
          if (isStreaming) {
            started = true;
          } else if (started) {
            done();
          }
        });

        const done = () => {
          if (timeoutId) clearTimeout(timeoutId);
          unsub();
          resolve();
        };

        timeoutId = setTimeout(done, 120_000);
        cleanup = () => {
          if (timeoutId) clearTimeout(timeoutId);
          unsub();
        };
      });

      try {
        await sendPrompt(targetTab, "/compact", []);
      } catch (error) {
        cleanup?.();
        throw error;
      }

      await completionPromise;
      // After compaction turn finishes, wait briefly for engine to persist session file,
      // then refresh session usage snapshot.
      await new Promise((r) => setTimeout(r, 400));
      const latestTab =
        get().openTabs.find(
          (t) =>
            sessionKey(t.engine, t.sessionId, t.workspacePath) === targetKey,
        ) ?? get().active;
      const finalKey = latestTab
        ? sessionKey(
            latestTab.engine,
            latestTab.sessionId,
            latestTab.workspacePath,
          )
        : targetKey;
      await get().refreshSessionUsage(finalKey);
    },

    refreshSessionUsage: async (key?: string) => {
      const { active, openTabs } = get();
      const targetKey =
        key ??
        (active
          ? sessionKey(active.engine, active.sessionId, active.workspacePath)
          : "");
      if (!targetKey) return;
      // A background/closed tab must never fall back to the active session.
      const targetTab = openTabs.find(
        (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === targetKey,
      );
      const slashIdx = targetKey.indexOf("/");
      const engine = targetTab?.engine ?? targetKey.slice(0, slashIdx);
      const sessionId = targetTab?.sessionId ?? targetKey.slice(slashIdx + 1);
      if (targetKey.startsWith("new:") || slashIdx < 1 || !engine || !sessionId) return;
      const before = get().bySession[targetKey];
      if (!before) return;
      const beforeTotal = parseUsage(before.usage)?.total ?? null;

      try {
        // The engine flushes a turn's final usage into the transcript file a
        // moment after the settle event fires, so a read that still shows the
        // pre-turn snapshot is retried briefly instead of leaving the meter
        // stale. A read that resolves *behind* a newer live report is dropped
        // outright — live data wins and the file catches up on a later
        // refresh; patching it back would resurrect the stale totals and drop
        // the live context window.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const page = await loadHistoryPage(
            engine,
            sessionId,
            targetTab?.workspacePath ?? "",
            100,
          );
          const latestUsage =
            [...page.messages].reverse().find((m) => m.usage)?.usage ?? null;
          if (!latestUsage) return;
          const current = get().bySession[targetKey]?.usage;
          const latestTotal = parseUsage(latestUsage)?.total ?? null;
          const currentTotal = parseUsage(current)?.total ?? null;
          if (
            latestTotal !== null &&
            currentTotal !== null &&
            latestTotal < currentTotal
          ) {
            return;
          }
          if (beforeTotal !== null && latestTotal === beforeTotal && attempt < 2) {
            const wait = Promise.withResolvers<void>();
            setTimeout(wait.resolve, 300);
            await wait.promise;
            continue;
          }
          // The transcript carries the API's per-message usage and no window;
          // only the live result line reports one. Keep the window already
          // known for this session so the gauge holds its scale.
          patchSession(set, targetKey, {
            usage: mergeUsage(latestUsage, current),
          });
          return;
        }
      } catch (error) {
        console.error("Failed to refresh session usage:", error);
      }
    },

    /** Backfill the engine's uuids onto just-sent prompts. The local echo
     *  carries none, so without this the branch affordance stays hidden on
     *  the newest rows until the session is re-read. Once a turn settles,
     *  walk the session's user rows against the freshly flushed transcript —
     *  bound rows pin the walk, pending rows take an exactly-aligned entry.
     *  Only user rows are backfilled (replies take theirs from the engine's
     *  message_uuid event); matches apply by seq with a text check so a
     *  stale read can never stamp a session that has changed underneath. */
    /** Re-read which uuids the CLI can still resume at and realign the rows'
     *  rewind entries: a mid-turn compaction archives the history the client
     *  already holds, while the preserved slice stays resumable. Rows without
     *  a uuid, and a read that cannot be confirmed, are left alone. The
     *  update covers only what existed when the read started — a newer turn
     *  (or a newer anchor) that lands meanwhile is never judged by it. */
    refreshRewindable: async (key?: string) => {
      const { active, openTabs } = get();
      const targetKey =
        key ??
        (active
          ? sessionKey(active.engine, active.sessionId, active.workspacePath)
          : "");
      if (!targetKey) return;
      const targetTab = openTabs.find(
        (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === targetKey,
      );
      if (!targetTab?.sessionId) return;
      const before = get().bySession[targetKey];
      if (!before) return;
      const covered = new Set(
        before.messages
          .map((m) => m.uuid)
          .filter((uuid): uuid is string => Boolean(uuid)),
      );
      const uuids = await ipc.sessionRewindableUuids(
        targetTab.engine,
        targetTab.sessionId,
      );
      if (!uuids) return;
      const allowed = new Set(uuids);
      set((s) => {
        const cur = s.bySession[targetKey];
        if (!cur) return {};
        return {
          bySession: {
            ...s.bySession,
            [targetKey]: {
              ...cur,
              messages: cur.messages.map((m) => {
                if (!m.uuid || !covered.has(m.uuid)) return m;
                const archived = !allowed.has(m.uuid);
                return m.archived === archived ? m : { ...m, archived };
              }),
            },
          },
        };
      });
      const anchor =
        get().bySession[targetKey]?.rewindAnchor ??
        readRewindAnchors()[targetKey] ??
        null;
      if (anchor && covered.has(anchor) && !allowed.has(anchor)) {
        get().consumeRewindAnchor(targetKey, anchor);
      }
    },

    refreshSessionUuids: async (key?: string) => {
      const { active, openTabs } = get();
      const targetKey =
        key ??
        (active
          ? sessionKey(active.engine, active.sessionId, active.workspacePath)
          : "");
      if (!targetKey) return;
      const targetTab = openTabs.find(
        (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === targetKey,
      );
      const slashIdx = targetKey.indexOf("/");
      const engine = targetTab?.engine ?? targetKey.slice(0, slashIdx);
      const sessionId = targetTab?.sessionId ?? targetKey.slice(slashIdx + 1);
      if (targetKey.startsWith("new:") || slashIdx < 1 || !engine || !sessionId) return;
      const session = get().bySession[targetKey];
      if (!session) return;
      if (!session.messages.some((m) => m.role === "user" && !m.uuid)) return;
      try {
        const workspace = targetTab?.workspacePath ?? "";
        // uuids already bound to local rows — a pending free row may never
        // take one of these, or the newest twin of a repeated prompt would
        // steal the older row's uuid when its own entry has not reached the
        // file yet. Such a miss keeps counting as unresolved, so the retry
        // loop keeps waiting for the real entry.
        const bound = new Set(
          session.messages
            .filter((m) => m.role === "user" && m.uuid)
            .map((m) => m.uuid!),
        );
        // Walk the session's user rows against the transcript in time order:
        // rows that already hold a uuid pin the walk (a repeated prompt can
        // never take an earlier entry's uuid), and a pending row only takes
        // an entry whose text aligns exactly.
        const findMatches = (candidates: SessionPage["messages"]) => {
          const matches: { seq: number; text: string; uuid: string }[] = [];
          // Walk both lists from their newest ends: the tails are the
          // freshest state and align most reliably, and a bound row pins the
          // walk so a repeated prompt can never take an earlier entry's uuid.
          // A pending row only takes an entry whose text aligns exactly —
          // containment would let a short "继续" match any old prompt
          // carrying the word.
          let cursor = candidates.length - 1;
          for (let k = session.messages.length - 1; k >= 0; k -= 1) {
            const message = session.messages[k];
            if (message.role !== "user") continue;
            if (message.uuid) {
              let pinned = -1;
              for (let i = cursor; i >= 0; i -= 1) {
                if (candidates[i].uuid === message.uuid) {
                  pinned = i;
                  break;
                }
              }
              if (pinned >= 0) cursor = pinned - 1;
              continue;
            }
            for (let i = cursor; i >= 0; i -= 1) {
              const candidate = candidates[i];
              if (
                candidate.uuid &&
                !bound.has(candidate.uuid) &&
                textsAlign(candidate.text, message.text)
              ) {
                matches.push({
                  seq: message.seq,
                  text: message.text,
                  uuid: candidate.uuid,
                });
                cursor = i - 1;
                break;
              }
            }
          }
          return matches;
        };
        const collect = (messages: SessionPage["messages"]) =>
          messages.filter((m) => m.role === "user" && m.uuid);
        const missing = () =>
          session.messages.some(
            (m) =>
              m.role === "user" &&
              !m.uuid &&
              !matches.some((match) => match.seq === m.seq),
          );
        // A tool-heavy turn can pack hundreds of transcript rows between the
        // prompt and EOF; keep walking older pages while anything is
        // unmatched, capped so a pathological session cannot read forever.
        const MAX_PAGES = 5;
        // The engine may still be flushing (a stop right after send, or a
        // fresh error): retry briefly, like the usage re-read does, so a
        // prompt that lands in the file a moment later is not lost forever.
        const MAX_ROUNDS = 3;
        let matches: { seq: number; text: string; uuid: string }[] = [];
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          let page = await loadHistoryPage(engine, sessionId, workspace, 100);
          let candidates = collect(page.messages);
          matches = findMatches(candidates);
          for (
            let pages = 1;
            missing() && page.nextBefore != null && pages < MAX_PAGES;
            pages += 1
          ) {
            page = await loadHistoryPage(
              engine,
              sessionId,
              workspace,
              100,
              page.nextBefore,
            );
            candidates = [...collect(page.messages), ...candidates];
            matches = findMatches(candidates);
          }
          if (!missing()) break;
          if (round < MAX_ROUNDS - 1) {
            const wait = Promise.withResolvers<void>();
            setTimeout(wait.resolve, 300);
            await wait.promise;
          }
        }
        if (matches.length === 0) return;
        set((s) => {
          const cur = s.bySession[targetKey];
          if (!cur) return {};
          let changed = false;
          const messages = cur.messages.map((message) => {
            if (message.uuid) return message;
            const hit = matches.find(
              (m) => m.seq === message.seq && m.text === message.text,
            );
            if (!hit) return message;
            changed = true;
            return { ...message, uuid: hit.uuid };
          });
          if (!changed) return {};
          return {
            bySession: { ...s.bySession, [targetKey]: { ...cur, messages } },
          };
        });
      } catch (error) {
        console.error("Failed to refresh session uuids:", error);
      }
    },
  };
});

// Dev-only handle for poking the store from the webview console; stripped
// from production builds by the env guard.
if (import.meta.env.DEV) {
  (window as unknown as { __chatStore: typeof useChatStore }).__chatStore =
    useChatStore;
}

/**
 * Plugin API backend (ctx.sessions.setEffort, host:session): patch an
 * EXISTING session's effort and persist it. Unknown keys are rejected — a
 * wrong workspacePath/sessionId must not mint a ghost EMPTY_SESSION entry
 * via patchSession. The owning tab's effort stamp is cleared (parity with
 * setEffort's session branch) so refreshSessions cannot resurrect the
 * pre-patch level.
 */
export function setPluginSessionEffort(
  engine: string,
  sessionId: string,
  workspacePath: string,
  effort: string,
): void {
  const trimmed = effort.trim();
  if (!trimmed) {
    throw new Error("sessions.setEffort: effort must be non-empty");
  }
  if (!engine || !sessionId) {
    throw new Error("sessions.setEffort: engine and sessionId are required");
  }
  const key = sessionKey(engine, sessionId, workspacePath);
  const state = useChatStore.getState();
  if (!state.bySession[key]) {
    throw new Error(`sessions.setEffort: unknown session ${key}`);
  }
  patchSession(useChatStore.setState, key, { activeEffort: trimmed });
  void ipc.rememberSessionEffort?.(engine, sessionId, trimmed)?.catch(() => {});
  const clearStamp = <T extends { engine: string; sessionId: string | null; workspacePath: string; effort?: string }>(
    t: T,
  ): T =>
    sessionKey(t.engine, t.sessionId, t.workspacePath) === key && t.effort !== undefined
      ? { ...t, effort: undefined }
      : t;
  const openTabs = state.openTabs.map(clearStamp);
  const active = state.active ? clearStamp(state.active) : state.active;
  if (openTabs.some((t, i) => t !== state.openTabs[i]) || active !== state.active) {
    useChatStore.setState({ openTabs, active });
    persistTabs(openTabs, active);
  }
}

// HMR swaps this module for a fresh store; without dispose the old module's
// engine/session listeners keep firing into the dead store (and init on the
// new store would double-subscribe).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const teardown of eventTeardowns.splice(0)) teardown();
  });
}
