// Transport picks Tauri IPC natively and the web-access WS bridge in browsers.
import { invoke } from "./transport";
import { withGrantRetry } from "./grant";

// ==================== Shared types (mirror Rust serde camelCase) ====================

export interface SessionMeta {
  engine: string;
  sessionId: string;
  workspacePath: string;
  filePath: string;
  fileSize: number;
  fileMtimeMs: number;
  title: string;
  preview: string;
  createdAt: number | null;
  updatedAt: number | null;
  messageCount: number;
  pinned: boolean;
  customTitle: string | null;
  /** Model this app last sent for the session ("provider/model"), absent when
   * it never sent one — see ipc.rememberSessionModel. */
  model?: string | null;
  /** Reasoning effort this app last sent for the session, absent when it never
   *  recorded one — see ipc.rememberSessionEffort. */
  effort?: string | null;
  /** No local transcript (plugin session source, e.g. a WSL distro CLI):
   *  history replay routes through load_remote_session_page instead. */
  remote?: boolean;
  /** Absolute path of the transcript inside the distro (remote rows only). */
  remotePath?: string;
  /** In-app channel this session last ran. Spawn injects that channel's env;
   * native CLI files stay official. Absent until a send remembers one. */
  provider?: string | null;
}

export type TodoStatus = "pending" | "active" | "complete" | "blocked" | "dropped";

export interface TodoItem {
  id?: string | null;
  content: string;
  status: TodoStatus;
}

/** Todo-list payload on todo-class tool rows: replace = full snapshot,
 * otherwise a patch matched by content (status "dropped" removes). */
export interface TodosPayload {
  items: TodoItem[];
  replace: boolean;
}

/** One AskUserQuestion question as the CLI emits it (control protocol). */
export interface QuestionSpec {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
}

export interface Message {
  seq: number;
  role: string; // "user" | "assistant" | "tool" | "thinking" | "notice"
  text: string;
  /** Severity of a notice row (claude `system/informational` messages the
   *  terminal prints inline: second-brain advice and call failures,
   *  personal-memory notes, model fallback). Absent on every other role. */
  level?: string | null;
  /** Target file of a tool call (read/edit/write/...); renders as a file chip. */
  path?: string | null;
  /** Full tool-call arguments; shown in the expandable tool-call panel. */
  args?: unknown;
  /** Tool execution result/output; shown in the tool panel. */
  result?: unknown;
  todos?: TodosPayload;
  ts: string | null;
  /** The CLI's own uuid for the transcript entry (main conversation only):
   *  the branch action addresses fork points by it. Live rows get it from
   *  the engine's `message_uuid` event once the reply finishes streaming. */
  uuid?: string | null;
  usage?: unknown;
  model?: string | null;
  /** Reasoning effort level ("low" | "medium" | "high" | "xhigh" | "max") */
  effort?: string | null;
  /** Turn duration in milliseconds (measured from prompt send to turn completion) */
  durationMs?: number | null;
  /** True while the row belongs to the in-flight stream and may still grow. */
  live?: boolean;
  /** Permission-denial card state (role "grant"): the CLI denied a tool call
   * targeting `path`; pending until the user answers the card. `dir` is the
   * directory a grant would cover (grant_scope preview). Grant rows are
   * ephemeral UI — they are not part of the CLI's session history. */
  grant?: {
    status: "pending" | "granted" | "declined";
    dir?: string | null;
  };
  /** AskUserQuestion card state (role "question"): the CLI parked the ask on
   * the control protocol; `pending` until the user picks or skips. `runId`
   * routes the answer to the process, `requestId` to the ask itself. These
   * rows are ephemeral UI — not part of the CLI's session history. */
  question?: {
    requestId: string;
    runId: string;
    toolUseId?: string | null;
    questions: QuestionSpec[];
    status: "pending" | "answered" | "dismissed" | "cancelled";
    answers?: Record<string, string | string[]>;
  };
  /** Tool-permission ask card (role "permission"): the CLI parked a
   *  can_use_tool ask on the control protocol; `pending` until the user
   *  approves or denies. `runId`/`requestId` route the answer; `input` is
   *  the exact tool input replayed on approve. Ephemeral UI — not part of
   *  the CLI's session history. */
  permission?: {
    requestId: string;
    runId: string;
    toolName: string;
    toolUseId?: string | null;
    title?: string | null;
    description?: string | null;
    input?: unknown;
    status: "pending" | "allowed" | "denied" | "cancelled";
  };
  /** Image attachments: data URLs render directly, absolute paths load via readFile. */
  images?: string[];
}

export interface SessionPage {
  messages: Message[];
  nextBefore: number | null;
  /** Delegation metadata before this page, restored from the session file. */
  subagentHistory: Message[];
}

export interface Workspace {
  id: string;
  path: string;
  name: string;
  lastOpenedAt: number | null;
  sortOrder: number | null;
  /** Sidebar group id (工作区分组); null = ungrouped. */
  groupId: string | null;
  /** Opaque per-workspace metadata written by host-capability callers
   *  (e.g. { wsl: { hostId, distro } } from the wsl plugin); absent for
   *  ordinary directories. */
  meta?: Record<string, unknown>;
}

