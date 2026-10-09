import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import { AddMenu } from "@/components/application/ai-chat/add-menu";
import { PermissionMenu } from "@/components/application/ai-chat/permission-menu";
import type { ComposerPermission } from "@/components/application/ai-chat/permission-menu";
import {
  CliMenu,
  type EffortLevel,
  type ModelOption,
} from "@/components/application/ai-chat/cli-menu";
import {
  effectivePermission,
  useChatStore,
  sessionKey,
  type ActiveSession,
  type QueuedMessage,
} from "../store";

import { MessageTimeline } from "./MessageTimeline";
import { ConversationFooter } from "./ConversationFooter";
import { RewindDialog } from "./RewindDialog";
import { EditMessageDialog } from "./EditMessageDialog";
import { useComposerActions } from "./use-composer-actions";
import { filterEngineOptions } from "./engine-options";
import { ErrorBanner } from "./ErrorBanner";
import { useBranchSwitcher } from "./use-branch-switcher";
import { useComposerImages } from "./use-composer-images";
import { useEngineModels } from "./use-engine-models";
import { useTabDisplayProviders, useTabModelDisplay } from "./use-tab-model-display";
import { useSessionModelRepair } from "./use-session-model-repair";
import { findChannelDefault } from "../store/channel-defaults";
import { useDefaultAutoCompactWindow } from "./use-default-auto-compact-window";
import type { EngineInfo, Workspace } from "@/lib/ipc";
import { EmptyState } from "@/components/base/empty-state";
import { parseUsage } from "../usage";
import { rememberContextWindow, resolveContextMax } from "../context-window-memory";
import { lastRowIndexByUuid, resolveSessionProvider } from "../store/stream";
import { useWorkspaceUIHooks, workspaceAllowedEngines } from "../workspace-ui-bridge";
import { useFilesStore } from "@/features/files/store";


const EMPTY_QUEUE: QueuedMessage[] = [];

/** Message list with its own bySession subscription: stream flushes swap the
 * messages array once per animation frame, and this boundary keeps that
 * high-frequency re-render from reaching the composer/status bar above. */
