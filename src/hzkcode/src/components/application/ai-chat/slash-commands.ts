import { ipc, type SlashCommandEntry } from "@/lib/ipc";
import {
  createRootCacheStore,
  type RootCache,
} from "@/components/application/ai-chat/create-root-cache-store";

/**
 * Catalog for the composer's `/` picker, ported from desktop-cc-gui's
 * slash-command completion (claude_commands.rs + ChatInputBoxAdapter) and
 * extended with skills. The Rust side scans the workspace's `.claude/`
 * plus the CLIs' global skill roots (Claude home, `$CODEX_HOME/skills`
 * incl. `.system`, `~/.agents/skills`, Codex plugin cache) for two
 * distinct kinds — commands (markdown under `commands/`) and skills
 * (`skills/<name>/SKILL.md`) — via
 * `entry.kind`; this store caches the catalog per workspace root with the
 * same stale-while-revalidate model as the @-mention file index
 * (createRootCacheStore) — one IPC per TTL window, matching is pure JS per
 * keystroke. The menu also merges in the CLI's announced built-in commands
 * (`kind: "builtin"`, from the session's `slash_commands`), sent verbatim
 * like any typed command.
 */

/** An active `/query` trigger at the caret: `start` is the offset of the
 *  `/` itself, `query` is the text typed after it. */
export interface SlashTrigger {
  start: number;
  query: string;
}

/**
 * Find the `/` command trigger spanning the caret, if any. A trigger is a
 * `/` at the start of a line (desktop-cc-gui parity: mid-line slashes are
 * paths, not commands) whose query contains no whitespace — the first
 * space after the command ends the trigger.
 */
export function findSlashTrigger(text: string, caret: number): SlashTrigger | null {
  if (caret <= 0 || caret > text.length) return null;
  let start = caret - 1;
  while (start >= 0) {
    const ch = text[start];
    if (ch === "/" || /\s/.test(ch)) break;
    start--;
  }
  if (start < 0 || text[start] !== "/") return null;
  // Only line-start slashes open the picker (text start or after a newline).
  if (start > 0 && text[start - 1] !== "\n") return null;
  const query = text.slice(start + 1, caret);
  if (query.length > 64) return null;
  return { start, query };
}

export type RootCommands = RootCache<SlashCommandEntry>;

const COMMANDS_TTL_MS = 60_000;

const { useStore: useSlashCommandStore, prune: pruneSlashCommands } =
  createRootCacheStore<SlashCommandEntry>({
    fetch: (root) => ipc.listSlashCommands(root),
    ttlMs: COMMANDS_TTL_MS,
  });

/** Drop one workspace root's cached catalog when its workspace is removed;
 * the per-root cache would otherwise accumulate every root ever opened. */
export { useSlashCommandStore, pruneSlashCommands };

/** Max rows the picker renders — caps DOM work regardless of match count. */
export const SLASH_MENU_LIMIT = 50;

/**
 * Catalog filter for a trigger query (desktop-cc-gui parity): case-
 * insensitive substring over the command name and its description, keeping
 * the backend's alphabetical order.
 */
