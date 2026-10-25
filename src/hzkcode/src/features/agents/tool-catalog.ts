/**
 * 身份编辑器工具白名单选择器的内置工具目录。
 *
 * 名称必须与内置 CLI 的工具名完全一致：引擎会静默忽略未知名称，而在白名单
 *（`--tools`）下，未列出的内置工具都会被自动拒绝——拼错一个名字就会静默
 * 去掉错误的工具。已对照 hzk-code-agent 3.5.0 的 `getAllBaseTools()`
 *（src/tools.ts）与 `packages/builtin-tools/src/tools/*` 下的 NAME 常量，
 * 仅保留内置构建实际能暴露的工具。3.1.3 之后新增的是 TeamSpawn、BuiltinDocs
 * 与 RespondToAgentRequest；AskParentQuestion 不进入主会话白名单，因为引擎
 * 将它固定分配给子代理与团队成员。标签是本地化数据（智能体目录使用相同的
 * 按语言组织方式），不是 i18n key——这份列表是内容，不是界面装饰。
 */

export interface ToolCatalogEntry {
  /** Engine tool name, exactly as the CLI spells it. */
  name: string;
  label: { zh: string; en: string };
}

export interface ToolCatalogGroup {
  id: string;
  title: { zh: string; en: string };
  entries: readonly ToolCatalogEntry[];
}