export interface EngineInfo {
  id: string;
  available: boolean;
  supportsImages: boolean;
  /** Permission modes the engine honors at spawn (CLI machine values:
   * "autoContinue" | "default" | "acceptEdits" | "plan" | "readonly" |
   * "readonlyAsk" | "auto" | "bypass"); the composer picker greys out the
   * rest. */
  permissions: string[];
}
/** One entry of an engine's model catalog (`--list-models` probe). */
export interface EngineModel {
  /** Selector passed to `--model` ("provider/model"). */
  id: string;
  /** Display name when the catalog carries one. */
  name?: string | null;
  /** Secondary line under the name (e.g. "Custom High model"). */
  description?: string | null;
  provider: string;
  /** Context window tokens when the catalog reports one. */
  contextWindow?: number | null;
}

/** An engine's model catalog plus how much trust the list deserves. */
export interface EngineCatalog {
  models: EngineModel[];
  /**
   * True when `models` is exactly what the CLI's model flag resolves
   * (config/registry/binary-derived): a stored pick outside it cannot
   * run and should reset to the leading entry. False for relay-probed
   * lists (claude), which may be partial.
   */
  authoritative: boolean;
  /**
   * True for a remote workspace (WSL distro) catalog: the local provider
   * channel and custom models are NOT runnable there, so the picker must
   * not merge them — only `models` is selectable.
   */
  remote?: boolean;
}

export interface SendResult {
  runId: string;
  sessionId: string | null;
}

export interface ProviderSection {
  providers: Record<string, unknown>;
  current: string | null;
}
/** Result of `fetch_provider_models`: model ids plus the candidate URL that
 *  answered (a derivation of the channel's base URL). */
export interface ProviderModelList {
  models: string[];
  endpoint: string;
}

export interface WorkspaceGroup {
  id: string;
  name: string;
  sortOrder?: number | null;
  /** Legacy "clone copies" folder, preserved on import round-trips. */
  copiesFolder?: string | null;
}

export interface CliConfig {
  claude: ProviderSection;
}