export function matchSlashCommands(
  entries: SlashCommandEntry[],
  query: string,
  limit = SLASH_MENU_LIMIT,
): SlashCommandEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, limit);
  const out: SlashCommandEntry[] = [];
  for (const entry of entries) {
    if (
      entry.name.toLowerCase().includes(q) ||
      (entry.description ?? "").toLowerCase().includes(q)
    ) {
      out.push(entry);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Built-in commands of the bundled CLI (3.0.0 snapshot), mirroring its
 *  own /help table: both languages plus the argument hint the terminal
 *  prints in grey after the name. The headless init announces names only,
 *  so descriptions and hints must come from here. */
interface BuiltinCommandInfo {
  en: string;
  zh: string;
  hint?: string;
}

const BUILTIN_COMMANDS: Record<string, BuiltinCommandInfo> = {
  "add-dir": { en: "Add a new working directory", zh: "添加工作目录" },
  agents: { en: "Manage agent configurations", zh: "管理 Agent 配置" },
  assistant: { en: "Open the Kairos assistant panel", zh: "打开 Kairos 助手面板" },
  attach: {
    en: "Attach to a sub HZK Code instance via named pipe",
    zh: "通过命名管道连接到子 HZK Code 实例",
  },
  branch: {
    en: "Create a branch from a selected conversation message",
    zh: "从选中的会话消息创建分支",
  },
  btw: {
    en: "Ask a quick side question without interrupting the main conversation",
    zh: "不打断主对话，快速提一个题外问题",
  },
  buddy: { en: "Hatch a coding companion · pet, off", zh: "孵化编程搭档 · 摸摸、关闭", hint: "[pet|off]" },
  channel: {
    en: "配置和管理当前对话的双向消息渠道",
    zh: "",
    hint: "[providers|list|add|start|status|stop] [provider] [profile|auto] [--level 0|1|2|3]",
  },
  chrome: { en: "Claude in Chrome (Beta) settings", zh: "Claude in Chrome（测试版）设置" },
  "claim-main": {
    en: "Claim main role for this machine (overrides current main machine)",
    zh: "将本机设为主控端（覆盖当前主控端）",
  },
  clear: { en: "Clear conversation history and free up context", zh: "清除会话历史并释放上下文" },
  color: { en: "Set the prompt bar color for this session", zh: "设置本次会话的输入栏颜色", hint: "<color|default>" },
  compact: {
    en: "Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]",
    zh: "清除会话历史，但保留上下文摘要。可选：/compact [摘要说明]",
  },
  config: { en: "Open config panel", zh: "打开配置面板" },
  context: { en: "Visualize current context usage as a colored grid", zh: "以彩色网格显示当前上下文用量" },
  copy: { en: "", zh: "" },
  cost: { en: "Show the total cost and duration of the current session", zh: "显示当前会话的总费用和时长" },
  daemon: {
    en: "Manage background sessions and daemon",
    zh: "管理后台会话和守护进程",
    hint: "[status|start|stop|bg|attach|logs|kill]",
  },
  desktop: { en: "Continue the current session in Claude Desktop", zh: "在 Claude Desktop 中继续当前会话" },
  detach: { en: "Detach from a sub CLI (or all connected subs)", zh: "断开与子 CLI（或全部已连接子实例）的连接" },
  diff: { en: "View uncommitted changes and per-turn diffs", zh: "查看未提交的更改和每轮差异" },
  doctor: { en: "Diagnose and verify your HZK Code installation and settings", zh: "诊断并检查 HZK Code 安装和设置" },
  effort: { en: "Set effort level for model usage", zh: "设置模型的思考强度", hint: "[off|none|low|medium|high|xhigh|max|auto]" },
  exit: { en: "Exit the REPL", zh: "退出交互界面" },
  export: { en: "Copy or save the current conversation as Markdown or plain text", zh: "将当前会话以 Markdown 或纯文本复制或保存" },
  "extra-usage": { en: "Configure extra usage to keep working when limits are hit", zh: "配置额外用量，以便达到限额后继续使用" },
  fast: { en: "", zh: "", hint: "[on|off]" },
  feedback: { en: "Submit feedback about HZK Code", zh: "提交 HZK Code 反馈" },
  files: { en: "List all files currently in context", zh: "列出当前上下文中的所有文件" },
  fork: { en: "Fork the current session into a new sub-agent", zh: "将当前会话分叉为新的子 Agent" },
  goal: { en: "Set or view a persistent goal that can continue automatically", zh: "设置或查看可自动续跑的持久目标" },
  heapdump: { en: "Dump the JS heap to ~/Desktop", zh: "将 JS 堆转存至 ~/Desktop" },
  help: { en: "Show help and available commands", zh: "显示帮助和可用命令" },
  history: { en: "View session history of a connected sub CLI", zh: "查看已连接子 CLI 的会话历史" },
  hooks: { en: "View hook configurations for tool events", zh: "查看工具事件的 Hook 配置" },
  ide: { en: "Manage IDE integrations and show status", zh: "管理 IDE 集成并查看状态", hint: "[open]" },
  "install-github-app": { en: "Set up Claude GitHub Actions for a repository", zh: "为仓库配置 Claude GitHub Actions" },
  "install-slack-app": { en: "Install the Claude Slack app", zh: "安装 Claude Slack 应用" },
  job: { en: "Manage template jobs", zh: "管理模板任务", hint: "[list|new|reply|status]" },
  keybindings: { en: "Open or create your keybindings configuration file", zh: "打开或创建快捷键配置文件" },
  lang: { en: "Set display language (en/zh/auto)", zh: "设置显示语言（en/zh/auto）", hint: "<en|zh|auto>" },
  login: { en: "Switch Anthropic accounts", zh: "切换 Anthropic 账号" },
  logout: { en: "Sign out from your configured account", zh: "退出已配置的账号" },
  mcp: { en: "Manage MCP servers", zh: "管理 MCP 服务器", hint: "[enable|disable [server-name]]" },
  memory: { en: "Edit HZK Code memory files", zh: "编辑 HZK Code 记忆文件" },
  mobile: { en: "Show QR code to download the Claude mobile app", zh: "显示用于下载 Claude 移动应用的二维码" },
  mode: { en: "Switch AI interaction mode", zh: "切换 AI 交互模式" },
  model: { en: "", zh: "" },
  "output-style": { en: "Deprecated: use /config to change output style", zh: "已弃用：请使用 /config 更改输出样式" },
  passes: { en: "Share a free week of HZK Code with friends and earn extra usage", zh: "邀请朋友共享一周免费 HZK Code 并获得额外用量" },
  peers: { en: "List connected HZK Code peers", zh: "列出已连接的 HZK Code 对等实例" },
  permissions: { en: "Manage allow & deny tool permission rules", zh: "管理工具权限的允许和拒绝规则" },
  "pipe-status": { en: "Show current pipe connection status", zh: "显示当前管道连接状态" },
  pipes: { en: "Inspect pipe registry state and toggle the pipe selector", zh: "查看管道注册状态并切换管道选择器" },
  plan: { en: "Enable plan mode or view the current session plan", zh: "开启规划模式或查看当前会话规划" },
  poor: { en: "Toggle poor mode — disable extract_memories and prompt_suggestion to save tokens", zh: "切换省钱模式 — 禁用 extract_memories 和 prompt_suggestion 以节省 token" },
  "pr-comments": { en: "Get comments from a GitHub pull request", zh: "获取 GitHub 拉取请求的评论" },
  "privacy-settings": { en: "View and update your privacy settings", zh: "查看和更新隐私设置" },
  proxy: { en: "View or change the HTTP proxy for the current session", zh: "查看或更改当前会话的 HTTP 代理", hint: "[on | <url> | off | restore]" },
  "proxy-daemon": { en: "View or set the HTTP proxy for the background memory agent", zh: "查看或设置后台记忆整理程序使用的 HTTP 代理", hint: "[on | off | status]" },
  "rate-limit-options": { en: "Show options when rate limit is reached", zh: "达到频率限额时显示可选方案" },
  "release-notes": { en: "View release notes", zh: "查看发行说明" },
  "reload-plugins": { en: "Activate pending plugin changes in the current session", zh: "在当前会话中启用待生效的插件更改" },
  "remote-control": { en: "Connect this terminal for remote-control sessions", zh: "连接此终端，用于远程控制会话" },
  "remote-control-server": { en: "Start a persistent Remote Control server (daemon) that accepts multiple sessions", zh: "启动可接收多个会话的持久远程控制服务器（守护进程）" },
  "remote-env": { en: "Configure the default remote environment for teleport sessions", zh: "配置远程会话的默认环境" },
  rename: { en: "Rename the current conversation", zh: "重命名当前会话" },
  resume: { en: "Resume a previous conversation", zh: "恢复之前的会话" },
  rewind: { en: "Restore the code and/or conversation to a previous point", zh: "将代码和/或会话恢复到之前的节点" },
  sandbox: { en: "sandbox disabled", zh: "沙盒已关闭" },
  "second-brain": { en: "Show or control the second brain (parallel observer) for the current session", zh: "查看或控制第二大脑（并行观察者）的当前状态", hint: "[on|off|status]" },
  send: { en: "Send a message to a connected sub CLI", zh: "向已连接的子 CLI 发送消息" },
  session: { en: "Show remote session URL and QR code", zh: "显示远程会话 URL 和二维码" },
  "skill-learning": { en: "Manage skill learning (observe, analyze, evolve)", zh: "管理技能学习（观察、分析、演进）", hint: "[start|stop|about|status|ingest|evolve|export|import|prune|promote|projects]" },
  "skill-search": { en: "Control automatic skill matching during conversations", zh: "控制对话中的自动技能匹配", hint: "[start|stop|about|status]" },
  skills: { en: "List available skills", zh: "列出可用技能" },
  stats: { en: "Show your HZK Code usage statistics and activity", zh: "显示你的 HZK Code 用量统计和活动" },
  status: { en: "Show HZK Code status including version, model, account, API connectivity, and tool statuses", zh: "显示 HZK Code 状态，包括版本、模型、账号、API 连接和工具状态" },
  stickers: { en: "Order HZK Code stickers", zh: "订购 HZK Code 贴纸" },
  summary: { en: "", zh: "" },
  tag: { en: "Toggle a searchable tag on the current session", zh: "切换当前会话的可搜索标签" },
  tasks: { en: "List and manage background tasks", zh: "列出并管理后台任务" },
  "terminal-setup": { en: "Enable Option+Enter key binding for newlines and visual bell", zh: "启用 Option+Enter 换行快捷键和视觉提醒" },
  theme: { en: "Change the theme", zh: "更改主题" },
  "think-back": { en: "Your 2025 HZK Code Year in Review", zh: "你的 2025 HZK Code 年度回顾" },
  "thinkback-play": { en: "Play the thinkback animation", zh: "播放年度回顾动画" },
  upgrade: { en: "Upgrade to Max for higher rate limits and more Opus", zh: "升级到 Max，享受更高的频率限额和更多 Opus" },
  usage: { en: "Show plan usage limits", zh: "显示套餐用量限额" },
  vim: { en: "Toggle between Vim and Normal editing modes", zh: "在 Vim 和普通编辑模式之间切换" },
  voice: { en: "Toggle voice mode. Use /voice doubao for the Doubao ASR backend", zh: "开关语音模式。使用 /voice doubao 启用豆包 ASR 后端" },
  "web-setup": { en: "Setup HZK Code on the web (requires connecting your GitHub account)", zh: "在网页端设置 HZK Code（需连接 GitHub 账号）" },
  "web-tools": { en: "Configure web search and web fetch backends", zh: "配置网页搜索和内容获取服务" },
  workflows: { en: "No workflows found. Add workflow files to .claude/workflows/ (YAML or Markdown).", zh: "未找到工作流。请将工作流文件添加到 .claude/workflows/（YAML 或 Markdown）。" },
};

/** The single-file built-ins (`src/commands/*.ts`). Descriptions of commands
 *  whose source getter reports live state were written by hand. */
const BUILTIN_FILE_COMMANDS: Record<string, BuiltinCommandInfo> = {
  advisor: { en: "Enable or view the advisor model", zh: "启用或查看顾问模型" },
  autonomy: {
    en: "Inspect automatic autonomy runs recorded for proactive ticks and scheduled tasks",
    zh: "查看主动提示和定时任务记录的自动运行",
    hint: "[status [--deep]|runs [limit]|flows [limit]|flow <id>|flow cancel <id>|flow resume <id>]",
  },
  "bridge-kick": { en: "Reconnect the Remote Control bridge", zh: "重连远程控制桥接" },
  brief: { en: "Toggle brief-only mode", zh: "切换仅简报模式" },
  commit: { en: "Create a git commit", zh: "创建 Git 提交" },
  "commit-push-pr": { en: "Commit, push, and open a PR", zh: "提交、推送并创建 PR" },
  coordinator: { en: "Toggle coordinator (multi-worker) mode", zh: "切换协调器（多工作 Agent）模式" },
  feishunote: { en: "Toggle Feishu notifications for the current session", zh: "开关当前会话的飞书通知", hint: "[on|off|status|test]" },
  "force-snip": { en: "Trim the conversation context", zh: "裁剪当前会话上下文" },
  init: { en: "Initialize new CLAUDE.md file(s) and optional skills/hooks with codebase documentation", zh: "根据代码库文档初始化 CLAUDE.md，并按需创建 Skill 或 Hook" },
  "init-verifiers": { en: "Create verifier skill(s) for automated verification of code changes", zh: "创建用于自动验证代码改动的验证 Skill" },
  maxtokens: { en: "Show or set the session context window (auto-compact limit)", zh: "查看或设置当前会话的上下文窗口（自动压缩上限）", hint: "[tokens|reset]" },
  monitor: { en: "Start a background shell monitor (Shift+Down to view)", zh: "启动后台 Shell 监视器（按 Shift+↓ 查看）" },
  proactive: { en: "Toggle proactive (autonomous) mode", zh: "切换主动（自主）模式" },
  project_areas: { en: "Inspect project area data", zh: "查看项目区域数据" },
  provider: { en: "View or switch the active API provider", zh: "查看或切换当前 API 提供方", hint: "[anthropic|openai|gemini|grok|bedrock|vertex|foundry|unset]" },
  review: { en: "Review a pull request", zh: "审查 Pull Request" },
  "security-review": { en: "Complete a security review of the pending changes on the current branch", zh: "审查当前分支待处理改动中的安全问题" },
  "subscribe-pr": { en: "Subscribe to a GitHub pull request", zh: "订阅 GitHub Pull Request" },
  torch: { en: "Internal debug command (unavailable in this build)", zh: "内部调试命令（当前版本不可用）" },
  version: { en: "Print the version this session is running (not what autoupdate downloaded)", zh: "显示当前会话运行的版本（不是自动更新下载的版本）" },
};

/**
 * Built-in entries for one session, built from the CLI's announced command
 * names (deduped, sorted for a stable menu; unknown names render without a
 * description). Descriptions and argument hints come from the mirrored
 * 3.0.0 table in the menu's language. Selecting one rewrites the trigger to
 * `/name ` verbatim — the CLI expands `/name args` itself when sent.
 */
export function builtinSlashCommands(
  language: string,
  names: readonly string[],
): SlashCommandEntry[] {
  const zh = language.toLowerCase().startsWith("zh");
  const seen = new Set<string>();
  return names
    .map((name) => name.trim())
    .filter((name) => {
      const key = name.toLowerCase();
      if (name === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const key = name.toLowerCase();
      const info = BUILTIN_COMMANDS[key] ?? BUILTIN_FILE_COMMANDS[key];
      const description = info
        ? (zh ? info.zh || info.en : info.en || info.zh) || null
        : null;
      return {
        name,
        description,
        argumentHint: info?.hint ?? null,
        source: "builtin",
        kind: "builtin" as const,
      };
    });
}

/**
 * Built-ins first, catalog after; a catalog entry with the same name wins
 * (workspace/global custom commands shadow the built-in of that name, the
 * same way they already shadow each other).
 */
export function mergeSlashCommands(
  builtins: SlashCommandEntry[],
  catalog: SlashCommandEntry[],
): SlashCommandEntry[] {
  const taken = new Set(catalog.map((entry) => entry.name.toLowerCase()));
  return [
    ...builtins.filter((entry) => !taken.has(entry.name.toLowerCase())),
    ...catalog,
  ];
}
