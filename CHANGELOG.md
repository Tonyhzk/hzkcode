# 更新日志

## [Unreleased]

- 引擎裁剪：删除 Claude Code 之外的全部 CLI 引擎（Codex、Kimi、Grok、Antigravity、OpenCode、Qoder、PI/OMP、DeepSeek Harness），设置页与对话界面只保留 Claude 引擎入口
- Rust 后端：引擎适配器、会话扫描/解析、渠道注入、CLI 生命周期管理与二进制搜索路径均只保留 claude 分支；删除 DSH host、PI/OMP 认证等引擎专属命令与设置字段
- 前端：移除 DSH 与 PI/OMP 专属设置区块、Fast 模式（service tier）功能与引擎专属文案；模型第三方厂商徽标保留（claude 渠道仍可服务第三方模型）
- 全面品牌改名：应用显示名改为 HZK CODE，内部标识（包名、Rust crate、事件名、localStorage 键、插件 SDK 包名、CSS 层名、环境变量前缀）从 ccgui / ccgui-next 统一为 hzkcode
- 应用标识与目录变更：bundle identifier 改为 `com.hzkcode.app`，应用数据目录改为 `~/.hzkcode/gui/`，工作区提示词目录改为 `<项目>/.hzkcode/prompts`
- 插件市场入口暂时关闭（代码完整保留，恢复时打开 `MARKETPLACE_ENABLED`）
- 更新检查与发布地址改为本项目 GitHub Releases（github.com/Tonyhzk/hzkcode）
- 版本号四处统一为 0.1.0（外层 `VERSION`、`package.json`、`Cargo.toml`、`tauri.conf.json`），版本线从上游 1.0.5 重新起算
- 移除 `.github/workflows/`（release.yml、build-windows-artifact.yml）：GitHub Actions 只识别仓库根目录的 workflows，内层副本不会触发；发布改为手动维护
- macOS 打包：删除 `scripts/build-signed-macos.sh`，改为 `scripts/build-macos.sh`（`pnpm build:mac`）；移除 `tauri.conf.json` 中上游的 `bundle.macOS.signingIdentity` 证书配置，产物不签名，首次打开需右键 → 打开
- 应用更新签名密钥更换为本项目自己的 minisign 密钥对（私钥 `~/.tauri/hzkcode.key`，公钥写入 `tauri.conf.json` 的 `plugins.updater.pubkey`）
- README（中英）同步当前状态：移除已裁剪引擎（Codex / Kimi / Grok / Pi / OMP / DSH）的描述，下载与打包说明改为未签名产物与本地手动发布；删除已失效的 `docs/omp-fast-mode.md` 及其引用
- 设置页「社区与反馈」更新为项目自有信息：官方交流群二维码替换为项目公众号码，关注我们改为 GitHub / 官网 / 哔哩哔哩 / 抖音 / 小红书 / 知乎
- 新增 HZK CODE 品牌图标（蓝色方块 H）：设计源 `assets/hzkcode-icon.svg`；应用图标源图（深灰圆角底板 + H）经 `pnpm tauri icon` 重新生成全套（icns / ico / 各尺寸 png 与 Windows Store logos），侧边栏 logo 与 favicon 同步替换
- 界面中的 Claude Code 品牌全面替换：引擎显示名（`CLI_DISPLAY_NAMES` 与 i18n `engines`）改为 HZK CODE；引擎与模型图标统一为 H 标（新增 `src/assets/brand/hzkcode-mark.svg`，移除 `model-icons/claude.svg`）；CLI 版本状态只显示版本号，探测结果由 Rust 侧 `display_version` 剥离引擎品牌后缀
- 对话模型选择器扁平化：单引擎下打开选择器直接显示模型面板（搜索、渠道、推理强度），不再渲染引擎行与「{{name}} 引擎」标题；trigger 直接显示「模型 · 推理强度」；claude 模型目录不再输出 provider 来源标签，消除模型列表上方的来源分组标题（多来源时分组能力保留）
- 内置 CLI：新增应用内二进制槽位 `src/hzkcode/src-tauri/binaries/`，经 `bundle.resources` 打包到 `Contents/Resources/binaries/`（Windows 为安装目录 `binaries\`）；Rust 侧 `resolve::bundled_cli_binary` 按「设置页自定义路径 → 内置二进制 → 系统 PATH」解析，`.app` 内优先 `Contents/Resources/binaries`，开发态回落到源码槽位；`.gitignore` 忽略该目录下的二进制，只保留槽位说明
- 内置状态下的 CLI 生命周期：`resolve::is_bundled_cli_path` 判定内置后跳过 npm registry 版本查询，`update_kind` 返回 null 隐藏一键安装/更新按钮，`cli_update_plan` / `cli_update` 改为说明「随应用一起更新」；`cli_version_status` 新增 `source`（bundled / system）字段
- 设置页 CLI 版本行在使用内置二进制时显示「内置」标识（i18n `settings.cliVersionBundled`），提示该 CLI 随应用更新
- CLI 管理页「官方文档」链接改为项目文档站（`https://doc.hzkcode.houzhenkun.com`），不再指向上游文档
- 变量约定收敛到 hzkcode：应用写入、注入、读取的 provider 变量全部改用 CLI 自己的名字（`HZKCODE_BASE_URL` / `HZKCODE_API_KEY` / `HZKCODE_MODEL` / `HZKCODE_DEFAULT_HIGH|MID|LOW_MODEL` / `HZKCODE_MAX_THINKING_TOKENS` 等），渠道模板、模型槽位、渠道掩码表、模型目录与努力档注入都不再出现 `ANTHROPIC_*` / `CLAUDE_CODE_*` 拼写；`provider_files::env_names` 只发射 hzkcode 名字
- 启动 CLI 时先清掉从父进程继承的 provider 变量（`provider_files::is_provider_env_key`）并在选中具体渠道时设置 `HZKCODE_PROVIDER_MANAGED_BY_HOST=1`，让界面渠道成为唯一来源、CLI 自己的 settings.json 无法把请求改到别的端点
- cc-switch 导入归一化：导入时把外部文件里的旧变量名改写为 hzkcode 名字（端点、凭据、能力档模型、`CLAUDE_CODE_*` 前缀），导入后的渠道可直接使用
- 模型目录对齐 CLI：别名表去掉上游独有的 `fable`，能力档默认值改从 `HZKCODE_DEFAULT_*_MODEL` 读取，模型槽位由四个减为三个（sonnet / opus / haiku）
- 集成测试 `send_path` 改为通过设置里的自定义路径指向假 CLI：PATH 发现会被开发槽位 `src-tauri/binaries/` 里的二进制盖过
- 设置导航改版：去掉「CLI 管理」分组，CLI 配置成为独立板块「模型配置」，排在设置列表第一位（通用之前），里面就是官方配置与供应商渠道（API URL / API Key / 模型映射）；随之下线该分组专用的拖拽排序、未启用折叠桶与导航顺序持久化逻辑（单引擎不再需要）
- 界面精简：移除 cc-switch 同步与导入（同步横幅、导入菜单、渠道来源徽标与图标资源，后端 `cc_switch` 模块及其 4 个命令、web 路由、`CcSwitchStatus`/`CcSwitchImportResult` 类型）
- 界面精简：移除「启用 HZK CODE」开关及其卡片与停用蒙层，`set_engine_enabled` 命令（含 web 路由与前端封装）一并删除；引擎固定启用，渠道列表不再有停用入口
- 设置打开时默认选中导航第一项（模型配置），不再固定落在通用；显式 `?page=` 与旧的 `?page=cliConfig` 链接仍然生效
- 变量清理收窄：`is_provider_env_key` 不再按 `HZKCODE_USE_*` / `HZKCODE_SKIP_*` 前缀整族清理（那会连 `HZKCODE_USE_BUILTIN_RIPGREP`、`HZKCODE_SKIP_PROMPT_HISTORY` 这类 CLI 功能开关一起丢掉），改为按名列出 provider 选择与跳过鉴权的几个变量；补对应单测，并同步三处仍写 `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` 的过时注释
- 模型配置页重做（渠道对话框）：改为界面控件——接口格式下拉（anthropic / responses / chat_completions）、自动压缩阈值、默认模型、高阶/中阶/低阶模型、读取模型；原始 JSON 收进默认折叠的「高级 · 原始 JSON」，不再一打开就是一大段 JSON
- 默认模板按 hzkcode 逐项校对：删除 CLI 不读或不该由渠道携带的键（`tui`、`teammateMode`、`autoDreamEnabled`、`hasCompletedOnboarding`、`skipAutoPermissionPrompt`、`language`、`cleanupPeriodDays`、`HZKCODE_NEW_INIT`、`HZKCODE_ANTHROPIC_BETAS`、`HZKCODE_SMALL_FAST_MODEL`、`HZKCODE_ENABLE_TOOL_SEARCH`）与写死的模型 id，只留 CLI 真正读取的变量
- 新增「功能开关」区（模型配置页）：联网搜索（适配器 / Perplexity 凭据）、图片与文件上传（OSS）、飞书通知、用户记忆、第二大脑、自动模式、工作状态汇报、CLI 代理；由应用保存于 `settings.json` 的 `cliEnv`（`settings::feature_env`）并在启动 CLI 时注入所有会话，非法变量名与被拒键（`NODE_OPTIONS` 等）会被过滤
- 引擎配置根目录从 Claude Code 的 `~/.claude` / `CLAUDE_CONFIG_DIR` 切换为 fork 的 `~/.hzkcode` / `HZKCODE_CONFIG_DIR`：会话扫描与远程回放白名单、渠道官方配置文件路径、全局 commands/skills 目录、模型目录（含 WSL 远端探针）、`config.rs` 测试用环境变量列表一并更新，GUI 与单独安装的 CLI 共用同一份数据
- 对话显示：CLI 的 `system/informational` 通知（第二大脑指导意见与调用失败、个人记忆提示、模型降级、Stop Hook 失败）不再丢弃，实时流与历史记录都渲染为时间线通知行，按等级（warning / error）着色
- 对话显示：重试详情从悬停提示改为常显——「重试中 x/y」下方直接打印 CLI 给出的具体原因（HTTP 状态、断流说明）
- 新增「通用 → 行为 → 详细显示」开关（开发者模式）：开启后过程行默认展开，工具调用的参数与结果内联显示；关闭时保持现状（折叠 + 点击展开）
- 功能开关补充第二大脑「请求数门槛」（`HZKCODE_SECOND_BRAIN_MIN_NEW_RESPONSES`）：GUI 每次发送都是新进程、间隔与请求计数从零开始，设为 0 时任意工具轮次结束后即可复核
- 内置 CLI 同步更新：fork 在无头 stream-json 输出中转发用户可见的系统通知（此前 headless 只输出压缩边界与重试事件），通知在产生时即写入会话记录，刷新、重开或另行读取该会话时仍然保留、顺序与显示一致；第二大脑的主对话判定纳入 GUI 无头会话（querySource `sdk`，与 fork 内部 isMainThread 口径一致），使其在 GUI 会话中同样可运行、可见
- 界面布局改为四分区（从左到右：对话列表 | 对话区 | 文件列表 | 文件编辑器）：对话区不再与会话标签页、文件编辑器、diff 共用中心区域——会话切换只经由左侧列表，打开文件与查看 diff 都在最右侧独立分区；顶部标签条替换为对话区顶栏（当前会话标题 + 在外部应用打开 + 文件列表/编辑器开合按钮），文件列表分区的 files/changes 切换与刷新按钮移入分区自身头部
- 文件编辑器成为最右侧独立分区：多标签页（文件标签 + 变更 diff 标签）、宽度可拖拽（320–720）、可折叠；打开文件或变更 diff 时自动展开编辑器区（折叠状态下点击变更文件也会展开显示），窄窗口空间不足时自动收起文件列表分区腾出空间；编辑器不再从对话区抢位置（`ChatCenterPane`、`SessionTabStrip`、`ChatPanelHeader` 等旧布局组件删除，新增 `EditorDock`/`EditorTabStrip`/`use-editor-tabs` 与 `use-layout-panels` 的 editor 分区）
- 对话在新窗口打开：左侧会话列表悬停按钮与右键菜单新增「在新窗口打开」，经 Rust 命令 `open_chat_window` 创建独立窗口（按 URL `?ctx=chat&engine=…&sessionId=…&workspacePath=…` 定位会话）；重复打开同一会话聚焦已有窗口而不重复创建
- 文件编辑器标签拖出成独立窗口：标签拖到窗口边缘松手（拖拽中显示提示浮层）或右键菜单「在新窗口打开」打开 `?ctx=editor&filePath=…` 的独立编辑器窗口（只渲染该文件的编辑器）；主窗口的标签按移动语义关闭，未保存的修改先经确认对话框
- 多窗口支持与修复：新增 `windows` 模块与 `open_chat_window` / `open_editor_window` 命令，窗口构建与主窗口共用 `windows::build_window`（macOS Overlay 标题栏、Windows 装饰跟随设置）；关闭任意窗口不再杀掉全局引擎进程与终端（`on_window_event` 改为仅在最后一个窗口销毁时清理）；各窗口的标签与当前会话状态独立持久化（localStorage 键按窗口 label 命名空间隔离，主窗口沿用原键）；主窗口关闭确认在有其他窗口时改为提示「其他窗口中的会话将继续运行」
- 新窗口权限修复：`capabilities/default.json` 原本只授权 `main` 窗口，导致新开的会话 / 编辑器窗口无法拖动、无法设置标题、无法最大化（所有 `core:*` 与插件命令被拒）；授权范围改为 `["main", "chat-*", "editor-*"]` 并补 `core:window:allow-set-title`；文件编辑器头部（`FileEditorHeader`）接入窗口拖动区域，独立编辑器窗口与编辑器区顶行都可拖动窗口
- 新增开发用冒烟示例 `src-tauri/examples/window_smoke.rs`：不启动完整应用即可创建会话 / 编辑器窗口（复用 `windows::build_window` 与真实 `?ctx=…` URL），用于人工核对多窗口行为

## [0.1.0] - 2026-09-19

- 初始化项目：引入 desktop-cc-gui v1.0.5 基座源码，建立项目骨架