export interface AppSettings {
  theme: string;
  /** Windows 标题栏样式："native" | "mac"（仿 mac 自绘标题栏）。仅 Windows 生效，
   *  改动需重启应用；macOS 恒为系统原生红绿灯。 */
  titlebar: string;
  /** Sidebar workspace groups (工作区二级分类), ordered by sortOrder then name.
   *  The assignment lives on each workspace (`Workspace.groupId`). */
  workspaceGroups: WorkspaceGroup[];
  /** Workspace id -> sidebar display alias; absent = show the folder name. */
  workspaceAliases: Record<string, string>;
  /** Ids of workspaces hidden into the sidebar's collapsible 已归档 section. */
  archivedWorkspaces: string[];
  language: string;
  claudeBin: string | null;
  defaultModels: Record<string, string>;
  /** Per-engine user-added custom model ids (设置 → CLI → 自定义模型). */
  customModels: Record<string, string[]>;
  defaultEfforts: Record<string, string>;
  /** Max sessions listed per workspace in the sidebar (default 5). */
  sidebarThreadLimit: number;
  /** Composer send gesture: "enter" (Enter sends) or "cmdEnter" (⌘/Ctrl+Enter sends). */
  composerSendShortcut: string;
  /** Keyboard shortcuts (快捷键), format "cmd+ctrl+alt+shift+key" lowercase;
   *  null = unbound. Defaults live in src/features/shortcuts/actions.ts;
   *  interruptShortcut null = platform default (mac ctrl+c, win ctrl+shift+c). */
  newSessionShortcut?: string | null;
  interruptShortcut?: string | null;
  commandPaletteShortcut?: string | null;
  sidebarSearchShortcut?: string | null;
  toggleTerminalShortcut?: string | null;
  toggleSidebarShortcut?: string | null;
  toggleSidePanelShortcut?: string | null;
  saveFileShortcut?: string | null;
  openSettingsShortcut?: string | null;
  increaseUiScaleShortcut?: string | null;
  decreaseUiScaleShortcut?: string | null;
  resetUiScaleShortcut?: string | null;
  /** Thinking-process row behavior once its thinking settles: true/absent =
   *  auto-fold (default), false = stay expanded until the user folds it. */
  thinkingAutoCollapse?: boolean | null;
  /** Detailed chat display: absent/false = concise (default), true = process
   *  rows stay expanded and tool calls show arguments and results inline. */
  detailedDisplay?: boolean | null;
  /** Terminal shell override; null/empty = auto-detect. */
  terminalShellPath: string | null;
  /** Global network proxy switch; spawned children inherit the proxy env. */
  systemProxyEnabled: boolean;
  /** Proxy URL (http/https/socks5); null = unset. */
  systemProxyUrl: string | null;
  /** Global CLI feature variables (联网搜索、OSS、飞书、记忆、二脑…): the app
   *  injects them into every engine spawn. */
  cliEnv?: Record<string, string>;
  /** Require a pairing key before the bridge serves a browser. */
  webAuthEnabled?: boolean | null;
  /** 8-character pairing key, minted when the switch is turned on. */
  webAuthKey?: string | null;
  /** Relay worker base URL (设置 → 远程访问 → 外网访问); null = unset. */
  webRelayUrl?: string | null;
  /** Shared relay key; also the phone URL's path segment. */
  webRelayKey?: string | null;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface FileContent {
  kind: "text" | "image" | "video" | "binary";
  text: string | null;
  /** Inline base64 for images small enough to carry one (chat thumbnails,
   *  remote-reader fallback). Large images and all videos leave it null — the
   *  editor loads those by path through the loopback media server
   *  (`fileUrl`). */
  dataUrl: string | null;
  truncated: boolean;
  /** Served by a remote reader (e.g. WSL distro, features/files/remote-files):
   *  content is complete but writes are unsupported, so the editor stays
   *  read-only — distinct from `truncated`, which means partial content. */
  readOnly?: boolean;
}
/** Result of `duplicate_item` / `paste_item`: the created destination. */
export interface FileOpResult {
  path: string;
  isDir: boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}
/** One entry of the workspace file index (`list_file_index`). */
export interface FileIndexEntry {
  /** Workspace-relative path, "/" separators. */
  rel: string;
  isDir: boolean;
}

/** What a `/` picker entry is. Commands (`.claude/commands/*.md`) and
 *  skills (`.claude/skills/<name>/SKILL.md`) share the picker but stay
 *  distinct: the menu keys icons/badges/section grouping off this field,
 *  and per-kind merging lets a command and a skill share a name. */
export type SlashEntryKind = "command" | "skill" | "builtin";

/** A `/` picker entry (`list_slash_commands`): workspace entries shadow
 *  global ones of the same name and kind. */
export interface SlashCommandEntry {
  /** Slash-less name; commands join directory segments with `:`
   *  ("aimax:plan"), skills use the SKILL.md directory name. */
  name: string;
  description?: string | null;
  argumentHint?: string | null;
  /** "workspace" (project `.claude/`) or "global" (CLI home). */
  source: string;
  kind: SlashEntryKind;
}
/** A user-defined agent persona (`agent_list`): picked in the composer `#`
 *  menu, its prompt appended to the outgoing message. Stored in
 *  `~/.hzkcode/gui/agents.json`. */
export interface AgentConfig {
  id: string;
  name: string;
  prompt?: string;
  icon?: string;
  /** Frontend-only pick origin: built-in catalog picks carry no prompt —
   *  sendPrompt resolves the current catalog prompt at send time. Absent
   *  (older persisted selections) means "custom". */
  source?: "custom" | "builtIn";
  createdAt?: number;
}
/** Provider block of the built-in agent catalog (`list_built_in_agents`). */
export interface BuiltInAgentProviderView {
  id: string;
  displayName: string;
  sourceUrl: string;
  sourceRevision: string;
  license: string;
}

/** One division (section) of the built-in catalog. `icon` is a lucide
 *  name, `color` a hex swatch used for badges. */
export interface BuiltInAgentDivisionView {
  id: string;
  order: number;
  icon: string;
  color: string;
  label: string;
  count: number;
  enabledCount: number;
}

/** One built-in catalog agent. `icon` is an emoji (null → fallback glyph). */
export interface BuiltInAgentView {
  id: string;
  divisionId: string;
  name: string;
  description: string;
  icon: string | null;
  enabled: boolean;
}

/** The full built-in catalog view (`list_built_in_agents`). */
export interface BuiltInAgentCatalogView {
  provider: BuiltInAgentProviderView;
  divisions: BuiltInAgentDivisionView[];
  agents: BuiltInAgentView[];
}

/** Full prompt of a built-in agent (`get_built_in_agent_prompt`). */
export interface BuiltInAgentPrompt {
  id: string;
  prompt: string;
  promptHash: string;
}

/** Send-time resolution of an enabled built-in agent
 *  (`resolve_enabled_built_in_agent`); fails when the agent is disabled. */
export interface ResolvedBuiltInAgent {
  id: string;
  name: string;
  icon: string | null;
  prompt: string;
  promptHash: string;
}

/** Where a custom prompt file lives: `<root>/.hzkcode/prompts/` or the
 *  app-home `~/.hzkcode/gui/prompts/`. */
export type PromptScope = "workspace" | "global";

/** A custom prompt (`prompts_list`): one markdown file with `---`
 *  frontmatter (`description`, `argument-hint`); `name` is the filename
 *  stem, `path` the absolute file path. */
export interface CustomPromptEntry {
  name: string;
  path: string;
  description?: string;
  argumentHint?: string;
  content: string;
  scope: PromptScope;
}

/** Prompt directories for a workspace root (`prompts_dirs`). */
export interface PromptDirs {
  workspace: string;
  global: string;
}

export interface GitFileEntry {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
}

export interface GitStatus {
  branch: string;
  /** Commits ahead of / behind the upstream; absent when there is none. */
  ahead?: number;
  behind?: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
}

/** Compact status for a directory that is itself a Git worktree root. */
export interface RepositorySummary {
  path: string;
  branch: string;
  changed: number;
  untracked: number;
}

/** Per-entry git state for one loaded tree level. `repository` marks an
 *  exact repo-root directory (blue name); plain folders never carry color. */
export type FileTreeColor = "modified" | "untracked" | "repository";

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
}
export interface AppMetrics {
  /** Resident memory of the app process, bytes. */
  memoryBytes: number;
  /** CPU usage since the previous poll, percent of one core. */
  cpuPercent: number;
}
/** The outbound relay: the phone reaches the app through a Worker. */
export interface RelayInfo {
  /** Address to open on the phone (key already in the path). */
  url: string;
  agentUrl: string;
  connected: boolean;
  error: string | null;
}