const SessionTimeline = memo(function SessionTimeline({
  sessionKey: key,
  workspacePath,
  onLoadEarlier,
}: {
  sessionKey: string;
  workspacePath: string;
  onLoadEarlier: () => void;
}) {
  const session = useChatStore((s) => s.bySession[key]);
  // The retry icon repeats the last prompt (the terminal's `//`); the store
  // action already guards mid-turn sends and finds the last user message.
  const resendLastUser = useChatStore((s) => s.resendLastUser);
  // The branch icon forks the conversation at one message (the CLI's
  // /branch) and opens the fork in place.
  const branchFromMessage = useChatStore((s) => s.branchFromMessage);
  // The rewind icon opens the 回退 choice for one message.
  const setRewindAnchor = useChatStore((s) => s.setRewindAnchor);
  const rewindWorkspaceFiles = useChatStore((s) => s.rewindWorkspaceFiles);
  const applyEditedMessage = useChatStore((s) => s.applyEditedMessage);
  const refreshRewindable = useChatStore((s) => s.refreshRewindable);
  const { t } = useTranslation();
  const [rewindTarget, setRewindTarget] = useState<{
    uuid: string;
    role: "user" | "assistant";
  } | null>(null);
  const [editTarget, setEditTarget] = useState<{
    uuid: string;
    text: string;
    tail?: string;
  } | null>(null);
  const handleRewindPick = (mode: "conversation" | "files" | "both") => {
    const target = rewindTarget;
    setRewindTarget(null);
    if (!target) return;
    if (mode === "conversation") {
      setRewindAnchor(key, target.uuid);
      return;
    }
    void (async () => {
      // Unsaved editor content would be clobbered by the restore (or would
      // clobber it back on the next save): refuse instead of guessing.
      const files = useFilesStore.getState();
      if (Object.keys(files.dirtyPaths).length > 0) {
        useChatStore.setState({ actionError: t("chat.rewindDirtyEditors") });
        return;
      }
      await rewindWorkspaceFiles(key, target.uuid);
      // Refresh only when the restore landed; a failure surfaced through the
      // store's error banner keeps the tree and the editors as they were.
      if (useChatStore.getState().actionError) return;
      const open = useFilesStore.getState().openFiles;
      void useFilesStore.getState().refreshTree();
      // Clean editors reload from disk so they show the restored content — a
      // stale buffer must not overwrite it on the next save.
      for (const path of open) void useFilesStore.getState().reloadFile(path);
      if (mode === "both") setRewindAnchor(key, target.uuid);
    })();
  };
  if (!session) return null;
  // Pending rewind (the 回退 action): show the conversation up to and
  // including the anchor's whole transcript entry — the next send writes the
  // same truncation into the transcript. One entry can produce several rows
  // sharing its uuid, so the cut takes the LAST of them; an anchor outside
  // the loaded window leaves the list untouched.
  const anchorIndex = session.rewindAnchor
    ? lastRowIndexByUuid(session.messages, session.rewindAnchor)
    : -1;
  const shown =
    anchorIndex >= 0
      ? { ...session, messages: session.messages.slice(0, anchorIndex + 1) }
      : session;
  const engineEnd = key.indexOf("/");
  const engine = engineEnd > 0 ? key.slice(0, engineEnd) : "claude";
  const sessionId =
    key.startsWith("new:") || engineEnd <= 0 ? null : key.slice(engineEnd + 1);
  return (
    <>
      <MessageTimeline
        key={key}
        session={shown}
        streaming={session.streaming}
        onLoadEarlier={onLoadEarlier}
        workspacePath={workspacePath}
        onRetry={() => void resendLastUser(key)}
        onBranch={(targetUuid) => void branchFromMessage(key, targetUuid)}
        onRewind={setRewindTarget}
        onEdit={setEditTarget}
      />
      {editTarget && sessionId && (
        <EditMessageDialog
          engine={engine}
          sessionId={sessionId}
          workspacePath={workspacePath}
          target={editTarget}
          onSaved={(uuid, text) => {
            applyEditedMessage(key, uuid, text);
            // The edit rewrote the transcript: re-read the resumable set so
            // the rewind entries and affordances match the file the CLI will
            // walk, and a stale anchor pointing outside it is dropped. The
            // dialog waits for this before closing (a prompt continue/retry
            // must not read the stale anchor).
            return refreshRewindable(key);
          }}
          onClose={() => setEditTarget(null)}
        />
      )}
      {rewindTarget && (
        <RewindDialog
          engine={engine}
          sessionId={sessionId}
          target={rewindTarget}
          onPick={handleRewindPick}
          onClose={() => setRewindTarget(null)}
        />
      )}
    </>
  );
});


/** Composer menu slots (add / model / permission) plus the no-engine-options
 * state, memoized so per-keystroke draft updates don't rebuild the menus. */