export const TOOL_CATALOG: readonly ToolCatalogGroup[] = [
  {
    id: "files",
    title: { zh: "文件与命令", en: "Files & shell" },
    entries: [
      { name: "Bash", label: { zh: "执行命令", en: "Run shell commands" } },
      {
        name: "TerminalSession",
        label: { zh: "交互式终端会话", en: "Interactive terminal sessions" },
      },
      { name: "Read", label: { zh: "读取文件", en: "Read files" } },
      { name: "Edit", label: { zh: "修改文件", en: "Edit files" } },
      { name: "Write", label: { zh: "写入文件", en: "Write files" } },
      {
        name: "Directory",
        label: { zh: "查看与管理目录", en: "Inspect and manage directories" },
      },
      { name: "Glob", label: { zh: "按名称查找文件", en: "Find files by name" } },
      { name: "Grep", label: { zh: "搜索文件内容", en: "Search file contents" } },
      { name: "NotebookEdit", label: { zh: "编辑 Notebook", en: "Edit notebooks" } },
    ],
  },
  {
    id: "network",
    title: { zh: "网络", en: "Network" },
    entries: [
      { name: "WebFetch", label: { zh: "抓取网页", en: "Fetch web pages" } },
      { name: "WebSearch", label: { zh: "联网搜索", en: "Web search" } },
      {
        name: "VaultHttpFetch",
        label: { zh: "带凭据的 HTTP 请求", en: "Authenticated HTTP requests" },
      },
    ],
  },
  {
    id: "media",
    title: { zh: "多模态", en: "Media" },
    entries: [
      { name: "ReadImage", label: { zh: "查看图片", en: "View images" } },
      { name: "ReadVideo", label: { zh: "查看视频", en: "View videos" } },
      { name: "ReadAudio", label: { zh: "收听音频", en: "Listen to audio" } },
      { name: "UploadFile", label: { zh: "上传附件", en: "Upload attachments" } },
    ],
  },
  {
    id: "tasks",
    title: { zh: "任务与协作", en: "Tasks & collaboration" },
    entries: [
      { name: "Agent", label: { zh: "启动子代理", en: "Launch subagents" } },
      { name: "TaskOutput", label: { zh: "读取后台任务输出", en: "Read background task output" } },
      {
        name: "BackgroundTaskList",
        label: { zh: "列出后台任务", en: "List background tasks" },
      },
      { name: "TodoWrite", label: { zh: "维护待办清单", en: "Maintain the todo list" } },
      { name: "TaskCreate", label: { zh: "创建任务", en: "Create tasks" } },
      { name: "TaskGet", label: { zh: "查看任务", en: "Read tasks" } },
      { name: "TaskUpdate", label: { zh: "更新任务", en: "Update tasks" } },
      { name: "TaskList", label: { zh: "列出任务", en: "List tasks" } },
      { name: "TaskStop", label: { zh: "停止后台任务", en: "Stop background tasks" } },
      { name: "AskUserQuestion", label: { zh: "向用户提问", en: "Ask the user" } },
      { name: "ExitPlanMode", label: { zh: "退出计划模式", en: "Exit plan mode" } },
      { name: "EnterPlanMode", label: { zh: "进入计划模式", en: "Enter plan mode" } },
      {
        name: "SendMessage",
        label: { zh: "跨会话消息", en: "Cross-session messages" },
      },
      {
        name: "RespondToAgentRequest",
        label: { zh: "处理子代理请求", en: "Handle subagent requests" },
      },
      { name: "ListPeers", label: { zh: "列出本机会话", en: "List local sessions" } },
      { name: "SessionGroups", label: { zh: "会话群组", en: "Session groups" } },
      { name: "TeamCreate", label: { zh: "创建协作团队", en: "Create a team" } },
      { name: "TeamSpawn", label: { zh: "创建团队成员", en: "Create a team member" } },
      { name: "TeamDelete", label: { zh: "解散协作团队", en: "Delete a team" } },
      {
        name: "VerifyPlanExecution",
        label: { zh: "校验计划执行", en: "Verify plan execution" },
      },
      { name: "workflow", label: { zh: "工作流", en: "Workflows" } },
    ],
  },
  {
    id: "other",
    title: { zh: "其他", en: "Other" },
    entries: [
      { name: "Skill", label: { zh: "调用技能", en: "Invoke skills" } },
      { name: "BuiltinDocs", label: { zh: "查询内置资料", en: "Read built-in docs" } },
      { name: "SessionTitle", label: { zh: "维护会话标题", en: "Maintain the session title" } },
      { name: "NotifyUser", label: { zh: "发送通知", en: "Send notifications" } },
      {
        name: "SendUserMessage",
        label: { zh: "发送消息给用户", en: "Send messages to the user" },
      },
      { name: "MemorySearch", label: { zh: "查询个人记忆", en: "Search personal memory" } },
      {
        name: "LocalMemoryRecall",
        label: { zh: "回读本地记忆", en: "Recall local memory" },
      },
      { name: "Sleep", label: { zh: "等待", en: "Wait" } },
      { name: "Monitor", label: { zh: "监视进程输出", en: "Monitor process output" } },
      { name: "ToolSearch", label: { zh: "检索工具", en: "Search tools" } },
      { name: "ExecuteExtraTool", label: { zh: "执行动态工具", en: "Run dynamically loaded tools" } },
      { name: "PushNotification", label: { zh: "推送通知", en: "Push notifications" } },
      { name: "SendUserFile", label: { zh: "发送文件给用户", en: "Send files to the user" } },
      { name: "EnterWorktree", label: { zh: "进入 worktree", en: "Enter a worktree" } },
      { name: "ExitWorktree", label: { zh: "退出 worktree", en: "Exit a worktree" } },
      { name: "CronCreate", label: { zh: "创建定时任务", en: "Create scheduled tasks" } },
      { name: "CronDelete", label: { zh: "删除定时任务", en: "Delete scheduled tasks" } },
      { name: "CronList", label: { zh: "列出定时任务", en: "List scheduled tasks" } },
      { name: "GoalTool", label: { zh: "目标管理", en: "Goal tracking" } },
      {
        name: "ListMcpResourcesTool",
        label: { zh: "列出 MCP 资源", en: "List MCP resources" },
      },
      {
        name: "ReadMcpResourceTool",
        label: { zh: "读取 MCP 资源", en: "Read MCP resources" },
      },
    ],
  },
];

/** Every catalog tool name (flattened, display order). */
export const TOOL_CATALOG_NAMES: readonly string[] = TOOL_CATALOG.flatMap(
  (group) => group.entries.map((entry) => entry.name),
);