/** Outcome of a one-click relay deploy (mirrors Rust `RelayDeployResult`). */
export interface RelayDeployResult {
  /** `https://hzkcode-relay.<subdomain>.workers.dev` — a suggestion, not a lock:
   *  the URL field stays editable so a custom domain can replace it. */
  url: string;
  /** The relay key that was uploaded with the Worker. */
  key: string;
  accountId: string;
  accountName: string;
}

/** A browser that reached the LAN bridge; approved devices may use it. */
export interface WebDevice {
  id: string;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
  approvedAt: number | null;
  /** Name the user gave it; empty falls back to the user-agent summary. */
  name: string | null;
}

export interface WebAccessInfo {
  /** Full URL including the auth token — shareable as-is or as a QR code. */
  url: string;
  port: number;
  token: string;
  lanIp: string;
}

/** One finished turn as it enters the usage ledger. */
export interface UsageEntryInput {
  /** Epoch ms when the turn settled. */
  ts: number;
  engine: string;
  model: string | null;
  sessionId: string | null;
  workspacePath: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  durationMs: number | null;
  /** Model responses this turn reported (>= 1). */
  reports: number;
}

/** Ledger totals for one (local day, engine, model) bucket. */
export interface UsageRow {
  /** Local "YYYY-MM-DD". */
  day: string;
  engine: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Model responses in this bucket — the request total. */
  requests: number;
}
// ---- Managed CLI version probe ----

/** Managed-CLI local version + npm registry latest (`cli_version_status`). */
export interface CliVersionStatus {
  engine: string;
  installed: boolean;
  localVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** How install/update acts: "npm" | "native"; null = no action. */
  updateKind: "npm" | "native" | null;
  /** "bundled" = the app carries this CLI and updates it with the app. */
  source: "bundled" | "system";
}
/** Confirm-dialog execution plan for a one-click install/update. */
export interface CliUpdatePlan {
  engine: string;
  action: "install" | "update";
  /** "npm" | "native" | "none". */
  kind: string;
  /** Exact argv that will execute. */
  command: string[];
  /** Copy-paste fallback for a manual run. */
  manualCommand: string;
  canRun: boolean;
  blockers: string[];
  platform: string;
}

// ==================== Typed invoke wrappers ====================
// Shared in-flight/cached app-settings promise: startup, the settings page
// and the chat store all read the same settings, so fetch once.
let settingsPromise: Promise<AppSettings> | null = null;

function fetchAppSettings(): Promise<AppSettings> {
  return (settingsPromise ??= invoke<AppSettings>("get_app_settings").catch((e) => {
    // Allow retry after a failed fetch instead of caching the rejection.
    settingsPromise = null;
    throw e;
  }));
}

// ==================== Plugins (Phase 1 runtime, plan §4.3) ====================

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  tier: "declarative" | "js";
  source: "marketplace" | "local" | "ai" | "builtin";
  enabled: boolean;
  quarantined: boolean;
  lastError: string | null;
  permissions: string[];
  installedAt: number;
  minAppVersion: string | null;
}
/** Marketplace listing row (plan §6.1): community-plugins.json merged with
 *  plugins/<id>.json — the fields the market UI renders. */
export interface MarketPlugin {
  id: string;
  repo: string;
  name: string;
  description: string;
  author: string;
  tier: "declarative" | "js";
  version: string;
  minAppVersion: string | null;
  sdkVersion: string | null;
  permissions: string[];
  /** Lifetime download count from the index stats bot; null when the
   *  stats file is unavailable — decorative, never gates anything. */
  downloads: number | null;
}

/** One installed marketplace plugin with a newer indexed version. */
export interface PluginUpdate {
  id: string;
  currentVersion: string;
  latestVersion: string;
}

export interface OfficialConfigFile {
  /** Absolute path — the pane label, and the write-back key. */
  path: string;
  /** Editor language mode: "json" | "toml". */
  format: string;
  /** Live file content; "" when absent (`exists` distinguishes). */
  content: string;
  exists: boolean;
}

export interface OfficialConfigDraft {
  path: string;
  content: string;
}