function useConversationMenus({
  engines,
  engineInfo,
  activeEngine,
  onPickFiles,
  onPickSkills,
  modelsByEngine,
  displayModels,
  displayEfforts,
  channelsByEngine,
  displayProviders,
  permission,
  setPermission,
  setModel,
  setEffort,
  setProvider,
  refreshModels,
  loadingEngines,
  allowedEngines,
}: {
  engines: EngineInfo[];
  engineInfo: EngineInfo | undefined;
  activeEngine: string;
  onPickFiles: () => void;
  /** "Skills" add-menu row: opens the composer's `/` command picker. */
  onPickSkills: () => void;
  modelsByEngine: Record<string, ModelOption[]>;
  displayModels: Record<string, string>;
  displayEfforts: Record<string, EffortLevel>;
  channelsByEngine: Record<string, { id: string; label: string }[]>;
  displayProviders: Record<string, string>;
  permission: ComposerPermission;
  setPermission: (permission: ComposerPermission) => void;
  setModel: (engine: string, model: string) => Promise<void>;
  setEffort: (engine: string, effort: EffortLevel) => Promise<void>;
  setProvider: (engine: string, providerId: string) => Promise<void>;
  refreshModels: () => Promise<void>;
  loadingEngines: readonly string[];
  /** 接管工作区(桥返回非 null):仅列允许表内引擎(null = 不过滤)。 */
  allowedEngines: string[] | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // 接管工作区下: 列表只留桥给的允许表,可用态按列表内与否而不是本机
  // `command -v` —— 否则本机没装的引擎在接管工作区里永远灰点。
  const cliOptions = useMemo(
    () => filterEngineOptions(engines, allowedEngines, t),
    [engines, allowedEngines, t],
  );
  // No engine is left after the allow-list filter (a delegated workspace that
  // permits none of them): swap the picker for a placeholder that deep-links
  // to the model config page.
  const noEngineOptions = engines.length > 0 && cliOptions.length === 0;
  const handleModelChange = useCallback(
    (engine: string, m: string) => void setModel(engine, m),
    [setModel],
  );
  const handleEffortChange = useCallback(
    (engine: string, level: EffortLevel) => void setEffort(engine, level),
    [setEffort],
  );
  const handleChannelChange = useCallback(
    (engine: string, id: string) => void setProvider(engine, id),
    [setProvider],
  );


  // Files & folders works for every engine: non-image picks become @mentions
  // (plain text), and image picks on an engine without image input surface
  // the unsupported banner instead of being silently dropped — so the menu
  // stays enabled regardless of supportsImages.
  const addMenu = useMemo(
    () => <AddMenu onPickFiles={onPickFiles} onPickSkills={onPickSkills} />,
    [onPickFiles, onPickSkills],
  );
  const cliMenu = useMemo(
    () =>
      noEngineOptions ? (
        <button
          type="button"
          onClick={() => navigate("/settings?page=cli:claude")}
          className="flex cursor-pointer items-center rounded-md px-1.5 py-1 text-body-2-medium whitespace-nowrap text-text-tertiary transition-colors duration-150 ease hover:text-text-primary"
        >
          {t("chat.noEngineOptions")}
        </button>
      ) : (
        <CliMenu
          options={cliOptions}
          value={activeEngine}
          modelsByEngine={modelsByEngine}
          models={displayModels}
          onModelChange={handleModelChange}
          efforts={displayEfforts}
          onEffortChange={handleEffortChange}
          channelsByEngine={channelsByEngine}
          selectedChannels={displayProviders}
          onChannelChange={handleChannelChange}
          onRefreshModels={refreshModels}
          loadingEngines={loadingEngines}
        />
      ),
    [
      noEngineOptions,
      navigate,
      t,
      cliOptions,
      activeEngine,
      modelsByEngine,
      displayModels,
      handleModelChange,
      displayEfforts,
      handleEffortChange,
      channelsByEngine,
      displayProviders,
      handleChannelChange,
      refreshModels,
      loadingEngines,
    ],
  );
  const permissionMenu = useMemo(
    () => (
      <PermissionMenu
        value={effectivePermission(engines, activeEngine, permission)}
        onChange={setPermission}
        supported={engineInfo?.permissions}
      />
    ),
    [engines, activeEngine, permission, setPermission, engineInfo],
  );

  return { addMenu, cliMenu, permissionMenu, noEngineOptions };
}

/** Conversation column: timeline, message queue, composer, status bar. The
 * high-frequency session/draft subscriptions live here so streaming deltas
 * (one store write per animation frame) re-render only this subtree — never
 * the sidebar, tab strip, or side panel. */
export const ChatConversation = memo(function ChatConversation({
  active,
  engines,
  workspaces,
  startNewChat,
  composerInputRef,
}: {
  active: ActiveSession | null;
  engines: EngineInfo[];
  workspaces: Workspace[];
  startNewChat: (workspacePath: string) => void;
  composerInputRef: React.RefObject<ComposerInputHandle | null>;
}) {
  const { t } = useTranslation();
  const key = active
    ? sessionKey(active.engine, active.sessionId, active.workspacePath)
    : "";
  // Key-scoped, LOW-frequency slices only: streaming flips at turn start/end,
  // queue/error/usage change on discrete actions. The per-flush messages
  // array is subscribed inside SessionTimeline so stream deltas re-render
  // only that subtree — never the composer, queue bar, or status bar here.
  const streaming = useChatStore((s) =>
    key ? (s.bySession[key]?.streaming ?? false) : false,
  );
  const sessionError = useChatStore((s) =>
    key ? (s.bySession[key]?.error ?? null) : null,
  );
  const dismissSessionError = useChatStore((s) => s.dismissSessionError);
  const queue = useChatStore((s) =>
    key ? (s.bySession[key]?.queue ?? EMPTY_QUEUE) : EMPTY_QUEUE,
  );
  const sessionUsage = useChatStore((s) =>
    key ? s.bySession[key]?.usage : undefined,
  );
  const autoCompactWindow = useChatStore((s) =>
    key ? (s.bySession[key]?.autoCompactWindow ?? null) : null,
  );
  // The provider the next send would use; its channel config may carry the
  // auto-compact window that applies while the session has no override.
  const activeProviderId = useChatStore((s) => {
    const a = s.active;
    if (!a) return null;
    const k = sessionKey(a.engine, a.sessionId, a.workspacePath);
    return resolveSessionProvider(a, s.bySession[k], s.providers[a.engine]) ?? null;
  });
  const hasSession = useChatStore((s) => key in s.bySession);
  const draft = useChatStore((s) => s.drafts[key] ?? "");
  const sendShortcut = useChatStore((s) => s.sendShortcut);
  // Engine/effort/model prefs: low-frequency, grouped into one shallow watch.
  const { activeEngine, efforts, models, providers } = useChatStore(
    useShallow((s) => ({
      activeEngine: s.activeEngine,
      efforts: s.efforts,
      models: s.models,
      providers: s.providers,
    })),
  );
  const {
    setEffort,
    setModel,
    setProvider,
    pinModels,
    repairSessionModel,
    loadEarlier,
    removeQueued,
    sendQueuedNow,
    clearQueue,
  } = useChatStore(
    useShallow((s) => ({
      setEffort: s.setEffort,
      setModel: s.setModel,
      setProvider: s.setProvider,
      pinModels: s.pinModels,
      repairSessionModel: s.repairSessionModel,
      loadEarlier: s.loadEarlier,
      removeQueued: s.removeQueued,
      sendQueuedNow: s.sendQueuedNow,
      clearQueue: s.clearQueue,
    })),
  );
  const {
    branch,
    branches,
    branchRepoName,
    branchError,
    handleBranchSelect,
    dismissBranchError,
  } = useBranchSwitcher(active);
  // Permission mode lives in the store (persisted) and flows into every
  // send; engines that cannot honor the selected mode fall back to their
  // first supported one, which is what the chip displays.
  const permission = useChatStore((s) => s.permission);
  const setPermission = useChatStore((s) => s.setPermission);

  const {
    images,
    previews,
    imageError,
    removeImage,
    clearImages,
    pasteImages,
    importImageFiles,
    dismissImageError,
  } = useComposerImages();

  const displayProviders = useTabDisplayProviders({
    active,
    activeEngine,
    sessionKey: key,
    providers,
  });

  const {
    catalogs,
    modelsByEngine,
    channelsByEngine,
    sessionIdsByEngine,
    readyEngines,
    refresh: refreshModels,
    pendingEngines,
  } = useEngineModels(engines, models, pinModels, displayProviders, active?.workspacePath);
  const loadingEngines = useMemo(
    () => Object.keys(pendingEngines),
    [pendingEngines],
  );

  // Channel default picks (per engine + channel) filled by the store when
  // the CLI config loads, so display and send resolve the same value.
  const channelDefaults = useChatStore((s) => s.channelDefaults);
  const { displayModels, displayEfforts } = useTabModelDisplay({
    active,
    activeEngine,
    sessionKey: key,
    models,
    efforts,
    channelDefault: findChannelDefault(
      channelDefaults,
      activeEngine,
      displayProviders[activeEngine],
    ),
  });
  // A model override the channel no longer serves would surface as the
  // engine name in the model slot; drop it so the channel default takes over.
  useSessionModelRepair({
    active,
    activeEngine,
    sessionIds: sessionIdsByEngine,
    ready: readyEngines,
    repair: repairSessionModel,
  });

  const displayModel = displayModels[activeEngine];
  const defaultWindow = useDefaultAutoCompactWindow(
    activeEngine,
    activeProviderId,
  );
  // The session's /maxtokens-style override (the composer's 上下文窗口
  // control) is the effective window and wins; otherwise the
  // conversation-reported window (Codex token_count, Claude's modelUsage)
  // wins; a fresh session starts from the last window this engine+model was
  // seen reporting; the model catalog is the fallback for engines that never
  // report one, and the shared constant is the last resort.
  const contextMax = resolveContextMax({
    usage: sessionUsage,
    engine: activeEngine,
    model: displayModel,
    catalogWindow: (catalogs[activeEngine]?.models ?? []).find(
      (m) => m.id === displayModel,
    )?.contextWindow,
    overrideWindow: autoCompactWindow,
    defaultWindow,
  });
  const observedWindow = parseUsage(sessionUsage)?.contextWindow;
  useEffect(() => {
    if (observedWindow) {
      rememberContextWindow(activeEngine, displayModel, observedWindow);
    }
  }, [observedWindow, activeEngine, displayModel]);

  const engineInfo = engines.find((e) => e.id === activeEngine);
  const supportsImages = engineInfo?.supportsImages ?? false;

  const handleLoadEarlier = useCallback(
    () => void loadEarlier(),
    [loadEarlier],
  );

  const {
    submit,
    handleDraftChange,
    handleAddAttachments,
    handleStop,
    handlePickSkills,
  } = useComposerActions({
    active,
    sessionKey: key,
    streaming,
    images,
    clearImages,
    importImageFiles,
    supportsImages,
    composerInputRef,
  });
  // 插件桥给出该工作区的引擎允许表(meta 形状留在插件侧,宿主不解释);
  // null = 非接管工作区,按本机探针展示。
  const uiHooks = useWorkspaceUIHooks();
  const allowedEngines = useMemo(
    // uiHooks 进依赖:插件 activate/热重载换 hooks 后允许表及时重算。
    () => workspaceAllowedEngines(active?.workspacePath),
    [uiHooks, active?.workspacePath],
  );
  const { addMenu, cliMenu, permissionMenu, noEngineOptions } =
    useConversationMenus({
      engines,
      engineInfo,
      activeEngine,
      allowedEngines,
      modelsByEngine,
      onPickFiles: handleAddAttachments,
      onPickSkills: handlePickSkills,
      displayModels,
      displayEfforts,
      channelsByEngine,
      displayProviders,
      permission,
      setPermission,
      setModel,
      setEffort,
      setProvider,
      refreshModels,
      loadingEngines,
    });

  return (
    <>
      {active && hasSession ? (
        <>
          {sessionError && (
            <ErrorBanner
              className="mx-4 mt-3"
              message={sessionError}
              onDismiss={() => dismissSessionError(key)}
            />
          )}
          <SessionTimeline
            sessionKey={key}
            workspacePath={active.workspacePath}
            onLoadEarlier={handleLoadEarlier}
          />
        </>
      ) : (
        <EmptyState className="text-body-medium">
          {t("chat.selectSession")}
        </EmptyState>
      )}

      <ConversationFooter
        active={active}
        workspaces={workspaces}
        queue={queue}
        onRemoveQueued={removeQueued}
        onSendQueuedNow={sendQueuedNow}
        onClearQueued={clearQueue}
        imageError={imageError}
        branchError={branchError}
        onDismissImageError={dismissImageError}
        onDismissBranchError={dismissBranchError}
        images={images}
        previews={previews}
        onRemoveImage={removeImage}
        draft={draft}
        onDraftChange={handleDraftChange}
        onSubmit={submit}
        sendShortcut={sendShortcut}
        onStop={handleStop}
        streaming={streaming}
        noEngineOptions={noEngineOptions}
        composerInputRef={composerInputRef}
        addMenu={addMenu}
        cliMenu={cliMenu}
        permissionMenu={permissionMenu}
        supportsImages={supportsImages}
        onPasteImages={pasteImages}
        sessionUsage={sessionUsage}
        contextMax={contextMax}
        branch={branch}
        branches={branches}
        branchRepoName={branchRepoName}
        onBranchSelect={handleBranchSelect}
        startNewChat={startNewChat}
      />
    </>
  );
});
