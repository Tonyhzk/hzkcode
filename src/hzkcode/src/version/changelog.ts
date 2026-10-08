/**
 * Release notes shown in Settings → About → 版本记录 (ChangelogDialog).
 * Newest first; add an entry at release time. Content is bilingual — the
 * dialog shows both when available, ordered by the active UI language.
 */

/** Repo the dialog's Star banner links to; shared with Settings → About. */
export const GITHUB_REPO_URL = "https://github.com/Tonyhzk/hzkcode";

export interface ChangelogEntry {
  version: string;
  date: string;
  content: {
    en: string;
    zh: string;
  };
}

export const CHANGELOG_DATA: ChangelogEntry[] = [
  {
    version: "3.1.3-1",
    date: "2026-10-08",
    content: {
      zh: `🔄 引擎更新
- 内置引擎升级到 3.1.3（随应用一起更新，无需单独安装）

✨ 新功能
- **编辑已发送的消息**：把鼠标移到你发过的某条提问上，点铅笔图标即可修改文本；修改直接保存到对话记录、不会重新生成回复，压缩之前的老消息也可以编辑

🔧 行为说明
- 渠道配置的「1M 上下文」开关升级为「上下文窗口」数值字段：原来开启过 1M 的渠道，打开编辑时会自动填入 1000000，长上下文能力不受升级影响`,
      en: `🔄 Engine update
- Bundled engine upgraded to 3.1.3 (updates ship with the app)

✨ Features
- **Edit sent messages**: hover one of your prompts and click the pencil icon to revise its text; the edit is saved into the transcript in place (no reply is regenerated), and pre-compaction messages can be edited too

🔧 Behavior note
- The channel "1M context" switch is now a "Context window" numeric field: channels that had 1M enabled get 1000000 filled in when opened for editing, so long-context setups carry over`,
    },
  },
  {
    version: "3.1.0-1",
    date: "2026-10-05",
    content: {
      zh: `🔄 引擎更新
- 内置引擎升级到 3.1.0（随应用一起更新，无需单独安装）

✨ 新功能
- 压缩过的长会话显示完整历史：升级后的引擎把压缩前的内容归档为独立分段，界面会自动拼接，之前聊过的内容仍然能翻到
- 身份编辑器升级：智能体可以配置「可用工具」（勾选列表，只有勾选的可被使用）、「模型」（跟随会话或指定档位）、「思考档」与「上下文注入」（内置规范 / CLAUDE.md 与 Rules / 个人记忆分别开关）；给已有对话更换身份时会自动克隆一条新对话继续，原对话保持不变、可随时回去

🔧 行为说明
- 本机跨会话通信随引擎启用：同一台电脑上的其他会话（终端或其他窗口）可以在当前对话运行期间发来消息、触发一轮执行；消息会记录进会话，执行仍受当前权限模式约束`,
      en: `🔄 Engine update
- Bundled engine upgraded to 3.1.0 (updates ship with the app)

✨ Features
- Compacted long sessions show their full history: the upgraded engine archives pre-compaction content as separate segments, and the UI stitches them back together so earlier exchanges remain browsable
- **Identity editor upgrade**: an agent can now pin allowed tools (a checklist — only the checked tools may be used), a model (follow the session or a specific tier), reasoning effort, and context injection (built-in guidelines / CLAUDE.md & Rules / personal memory toggled individually); switching the identity on a conversation that already has messages clones it into a new one — the original stays untouched and can be revisited anytime

🔧 Behavior note
- Cross-session messaging is on with the engine: other sessions on this machine (terminal or other windows) can send a message into a running conversation and trigger a turn; messages are recorded in the session and executions still follow the session's permission mode`,
    },
  },
  {
    version: "3.0.0-2",
    date: "2026-10-04",
    content: {
      zh: `✨ 新功能
- **权限模式全档位**：权限菜单补齐引擎的八个档位（默认 / 自动接受编辑 / 计划模式 / 只读 / 只读询问 / 自动询问 / 自动继续 / 全部跳过，与 Shift+Tab 循环顺序一致）；工具需要授权时，对话里会弹出「允许一次 / 拒绝」卡片，直接作答即可
- **输入框指令菜单升级**：输入 / 即可看到引擎的全部内置指令（/proxy、/effort、/mcp 等带参数的指令附用法提示），选中后补上参数发送；/cost、/context、/compact 等命令的输出会显示在对话里
- **消息重试与分支**：最下面一条消息旁新增「重试」与「分支」——重试即重新回答上一条提问，分支即从该消息创建一个分支会话（等价引擎的 // 与 /branch 指令）
- **会话开关**：输入框下方新增「会话开关」菜单，可以按会话单独控制「会话代理」与「第二大脑」，不再只能跟随全局默认；代理地址未配置或无效时给出前往设置的入口
- **设置页重新分组**：设置导航按「模型与能力 / 应用 / 数据与连接 / 其他」分组；功能开关独立成页，并扩充了会话代理、多模态读取（看图 / 看视频 / 听音频的模型与接口）、行为与工作流等开关
- **自定义模型随渠道保存**：渠道编辑里可直接维护自定义模型列表（逗号分隔批量添加、可逐个移除），对话里的模型选择器按当前渠道显示；模型配置页随之更简洁（外部程序路径与配置文件编辑入口已移除）
- **智能体提示词生效**：选择某个智能体后，会话以其系统提示词作为主线程运行（与引擎 --agent 一致）
- **后台任务通知**：后台任务完成时，状态与摘要会显示在对话时间线上

🐛 修复
- 修复新会话偶尔保存到错误目录、导致左侧列表找不到也删不掉的问题
- 未映射档位的渠道，模型选择器不再显示 opus / sonnet / haiku 别名，改为 High / Mid / Low 档位名
- 错误提示横幅的文字现在可以选中复制
- 界面用词统一：不再出现「CLI」字样，统一为「程序 / 引擎」表述`,
      en: `✨ Features
- **All permission modes**: the permission menu carries the engine's full set — default / accept edits / plan / read-only / read-only ask / auto ask / auto continue / bypass (the Shift+Tab cycle); pending tool authorizations surface as Allow once / Deny cards right in the conversation
- **Upgraded slash menu**: type / to browse every built-in command (with usage hints for /proxy, /effort, /mcp and the like), pick one and add arguments; outputs of /cost, /context, /compact now render in the conversation
- **Message retry & branch**: the last message row gains Retry (answer the previous question again) and Branch (fork the conversation from that message) — the equivalents of the // and /branch commands
- **Session switches**: a menu under the composer toggles the session proxy and the second brain per session instead of always following the global default; an entry to settings appears when the proxy address is missing or invalid
- **Regrouped settings**: the settings nav is organized into Models & capabilities / App / Data & connections / Other; feature switches get their own page, extended with session proxy, multimodal reading (image / video / audio models and endpoints) and workflow switches
- **Custom models saved per channel**: maintain a custom model list right in the channel editor (comma-separated batch add, removable chips); the composer's model picker follows the active channel; the model-config page is simpler (external binary path and config-file editing entry points are gone)
- **Agent prompts take effect**: picking an agent runs the session with its system prompt as the main thread (same as the engine's --agent)
- **Background task notices**: task completion notices (status and summary) render in the conversation timeline

🐛 Fixes
- New sessions could occasionally land in the wrong directory, leaving them missing from the sidebar and impossible to delete — fixed
- Channels without tier mappings no longer show opus / sonnet / haiku aliases in the model picker — High / Mid / Low instead
- Error banners are now selectable for copying
- Consistent wording — "CLI" no longer appears in the UI (the app's own program is called the engine)`,
    },
  },
  {
    version: "3.0.0-1",
    date: "2026-09-22",
    content: {
      zh: `✨ 新功能
- **全新四分区界面**：对话列表 ｜ 对话 ｜ 文件列表 ｜ 文件编辑器。文件编辑器独立在最右侧，支持多标签、拖拽调宽与折叠；对话区只属于对话，切换会话走左侧列表，变更（diff）也在编辑器区查看
- **多窗口**：会话列表右键「在新窗口打开」，对话在独立窗口打开；文件编辑器标签拖到窗口边缘即可拖出成单独编辑窗口
- **模型显示更直观**：模型选择器只保留三个档位，固定按 High / Mid / Low 顺序排列，并显示为「[档位]模型名」——直接看到每个档位实际运行的模型（如 [High]deepseek-v4-pro[1m]）；渠道编辑的每个模型字段新增「1M 上下文」开关，一键为模型名加上 [1m] 后缀
- **推理强度五档**：low / medium / high / xhigh / max，与内置引擎完全对齐
- **推理强度火焰动画**：强度滑杆的每个档位都有火箭尾焰动画——火焰从滑块处喷出，长度随档位变化（最弱档是一枚短火苗、越往上越长，最高档铺满整条轨道）；星空与背景跟随已点燃的区间，且随档位越流越快；档位切换时火焰即时跟随、无延迟，颜色从最弱档的黄色渐变到最高档的蓝色尾焰
- **终端信息不再隐藏**：重试的具体原因、第二大脑提醒、记忆提示等直接显示在对话时间线上
- **详细显示**（设置 → 通用）：开启后工具调用参数与结果默认展开，适合查看完整过程
- **桌面级交互**：界面不再像网页那样随手扫选文字——拖拽标签、分隔条或空白区域不会留下蓝色选区，从外壳拖过正文也不会起选；聊天正文、代码块、工具输出与编辑器照常划词复制；编辑器标签拖动时有跟随鼠标的浮层卡片，拖出窗口也一路跟随，松手即消失、归位、重排或移到独立窗口
- **编辑器分栏更自然**：拖动编辑器左侧的分隔线时，文件列表与编辑器此消彼长——分隔线跟着鼠标走，不再把文件列表整栏推着移动
- **图片与视频直接查看**：文件列表里的图片和视频在编辑器里直接打开——图片不限大小（HEIC / AVIF 等常见格式都支持），视频带播放器、可拖动进度条
- **编辑器窗口头部适配**：拖出的编辑器窗口里，文件名不再压住 macOS 左上角的窗口按钮
- **编辑器窗口更完整**：Windows 仿 mac 标题栏下，拖出的编辑器窗口带自绘窗口按钮；关闭该窗口时文件自动回到原来的窗口（标签还原，不再消失）`,
      en: `✨ Features
- **New four-pane layout**: sessions | conversation | files | file editor. The editor lives in its own right-most pane with tabs, drag-resize and collapse; the conversation column is just the conversation — switch sessions from the sidebar, and diffs open in the editor pane too
- **Multi-window**: right-click a session to "Open in new window"; drag an editor tab to the window edge to pop it into a standalone editor window
- **Clearer model display**: the picker now offers exactly three tiers, always ordered High / Mid / Low, and shows "[tier]model" — the real model each tier runs (e.g. [High]deepseek-v4-pro[1m]); every model field in the channel editor gains a "1M context" switch that appends the [1m] suffix
- **Five reasoning levels**: low / medium / high / xhigh / max, matching the engine exactly
- **Reasoning-effort flame**: every stop on the effort slider burns — the flame fires from the thumb and its length follows the level (a stubby lick at the gentlest stop, longer with each step, filling the whole track at max); the starfield and backdrop follow the burnt stretch and stream faster with the level; switching is instant, with the color running from yellow at the gentlest stop up to the blue rocket exhaust at max
- **Terminal-only messages are no longer hidden**: retry reasons, second-brain notes and memory hints render in the conversation timeline
- **Detailed display** (Settings → General): tool-call arguments and results expand by default
- **Desktop-grade interaction**: the UI no longer sweeps a text selection like a web page — dragging tabs, dividers or empty space leaves no blue smear, and a drag that starts on chrome never catches the text it passes over; chat text, code blocks, tool output and the editor stay selectable. Editor tabs drag with a floating card that follows the pointer — even outside the window — and vanishes on release, settling back, reordering, or popping out into its own window
- **Natural editor split**: dragging the editor's left divider now trades width with the file-list pane — the border follows the pointer instead of shoving the whole panel along
- **Images and videos preview in place**: pictures and videos from the file tree open right in the editor — images of any size (HEIC / AVIF and other common formats), videos with a player and a seek bar
- **Editor-window header inset**: in a popped-out editor window the file name no longer sits under the macOS traffic lights
- **More complete editor windows**: in the Windows mac-style titlebar mode a popped-out editor window carries its own window buttons; closing it hands the file back to the window it came from (the tab returns instead of disappearing)`,
    },
  },
  {
    version: "1.0.4",
    date: "2026-09-18",
    content: {
      zh: `✨ 新功能
- **claude 弹窗提问（AskUserQuestion）**：支持双向应答；未决提问以悬浮层覆盖输入框，支持单选 / 多选、多问题翻页、自由输入作答与「忽略」，答完转为只读历史行
- **内置 Agents 目录**：设置页新增内置 Agents 面板；输入区支持 @ 选择 agent、/ 选择 prompt 的触发菜单
- **状态栏分支跟随嵌套仓库**：文件树选中子仓库内的文件 / 文件夹时，分支胶囊、分支列表与检出跟随该仓库（显示「仓库名·分支」）
- 插件 SDK 0.3.7 / 0.3.9 / 0.3.10：支持插件即时刷新会话、添加输入区状态项、修改会话推理强度

🐛 修复
- 推理强度切换对已有会话无效
- 新建空会话（「新对话」页签）不在侧栏显示；折叠文件夹后恢复短列表
- 消息文件链接在嵌套工程下解析失败；@ 提及路径在 Windows 上正常显示与跳转
- Windows「在资源管理器中显示」对含空格路径无效、静默跳到「文档」
- 快速完成的回合回复可能丢失
- Claude / Kimi 渠道路由与原生别名互相污染
- 中断对话时可能残留异常状态`,
      en: `✨ Features
- **claude AskUserQuestion popups**: two-way answering; pending questions overlay the composer with single/multi-select, multi-question paging, free-text answers, and "Ignore"; answered questions become read-only history rows
- **Built-in Agents catalog**: a built-in Agents pane in Settings; the composer offers @ agent and / prompt trigger menus
- **Status-bar branch follows nested repos**: selecting a file/folder inside a nested git repo switches the branch pill, branch list, and checkout to that repo (shown as "repo·branch")
- Plugin SDK 0.3.7 / 0.3.9 / 0.3.10: plugins can refresh sessions instantly, add composer status items, and change session reasoning effort

🐛 Fixes
- Effort switching had no effect on existing sessions
- Empty new chats ("New chat" tabs) didn't appear in the sidebar; collapsing a folder restores the short recent list
- Message file links failed to resolve in nested projects; @ mention paths render and open correctly on Windows
- Windows "Show in Explorer" had no effect for paths with spaces and silently jumped to Documents
- Fast-completing turns could lose their replies
- Claude/Kimi channel routing no longer pollutes native aliases
- Interrupted conversations could leave residual state`,
    },
  },
  {
    version: "1.0.3",
    date: "2026-09-16",
    content: {
      zh: `✨ 新功能
- Windows 可切换**仿 macOS 自绘标题栏**
- 侧栏工作区行可**拖拽**到分组 / 未分组 / 已归档完成移动
- 插件 SDK 0.3.5 / 0.3.6：新增会话右键菜单扩展点；插件可深链到自身设置页

🐛 修复
- 修复 Windows 对话子进程（pwsh/conhost）泄漏残留的问题，插件子进程一并处理
- 上下文窗口显示：/compact 后不再回落到默认值；新会话记住实际窗口大小；回合结束自动更新真实占用，无需手动「刷新用量」
- claude auto 模式下 WebSearch / WebFetch 被拦截
- 修复模型目录加载死循环；DSH 客户端访问本机地址时不走代理
- codex 旧版本会提示升级；运行错误信息缺失时仍有错误提示
- 修复远程会话删除后重新出现的问题`,
      en: `✨ Features
- Windows can switch to a **macOS-style custom title bar**
- Sidebar workspace rows can be **dragged** into groups / ungrouped / archived containers
- Plugin SDK 0.3.5 / 0.3.6: new session context-menu extension point; plugins can deep-link to their own settings page

🐛 Fixes
- Windows child processes (pwsh/conhost) no longer leak; plugin child processes are covered too
- Context window display: the denominator no longer falls back after /compact; new sessions remember the actual window size; usage updates automatically when a turn ends — no manual "refresh usage" needed
- WebSearch / WebFetch were blocked in claude auto mode
- Model catalog loading could loop forever; the DSH client no longer routes local addresses through the proxy
- Older codex builds now get an actionable upgrade hint; the error banner still works when no error output is available
- Deleted remote sessions no longer reappear`,
    },
  },
  {
    version: "1.0.2",
    date: "2026-09-15",
    content: {
      zh: `✨ 新功能
- 接入 **OpenCode** 与 **Qoder** 两个一等引擎；Qoder 区分国际版与国内版
- **WSL 插件**全链接入：远程会话与文件、界面集成、历史回放、模型目录
- **快捷键系统迁移**：可配置键位、设置页录制编辑、快捷键指南
- 会话行**右键菜单**：重命名 / 复制 ID / 删除

🐛 修复
- 新会话不再被刷新冲掉：侧栏即时显示，无需手动同步
- Windows 检测不到新装 / 非 npm 渠道安装的 codex 与 claude
- claude 上下文窗口改为显示引擎上报的实际值
- 修复 Windows 上本地资源加载异常
- 移动端设置导航分组溢出重叠
- WSL 接入安全加固：收紧权限并增加远程调用超时
- 修复更新检查在资产名包含空格时失败的问题`,
      en: `✨ Features
- Two new first-class engines: **OpenCode** and **Qoder**, with Qoder split into Global and CN distributions
- **WSL plugins** wired end to end: remote sessions and files, UI integration, history replay, and model catalog
- **Shortcut system migration**: configurable keybindings, recording editor in Settings, and a shortcut guide
- Session-row **context menu**: rename / copy ID / delete

🐛 Fixes
- New sessions no longer get wiped by refreshes — the sidebar shows them immediately, no manual sync
- Windows now detects freshly installed or non-npm codex and claude builds
- claude context window shows the actual value reported by the engine
- Fixed local asset loading on Windows
- Mobile settings navigation groups no longer overflow and overlap
- WSL integration security hardening: tightened permissions and a timeout for remote calls
- Update checks no longer fail when an asset name contains spaces`,
    },
  },
  {
    version: "1.0.1",
    date: "2026-09-14",
    content: {
      zh: `✨ 新功能
- 右键文件夹**搜索工作区文件**
- OMP 引擎补 plan / bypass 权限档

🐛 修复
- 修复「已编辑」行数统计不准
- 窄窗下侧边栏开关常显、幕布区留白修正、子代理行归并`,
      en: `✨ Features
- **Search workspace files** from a folder's right-click menu
- OMP engine gains plan / bypass permission tiers

🐛 Fixes
- "Edited" line counts are now accurate
- Narrow windows keep the sidebar toggle visible, fix backdrop gaps, and merge subagent rows`,
    },
  },
  {
    version: "1.0.0",
    date: "2026-09-08",
    content: {
      zh: `✨ 新功能
- 接入 **OMP 引擎**
- 新增 **局域网网页访问**：设置页提供二维码入口，手机浏览器可直接使用
- **Pi 家族引擎认证**：OAuth 订阅授权与 API Key 管理、cc-switch 渠道导入与切换
- **AI 聊天输入区增强**：@ 提及、权限 / 推理强度档位、分支菜单、提示历史补全
- 消息锚点导航、Provider 配置对话框与引擎 / 历史层增强
- 首页外观设置与交互粒子字标

🐛 修复
- Windows 上派生子进程不再弹出控制台窗口`,
      en: `✨ Features
- Add the **OMP engine**
- **LAN web access**: QR entry in Settings, so phones on the same network can use HZK CODE in a browser
- **Pi-family engine auth**: OAuth subscription sign-in and API Key management, cc-switch channel import and switching
- **Composer upgrades**: @ mentions, permission / reasoning-effort tiers, branch menu, prompt-history completion
- Message anchor navigation, provider configuration dialog, and engine/history layer improvements
- Home appearance settings with an interactive particle wordmark

🐛 Fixes
- Spawned child processes no longer show console windows on Windows`,
    },
  },
  {
    version: "0.9.4",
    date: "2026-08-30",
    content: {
      zh: `✨ 新功能
- 侧栏工作区子项增加树状连接线；会话刷新时强制同步最新状态并显示忙碌提示
- 设置新增 **侧栏网络代理抽屉**
- 文件底部状态栏新增 **Git Blame** 切换按钮

🐛 修复
- 修复 pi 多轮请求交错时「响应中」卡死、重复叙述与完成音连响
- 修复 Windows 单文件「差异不可用」死路
- 修复新建会话抽屉卡死

⚡ 性能
- 优化工具实时输出的渲染性能，减少会话切换卡顿`,
      en: `✨ Features
- Sidebar workspace children get tree lines; session refresh forces a sync with a busy state
- New **network proxy drawer** in Settings
- **Git Blame** toggle in the file status bar

🐛 Fixes
- Fix pi sessions stuck in "running" with duplicated narration when requests interleave
- Fix the Windows single-file "diff unavailable" dead end
- Fix the new-session drawer freeze

⚡ Performance
- Smoother live tool output rendering and session switching`,
    },
  },
  {
    version: "0.9.3",
    date: "2026-08-26",
    content: {
      zh: `🐛 修复
- 修复 PI 模型目录加载不完整的问题
- 修复 Codex 上下文窗口显示不实
- 修复会话「响应中」永久卡死
- 修复 Windows 平台下的进程检测
- 修复消息渲染崩溃循环`,
      en: `🐛 Fixes
- Fix incomplete PI model catalog loading
- Fix the Codex context window showing a fabricated value
- Fix sessions stuck in "running" forever
- Fix process detection on Windows
- Fix the message-rendering crash loop`,
    },
  },
  {
    version: "0.9.2",
    date: "2026-08-22",
    content: {
      zh: `✨ 新功能
- 接入 **Qoder** Global 与 CN 双分发

🐛 修复
- 修复多智能体协作模板选择器卡在加载中
- 修复共享会话的归属判定，并隐藏其子会话`,
      en: `✨ Features
- **Qoder** Global and CN distributions

🐛 Fixes
- Fix the multi-agent template picker stuck loading
- Shared sessions resolve ownership correctly and hide their child sessions`,
    },
  },
  {
    version: "0.9.1",
    date: "2026-08-19",
    content: {
      zh: `✨ 新功能
- DSH 输入区支持 **Agent Preset** 选择器

🐛 修复
- DSH Agent Preset 按会话隔离展示，任务条与上下文占用正常显示
- 收敛长对话尾部重复的用户气泡
- 隐藏 Shared 续跑会话及其侧栏子会话`,
      en: `✨ Features
- DSH gets an **Agent Preset** picker in the composer

🐛 Fixes
- DSH Agent Presets are isolated per session; task bar and context usage display correctly
- Collapse duplicated user bubbles at the tail of long conversations
- Hide Shared resumed sessions and their sidebar children`,
    },
  },
];