export const ipc = {
  // config
  getCliConfig: () => invoke<CliConfig>("get_cli_config"),
  upsertProvider: (engine: string, id: string, json: unknown) =>
    invoke<void>("upsert_provider", { engine, id, json }),
  deleteProvider: (engine: string, id: string) =>
    invoke<void>("delete_provider", { engine, id }),
  setCurrentProvider: (engine: string, id: string) =>
    invoke<void>("set_current_provider", { engine, id }),
  /** Native config files of this engine (官方配置 editor). Empty for
   *  engines whose official state lives in auth stores. */
  providerFilePaths: (engine: string) =>
    invoke<string[]>("provider_file_paths", { engine }),
  /** Editable files of the engine's 官方配置 (pane order); empty for
   *  pi/omp/dsh, whose official state lives in auth stores. */
  officialConfigRead: (engine: string) =>
    invoke<OfficialConfigFile[]>("official_config_read", { engine }),
  /** Gated backend-side on 官方配置 being the active configuration. */
  officialConfigWrite: (engine: string, files: OfficialConfigDraft[]) =>
    invoke<void>("official_config_write", { engine, files }),
  reorderProviders: (engine: string, ids: string[]) =>
    invoke<void>("reorder_providers", { engine, ids }),
  /** 拉取模型: probe the channel's /v1/models endpoint for its model list. */
  fetchProviderModels: (baseUrl: string, apiKey: string) =>
    invoke<ProviderModelList>("fetch_provider_models", { baseUrl, apiKey }),
  // settings
  getAppSettings: fetchAppSettings,
  /** De-cached read: settings the backend changed on its own (the pairing key
   *  rotates after a pairing and on a timer) never pass through a write here,
   *  so the cached copy would keep showing the retired code. */
  refreshAppSettings: () => {
    settingsPromise = null;
    return fetchAppSettings();
  },
  updateAppSettings: async (settings: AppSettings) => {
    await invoke<void>("update_app_settings", { settings });
    // Drop the cache instead of caching `settings`: the backend adjusts what
    // it stores (it mints the pairing key, drops rejected bin paths), and a
    // write must never seed the shared copy with something the backend did
    // not answer — one bad value here blanks every settings page.
    settingsPromise = null;
  },
  setWindowTheme: (dark: boolean) =>
    invoke<void>("set_window_theme", { dark }),
  /** 立即重启应用（标题栏样式等需重启生效的设置项用）。 */
  restartApp: () => invoke<void>("restart_app"),
  // windows
  /** Open a conversation in its own app window (multi-window). */
  openChatWindow: (engine: string, sessionId: string, workspacePath: string) =>
    invoke<void>("open_chat_window", { engine, sessionId, workspacePath }),
  /** Open a file in a standalone editor window, optionally placing it at the
   *  logical screen point the tab was dropped at. */
  openEditorWindow: (filePath: string, position: { x: number; y: number } | null) =>
    invoke<void>("open_editor_window", {
      filePath,
      position: position ? [position.x, position.y] : null,
    }),
  /** Drag ghost window: a native card following the cursor while an editor
   *  tab is dragged outside the main window. */
  showDragGhost: (args: {
    label: string;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
  }) => invoke<void>("show_drag_ghost", args),
  hideDragGhost: () => invoke<void>("hide_drag_ghost"),
  // engine
  sendMessage: (args: {
    /** Route events before the send invocation resolves (older callers may omit). */
    runId?: string;
    engine: string;
    workspacePath: string;
    sessionId: string | null;
    prompt: string;
    imagePaths: string[] | null;
    model: string | null;
    effort: string | null;
    permission: string | null;
    providerId: string | null;
    agentName: string | null;
    agentsJson: string | null;
    /** Per-session proxy switch (the composer's 会话开关): true pins
     *  HZKCODE_PROXY_ENABLED=1 (use the configured address), false forces a
     *  direct connection, null keeps the app/shell default. */
    proxyEnabled?: boolean | null;
    /** Per-session second-brain switch (the CLI's /second-brain): pins
     *  HZKCODE_ENABLE_SECOND_BRAIN; null keeps the default. */
    secondBrainEnabled?: boolean | null;
  }) => invoke<SendResult>("send_message", args),
  interruptSession: (sessionId: string) =>
    invoke<boolean>("interrupt_session", { sessionId }),
  listEngines: () => invoke<EngineInfo[]>("list_engines"),
  /** Persist a clipboard image to app home; returns its absolute path so it
   * can flow through the same path-based image pipeline as picked files. */
  savePastedImage: (dataBase64: string, extension: string) =>
    invoke<string>("save_pasted_image", { dataBase64, extension }),
  /** Copy explicitly user-picked files into the app sandbox and return the
   * new paths (same order). Picked paths live outside the sandbox, so the
   * engines' path-based image pipeline cannot read them in place. */
  importAttachments: (paths: string[]) => invoke<string[]>("import_attachments", { paths }),
  listEngineModels: (engine: string, workspace?: string) =>
    withGrantRetry(() =>
      invoke<EngineCatalog>("list_engine_models", { engine, workspace: workspace ?? null }),
    ),
  // history
  listSessions: () => invoke<SessionMeta[]>("list_sessions"),
  loadSessionPage: (
    engine: string,
    sessionId: string,
    limit?: number,
    beforeSeq?: number | null,
  ) => invoke<SessionPage>("load_session_page", { engine, sessionId, limit, beforeSeq }),
  /** Remote (WSL distro) transcript: host fetches the jsonl over the ssh
   *  channel, caches it locally, and parses with the same engine reader. */
  loadRemoteSessionPage: (
    workspacePath: string,
    engine: string,
    sessionId: string,
    remotePath: string,
    limit?: number,
    beforeSeq?: number | null,
  ) =>
    invoke<SessionPage>("load_remote_session_page", {
      workspacePath,
      engine,
      sessionId,
      remotePath,
      limit,
      beforeSeq,
    }),
  deleteSession: (engine: string, sessionId: string) =>
    invoke<void>("delete_session", { engine, sessionId }),
  /** Fork the conversation at one message (the CLI's /branch): a new session
   *  file next to the source, history up to the target entry, `forkedFrom`
   *  traceability, title inherited as "<原题> (分支[ n])". */
  branchSession: (
    engine: string,
    sessionId: string,
    workspacePath: string,
    targetUuid: string,
  ) =>
    invoke<{ sessionId: string; title: string | null }>("branch_session", {
      engine,
      sessionId,
      workspacePath,
      targetUuid,
    }),
  /** Remote (plugin-fed, e.g. WSL distro) session delete: no local db row
   *  exists, so the host rm's the validated remotePath over the same remote
   *  channel loadRemoteSessionPage reads through. */
  deleteRemoteSession: (workspacePath: string, engine: string, remotePath: string) =>
    invoke<void>("delete_remote_session", { workspacePath, engine, remotePath }),
  pinSession: (engine: string, sessionId: string, pinned: boolean) =>
    invoke<void>("pin_session", { engine, sessionId, pinned }),
  renameSession: (engine: string, sessionId: string, title: string) =>
    invoke<void>("rename_session", { engine, sessionId, title }),
  /** Remember the model id this session ran ("provider/model", as the picker
   * spells it) — the engine's own transcript keeps only the bare name, so
   * this is what survives a restart or another client. */
  rememberSessionModel: (engine: string, sessionId: string, model: string) =>
    invoke<void>("remember_session_model", { engine, sessionId, model }),
  /** Remember the reasoning level a session ran, so reopening it — here, in
   *  another window, or on the phone — keeps that level. */
  rememberSessionEffort: (engine: string, sessionId: string, effort: string) =>
    invoke<void>("remember_session_effort", { engine, sessionId, effort }),
  /** Remember the in-app channel a session ran, so reopening it keeps that
   *  channel without rewriting the CLI's own config file. */
  rememberSessionProvider: (engine: string, sessionId: string, providerId: string) =>
    invoke<void>("remember_session_provider", { engine, sessionId, providerId }),
  rescanSessions: () => invoke<void>("rescan_sessions"),
  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),
  addWorkspace: (path: string, meta?: Record<string, unknown>) =>
    invoke<Workspace>("add_workspace", { path, meta: meta ?? null }),
  /** Plugin-scoped workspace registration: the Rust side re-checks the
   *  plugin's manifest grants (host:workspace; meta.wsl additionally needs
   *  host:workspace:remote) — the server-side counterpart of the JS gate in
   *  plugins/runtime/context.ts. pluginId is injected by the host bridge. */
  pluginAddWorkspace: (pluginId: string, path: string, meta?: Record<string, unknown>) =>
    invoke<Workspace>("plugin_add_workspace", { pluginId, path, meta: meta ?? null }),
  reorderWorkspaces: (ids: string[]) => invoke<void>("reorder_workspaces", { ids }),
  removeWorkspace: (id: string) => invoke<void>("remove_workspace", { id }),
  setWorkspaceGroup: (id: string, groupId: string | null) =>
    invoke<void>("set_workspace_group", { id, groupId }),
  // terminal
  /** Idempotent: re-opening a live session id is a no-op on the backend. */
  terminalOpen: (args: { id: string; cwd: string; cols: number; rows: number }) =>
    invoke<void>("terminal_open", args),
  terminalWrite: (id: string, data: string) =>
    invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { id, cols, rows }),
  /** No-op when the session is already gone. */
  terminalClose: (id: string) => invoke<void>("terminal_close", { id }),
  // files — every command goes through withGrantRetry so an outside-roots
  // rejection becomes a one-click grant prompt + retry (see lib/grant.ts).
  listDir: (path: string) => withGrantRetry(() => invoke<DirEntry[]>("list_dir", { path })),
  readFile: (path: string) => withGrantRetry(() => invoke<FileContent>("read_file", { path })),
  writeFile: (path: string, content: string) =>
    withGrantRetry(() => invoke<void>("write_file", { path, content })),
  createDir: (path: string) => withGrantRetry(() => invoke<void>("create_dir", { path })),
  /** Fails when the file already exists (unlike write_file, which overwrites). */
  createFile: (path: string) => withGrantRetry(() => invoke<void>("create_file", { path })),
  renameItem: (from: string, to: string) =>
    withGrantRetry(() => invoke<void>("rename_item", { from, to })),
  trashItem: (path: string) => withGrantRetry(() => invoke<void>("trash_item", { path })),
  duplicateItem: (path: string) =>
    withGrantRetry(() => invoke<FileOpResult>("duplicate_item", { path })),
  pasteItem: (source: string, targetDir: string) =>
    withGrantRetry(() => invoke<FileOpResult>("paste_item", { source, targetDir })),
  searchText: (path: string, query: string) =>
    withGrantRetry(() => invoke<SearchHit[]>("search_text", { path, query })),
  /** Whole-tree file index for the composer @-mention picker (relative
   * paths; backend caps at 20k entries). */
  listFileIndex: (path: string, includeIgnored = false) =>
    withGrantRetry(() =>
      invoke<FileIndexEntry[]>("list_file_index", { path, includeIgnored }),
    ),
  /** Catalog for the composer `/` picker (workspace `.claude/commands` +
   *  `.claude/skills`, plus the global skill roots of the CLIs the app
   *  drives — Claude home, `$CODEX_HOME/skills` incl. `.system`,
   *  `~/.agents/skills`, Codex plugin cache). Commands and skills are
   *  distinguished by `entry.kind`. */
  listSlashCommands: (path: string) =>
    withGrantRetry(() => invoke<SlashCommandEntry[]>("list_slash_commands", { path })),
  // agents — user personas stored in ~/.hzkcode/gui/agents.json (app home,
  // so no grant flow); picked via the composer `#` menu, managed in
  // settings. agent_update takes a partial; absent fields stay unchanged.
  listAgents: () => invoke<AgentConfig[]>("agent_list"),
  addAgent: (input: { name: string; prompt?: string; icon?: string }) =>
    invoke<AgentConfig>("agent_add", input),
  updateAgent: (id: string, updates: { name?: string; prompt?: string; icon?: string }) =>
    invoke<boolean>("agent_update", { id, ...updates }),
  deleteAgent: (id: string) => invoke<boolean>("agent_delete", { id }),
  // built-in agent catalog — bundled read-only personas (resources/
  // agent-catalogs); enabled ids live in app settings. The composer `#`
  // menu merges enabled ones; sendPrompt resolves the current prompt via
  // resolveEnabledBuiltInAgent at send time.
  listBuiltInAgents: (locale: string) =>
    invoke<BuiltInAgentCatalogView>("list_built_in_agents", { locale }),
  setBuiltInAgentEnabled: (agentId: string, enabled: boolean) =>
    invoke<null>("set_built_in_agent_enabled", { agentId, enabled }),
  setBuiltInAgentDivisionEnabled: (divisionId: string, enabled: boolean) =>
    invoke<null>("set_built_in_agent_division_enabled", { divisionId, enabled }),
  getBuiltInAgentPrompt: (agentId: string) =>
    invoke<BuiltInAgentPrompt>("get_built_in_agent_prompt", { agentId }),
  resolveEnabledBuiltInAgent: (agentId: string) =>
    invoke<ResolvedBuiltInAgent>("resolve_enabled_built_in_agent", { agentId }),
  // custom prompts — markdown + frontmatter files under
  // <root>/.hzkcode/prompts (workspace scope) or ~/.hzkcode/gui/prompts
  // (global scope); picked via the composer `!` menu, managed in settings.
  listPrompts: (path: string) =>
    withGrantRetry(() => invoke<CustomPromptEntry[]>("prompts_list", { path })),
  createPrompt: (
    path: string,
    scope: PromptScope,
    input: { name: string; description?: string; argumentHint?: string; content: string },
  ) =>
    withGrantRetry(() =>
      invoke<CustomPromptEntry>("prompts_create", { path, scope, ...input }),
    ),
  /** Partial update keyed by the entry's current file path. */
  updatePrompt: (
    path: string,
    promptPath: string,
    updates: { name?: string; description?: string; argumentHint?: string; content?: string },
  ) =>
    withGrantRetry(() =>
      invoke<CustomPromptEntry>("prompts_update", { path, promptPath, updates }),
    ),
  deletePrompt: (path: string, promptPath: string) =>
    withGrantRetry(() => invoke<boolean>("prompts_delete", { path, promptPath })),
  /** Move a prompt file between the workspace and global directories. */
  movePrompt: (path: string, promptPath: string, scope: PromptScope) =>
    withGrantRetry(() =>
      invoke<CustomPromptEntry>("prompts_move", { path, promptPath, scope }),
    ),
  /** Absolute prompts directories for a workspace root (settings display). */
  promptsDirs: (path: string) => invoke<PromptDirs>("prompts_dirs", { path }),
  // granted directories (desktop-only commands; the settings list hides on web)
  listGrantedRoots: () => invoke<string[]>("list_granted_roots"),
  /** Directory a grant for `path` would cover (path itself when a dir, else
   * its parent) — the grant card shows this before the user approves. */
  grantScope: (path: string) => invoke<string>("grant_scope", { path }),
  /** Persist a user-approved directory grant; subsequent claude launches
   * receive it as --add-dir. */
  grantRoot: (path: string) => invoke<void>("grant_root", { path }),
  /** Answer a pending AskUserQuestion card (claude control protocol).
   * `answers` maps each question's text to the chosen label(s); null = the
   * user skipped the question. Routed by run id (falls back to session id). */
  answerQuestion: (
    sessionId: string,
    requestId: string,
    answers: Record<string, string | string[]> | null,
  ) => invoke<void>("answer_question", { sessionId, requestId, answers }),
  /** Answer a pending tool-permission ask (claude control protocol):
   * "allow" replays the parked input; "deny" tells the model the user
   * declined. Routed by run id (falls back to session id). */
  answerPermission: (
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
  ) => invoke<void>("answer_permission", { sessionId, requestId, behavior }),
  revokeGrantedRoot: (path: string) => invoke<void>("revoke_granted_root", { path }),
  // git
  gitStatus: (path: string) => invoke<GitStatus>("git_status", { path }),
  gitRepositorySummaries: (paths: string[]) =>
    invoke<RepositorySummary[]>("git_repository_summaries", { paths }),
  gitFileColors: (path: string, files: string[]) =>
    invoke<Record<string, FileTreeColor>>("git_file_colors", { path, files }),
  gitDiff: (path: string, file: string, staged: boolean) =>
    invoke<string>("git_diff", { path, file, staged }),
  gitStage: (path: string, files: string[]) => invoke<void>("git_stage", { path, files }),
  gitUnstage: (path: string, files: string[]) =>
    invoke<void>("git_unstage", { path, files }),
  gitCommit: (path: string, message: string) =>
    invoke<string>("git_commit", { path, message }),
  gitPush: (path: string) => invoke<void>("git_push", { path }),
  gitPull: (path: string) => invoke<void>("git_pull", { path }),
  gitBranches: (path: string) => invoke<BranchInfo[]>("git_branches", { path }),
  gitCheckout: (path: string, branch: string) =>
    invoke<void>("git_checkout", { path, branch }),
  gitCreateBranch: (path: string, name: string) =>
    invoke<void>("git_create_branch", { path, name }),
  // open-app
  openWorkspaceIn: (path: string, options: { appName: string; args?: string[] }) =>
    invoke<void>("open_workspace_in", { path, app: options.appName, args: options.args ?? [] }),
  /** Launch a user-picked custom program with the workspace path as argument. */
  openCustomProgram: (executablePath: string, path: string) =>
    invoke<void>("open_custom_program", { executablePath, path }),
  /** OS icon for a program executable as a PNG data URL (null when none). */
  getProgramIcon: (executablePath: string) =>
    invoke<string | null>("get_program_icon", { executablePath }),
  revealInFileManager: (path: string) =>
    invoke<void>("reveal_in_file_manager", { path }),
  // metrics
  appMetrics: () => invoke<AppMetrics>("app_metrics"),
  // plugins
  pluginList: () => invoke<PluginInfo[]>("plugin_list"),
  pluginInstallFromPath: (path: string) =>
    invoke<PluginInfo>("plugin_install_from_path", { path }),
  pluginUninstall: (id: string, deleteData: boolean) =>
    invoke<void>("plugin_uninstall", { id, deleteData }),
  pluginSetEnabled: (id: string, enabled: boolean) =>
    invoke<PluginInfo>("plugin_set_enabled", { id, enabled }),
  pluginQuarantine: (id: string, error: string) =>
    invoke<PluginInfo>("plugin_quarantine", { id, error }),
  pluginReadFile: (id: string, name: string) =>
    invoke<string>("plugin_read_file", { id, name }),
  pluginStorageGet: (id: string, key: string) =>
    invoke<unknown>("plugin_storage_get", { id, key }),
  pluginStorageSet: (id: string, key: string, value: unknown) =>
    invoke<void>("plugin_storage_set", { id, key, value }),
  pluginStorageDelete: (id: string, key: string) =>
    invoke<void>("plugin_storage_delete", { id, key }),
  // plugin marketplace (Phase 3, plan §6) — install is desktop-only on the
  // web bridge; fetch/checkUpdates ride the read-only whitelist.
  pluginFetchIndex: (force = false) =>
    invoke<MarketPlugin[]>("plugin_fetch_index", { force }),
  pluginInstallFromMarketplace: (id: string) =>
    invoke<PluginInfo>("plugin_install_from_marketplace", { id }),
  pluginCheckUpdates: () => invoke<PluginUpdate[]>("plugin_check_updates"),
  // web access (start/stop are desktop-only; the bridge answers status too)
  webDevices: () => invoke<WebDevice[]>("web_devices"),
  webDeviceApprove: (id: string) => invoke<boolean>("web_device_approve", { id }),
  webDeviceRevoke: (id: string) => invoke<boolean>("web_device_revoke", { id }),
  webDeviceRename: (id: string, name: string) =>
    invoke<boolean>("web_device_rename", { id, name }),
  webRelayStatus: () => invoke<RelayInfo | null>("web_relay_status"),
  webRelayStart: (url: string, key: string) => invoke<RelayInfo>("web_relay_start", { url, key }),
  webRelayStop: () => invoke<void>("web_relay_stop"),
  /** Is a browser driving this machine through the relay right now? */
  remoteControlActive: () => invoke<boolean>("remote_control_active"),
  /** Replace the pairing key now instead of waiting for the automatic
   *  rotation. Desktop-only — a phone rotating it would lock others out. */
  rotateWebPairKey: () => invoke<string>("rotate_web_pair_key"),
  /** Write the deploy pack (source + wrangler project + how-to) to `path` as a
   *  STORE-only zip; resolves with the relay key baked into it. */
  relayDeployPack: (path: string, key: string | null) =>
    invoke<string>("relay_deploy_pack", { path, key }),
  /** Deploy the relay Worker into the token's account: creates the Durable
   *  Object class, its binding and a freshly minted key in one upload.
   *  `accountId` is only needed for account-owned tokens (`cfat_…`), which
   *  Cloudflare does not let list their own accounts. The key is never taken
   *  from the caller — it is the only guard on the agent endpoint. */
  relayDeploy: (token: string, accountId: string | null) =>
    invoke<RelayDeployResult>("relay_deploy", { token, accountId }),
  webAccessStart: () => invoke<WebAccessInfo>("web_access_start"),
  webAccessStop: () => invoke<void>("web_access_stop"),
  webAccessStatus: () => invoke<WebAccessInfo | null>("web_access_status"),
  // usage ledger (settings 用量)
  usageRecord: (entry: UsageEntryInput) => invoke<void>("usage_record", { entry }),
  usageSummary: (days: number, tzOffsetMinutes: number) =>
    invoke<UsageRow[]>("usage_summary", { days, tzOffsetMinutes }),
  usageClear: () => invoke<void>("usage_clear"),
  // managed-CLI lifecycle (CLI 管理 header: version probe + install/update)
  cliVersionStatus: (engine: string) =>
    invoke<CliVersionStatus>("cli_version_status", { engine }),
  cliUpdatePlan: (engine: string) =>
    invoke<CliUpdatePlan>("cli_update_plan", { engine }),
  cliUpdate: (engine: string, runId: string) =>
    invoke<{ ok: boolean; version: string | null }>("cli_update", { engine, runId }),
};
