# HZKCode 桌面客户端

## 项目简介

为 HZKCode CLI 打造的前后端一体桌面应用，基于 desktop-cc-gui（ccgui）二开，技术栈为 Tauri 2 + React 18 + TypeScript + Rust。

采用外层工作区 + 内层源码结构：外层管理项目文件与发布；完整基座源码位于 `src/hzkcode/`，开发、装依赖、测试和构建均在该目录内执行。

## 引擎支持

当前只保留 Claude Code 一个引擎（HZKCode CLI 的基座）：CLI 驱动协议与 Claude Code SDK 同源，Rust 侧 `ENGINES = ["claude"]`；设置页按「模型与能力 / 应用 / 数据与连接 / 其他（+插件）」分组，「模型配置」板块只有供应商渠道（渠道对话框：预设、API URL / API Key、默认模型（档位下拉：低阶/中阶/高阶/自定义，默认中阶）、模型映射、自定义模型列表——随渠道记录保存，支持逗号分隔批量添加，模型选择器按当前渠道读取并参与失效判定），与独立的「功能开关」页同属「模型与能力」，没有启用开关（引擎固定启用）。功能开关（联网搜索、OSS、飞书、用户记忆、第二大脑、自动模式、工作状态汇报、会话代理、多模态读取、行为与工作流）只在该独立页维护，不再塞进模型配置页；界面不提供外部程序路径与程序自身配置文件的编辑入口。

- 已删除引擎：Codex、Kimi、Grok、Antigravity、OpenCode、Qoder、PI/OMP、DeepSeek Harness（适配器、会话扫描/解析、渠道注入、CLI 生命周期、二进制搜索路径均已裁剪）。
- 模型第三方厂商徽标（GPT/DeepSeek/Kimi/Grok 等）保留：claude 渠道可服务第三方模型，模型列表按厂商显示图标；claude 的徽标已替换为 H 标（界面不出现 Claude 星标）。
- 对话模型选择器只有模型层：单引擎下不渲染引擎/工具选择层，打开选择器即为模型面板；claude 模型目录不带 provider 标签，模型列表平铺展示（未来多来源时保留分组）。
- 会话模型解析只认「用户在当前会话的明确选择 → 渠道默认模型」（默认模型 → 中阶 → 高阶 → 低阶 → 自定义 顺序兜底），不读取转录历史或引擎上报的旧模型名；渠道不再提供的分区覆盖会被清理。渠道「默认模型」在渠道对话框中为档位下拉（低阶模型（Low）/ 中阶模型（Mid）/ 高阶模型（High）/ 自定义模型，未设置按中阶），档位别名写入 `HZKCODE_MODEL`；渠道默认按「引擎 → 渠道」在 store 层从 CLI 配置计算，显示与发送（含后台队列）读同一份值。
- 会话回退（「回退」按钮）：只回退对话 = 待回退点（`hzkcode.rewindAnchors:v1` 本地共享记录，跨窗口/重启保留）随下一次发送以 CLI 隐藏参数 `--resume-session-at <uuid>` 截断上下文（含本条、同一会话 id 继续、旧尾部成为 append-only 文件里的遗弃分支），运行产生过输出后结算才消费待回退点（恢复失败无写入则保留，重试继续回退）；读取端按「段」独立走链过滤孤儿分支（CLI 的每个段从 null 父重启、压缩边界只经 `logicalParentUuid` 桥接，跨段引用与无法确认的布局保守不过滤；并行工具轮的同 `message.id` 兄弟块与工具结果、保留式压缩的 `preservedSegment` 切片按 CLI 的 `applyPreservedSegmentRelinks` 先重接再走链；判定逐文件应用、互不误删），历史分页/扫描摘要/分支/克隆共用该判定；回退入口只出现在 CLI 能定位的消息上（活跃文件的 `parentUuid` 链，含保留切片）——归档段消息与旧格式单文件压缩边界之前的历史不提供入口（`--resume-session-at` 不桥接 `logicalParentUuid`），运行中压缩由 `compacted` 引擎事件即时收口、回合结束后 `refreshRewindable` 按只读命令 `session_rewindable_uuids` 重读真实集合并恢复保留切片入口（只作用于读取前已存在的消息与回退点）；只回退文件更改 = 一次性 `-p --resume <id> --rewind-files <user-uuid>`（按转录里的 `file-history-snapshot` 逐条判定可恢复性），发送环境默认注入 `HZKCODE_ENABLE_SDK_FILE_CHECKPOINTING=1` 记录快照，有未保存编辑器内容或该会话仍在运行时拒绝。
- 终端可见信息不隐藏：CLI 的 `system/informational` 通知（第二大脑指导意见与调用失败、个人记忆提示、模型降级、Stop Hook 失败）实时渲染为时间线通知行（引擎事件 `notice`），历史解析同样保留（`info` 级不显示，与 CLI 默认一致）；重试原因直接显示在「重试中 x/y」下方。
- 设置「通用 → 行为 → 详细显示」：开启后过程行默认展开、工具调用参数与结果内联显示；关闭时保持折叠与点击展开。
- 第二大脑与用户记忆在 GUI 会话中的口径：无头会话（querySource `sdk`）与 REPL 同为主对话（已并入 fork 判定），由「功能开关」里的对应开关启用；GUI 每次发送都是新进程，观察者的间隔与请求计数随之从零开始，指导意见/调用失败通常在同一轮的下一次请求前出现，把请求数门槛设为 0 可让任意工具轮次后立即复核。
- 旧数据迁移逻辑（`~/.ccgui` 配置、legacy prompts 等）保留兼容，迁移源只处理 claude section。

## 界面布局与多窗口

主窗口从左到右四个分区：对话列表 | 对话区 | 文件列表（files/changes/history） | 多标签文件编辑器（最右侧独立分区）。

- 对话区不承载会话标签页，切换会话只走左侧列表；打开文件与 diff 都在最右侧编辑器区分标签展示，编辑器区宽度可拖拽、可折叠，打开文件自动展开。
- 多窗口：会话窗口（`?ctx=chat&engine=…&sessionId=…&workspacePath=…`）与独立编辑器窗口（`?ctx=editor&filePath=…`）由 Rust 命令 `open_chat_window` / `open_editor_window` 创建（`src-tauri/src/windows.rs`，label 前缀 `chat-` / `editor-`，重复打开同一目标聚焦已有窗口）；入口在会话列表行的悬停按钮 / 右键菜单，编辑器标签可拖到窗口边缘松手拖出。
- 窗口权限：`src/hzkcode/src-tauri/capabilities/default.json` 的 `windows` 必须含新窗口前缀（当前 `["main", "chat-*", "editor-*"]`），缺少时新窗口会拖不动、无法设置标题等（权限是编译期嵌入，改后需重新构建）。
- 各窗口的标签与当前会话状态按窗口 label 独立持久化（localStorage 键后缀 `:w:<label>`）；关闭任一窗口不会清理引擎进程与终端，只有最后一个窗口销毁时才清理。
- 文本选择：窗口默认不可选中文本（桌面化）；可复制内容靠 `styles/globals.css` 的 `user-select: text` 白名单，新加可读容器需带 `data-selectable`；从外壳（非白名单区）按下的拖拽由 `lib/selection-guard` 全局禁选（`html[data-window-dragging]`），防止拖动中扫选正文。
- 媒体预览走本机回环 HTTP 服务：编辑器图片 / 视频与 Markdown 本地图片统一经 `lib/platform.ts` 的 `fileUrl` 加载；服务在 `media_server.rs`（127.0.0.1 随机端口 + token，单段 Range 1MB 分片，范围与文件命令 `files::ensure_allowed` 一致），地址由 `windows::build_window` 初始化脚本注入 `window.__hzkcodeMediaBase`（缺失时 `fileUrl` 回退 asset 协议，图片仍可显示）。不用 asset 协议的原因：macOS WKWebView 媒体层不接受自定义 scheme（`asset://` 的 `<video>` 报 MEDIA_ERR_SRC_NOT_SUPPORTED，图片不受影响，2026-09-23 探针实测）。web 访问模式走桥接 `/file` 路由（同样支持 Range）。CSP 的 `img-src` / `media-src` 必须含 `http://127.0.0.1:*` 与 `asset:`；CSP 只在打包产物注入、dev 不校验，改 CSP 后要用打包产物复验。

## 内置 CLI 与数据互通

- 应用内置 CLI 二进制：源码槽位 `src/hzkcode/src-tauri/binaries/`，打包后位于 `HZK CODE.app/Contents/Resources/binaries/`（Windows 为安装目录下的 `binaries\`）；文件名 `hzkcode`（Windows `hzkcode.exe`），也可放上游构建产物 `claude`，两者都在时优先 `hzkcode`。
- 当前内置 CLI 版本：**3.1.0**（槽位二进制 `--version` 自报）；替换槽位二进制时必须同步更新本行。
- 3.1.0 源码快照：外层 `0_Reference/hzk-code-agent-3.1.0-39d129e4`（fork 仓库 tag `v3.1.0`、commit `39d129e4`，不进 Git）；替换二进制前的接口检查可对照该快照。
- 对齐与核对基准：GUI 与内置 CLI 的功能盘点、差距核对、规划与开发一律以上述快照（当前内置版本的源码）和内置二进制实测为准；其他版本或其他仓库的代码不作为依据。
- 会话启动参数：推理强度档位以 `--effort` 直传（不再用 `HZKCODE_MAX_THINKING_TOKENS` 伪造预算）；选中的身份以 `--agents` 定义 JSON + `--agent`（主线程名）下发——定义含 description/prompt（必填非空；空提示词的旧数据发送时以最小提示词兜底，避免配置被静默丢弃）与可选 tools/model/effort/context（context 未限定时显式声明全量三件套，保持「角色预设叠加完整上下文」的既有行为）——并叠加运行期参数：`--tools`（工具白名单；未配置不传、空列表传 `--tools ""` 禁用全部）与身份优先于会话选择的 `--model`/`--effort`；恢复会话时 CLI 仅在定义可用时还原（GUI 每次发送都会重新下发定义）；GUI 侧已移除「智能体文本块内联」（`components/agent-block.ts` 仅保留旧历史的剥离显示）。派生会话进程时把 `HZKCODE_DEV_CALLER_CWD` 钉在会话工作区（CLI 用它决定会话落盘的工程目录，继承启动目录会把会话存错位置、扫描不到也删不掉）。
- 身份编辑器（`AgentEditorDialog` + `features/agents/tool-catalog.ts`）：智能体可配置提示词（必填）/ 工具白名单（勾选列表，工具名必须与内置 CLI 完全一致——白名单下未列出或被自动 deny 的内置工具都会失效，CLI 升级时核对 `getAllBaseTools`）/ 模型（跟随会话或 opus/sonnet/haiku 档位别名）/ 上下文组件开关 / 思考档。`agent_update` 为整体提交语义（每个字段覆盖存储值、缺省清空）。
- 身份切换克隆（对齐 CLI /agents）：已有消息的会话在更换身份发送前先调用 `clone_session`（`history/reader.rs`；全量复制主对话到新会话——不写 forkedFrom、compact 边界保持 null parent、标题原样继承、源文件不动）并切换到新会话继续，克隆后原会话的选择恢复为原身份（定义在时按名恢复、否则清为无身份），回切继续原身份、不会再次克隆；草稿与空会话直接切换；内置身份解析失败原位回退不克隆；克隆失败报错且不发送。克隆检测的基准是 localStorage `hzkcode.sessionAgentByThread:v1` 记录最近一次**发送成功后**写入的身份（含「无身份」，发送失败保留旧值，避免重试时跳过克隆；随会话 id 在 resolve 与 session 事件两条采纳路径迁移 `migrateRecordedAgent`）；本应用无记录时以会话文件兜底——`get_session_agent_setting` 沿段链从最新段往前、逐文件从尾部扫描最后一条 `agent-setting` 条目。
- 会话删除（`delete_session`）不依赖数据库索引：先按记录路径、再按会话 id 在全部工程目录下定位 `.jsonl`（含子代理旁挂目录）删除，文件与记录缺一也幂等成功（侧栏的乐观行/过期行可以直接删掉）。
- 会话分支（`branch_session`）：按消息 uuid 定位源会话（记录路径，缺失时按 id 全目录兜底），分支包含所选消息本身（助手回复与用户提问都含本条；用户提问含本条是 GUI 的既定行为，CLI `/branch` 对提问是不含的）；逐条改写 `sessionId`、重建 `parentUuid`、写入 `forkedFrom`，携带 content-replacement 记录；标题继承为「原名 (分支[ n])」写 `custom-title` 条目并即时入库。消息 uuid 由历史解析（`extract`）与实时流（`message_uuid` 事件）共同提供，前端消息行操作栏据此显示「分支」图标。
- 会话分段读取（CLI 3.1.0）：压缩后旧内容归档为段文件（`<会话ID>/segments/` 与清单 `<会话ID>/segments.json`，活跃段固定为 `<会话ID>.jsonl`）；GUI 的历史读取、扫描摘要与分支定位都沿清单父链拼接 root → active（`history/segments.rs`，含旋转过渡态的只读对账、片段缺失跳过、无法确认时回退单文件），缓存签名 `session_stat_signature` 把清单与链上段文件的大小与 mtime 折入，扫描缓存版本（`CACHE_VERSION`）随之推进。
- 跨会话通信（CLI 3.1.0 默认启用，用户确认保持行为一致）：本机 UDS 消息套接字随会话进程注册，GUI 无头会话在轮次存活期间可被本机其他会话注入消息触发一轮执行（与 CLI 交互式一致，界面不显示来源）；注入消息写入会话文件、执行受权限模式约束，GUI 不拦截、不加额外 UI。`HZKCODE_RESPONSES_WEBSOCKET` 不在 GUI 暴露（每次发送都是新进程，跨轮复用收益有限）。
- 会话开关（对话输入区的「会话开关」菜单）：按会话固定 `HZKCODE_PROXY_ENABLED`（等价 `/proxy on|off`）、`HZKCODE_ENABLE_SECOND_BRAIN`（等价 `/second-brain on|off`）与 `HZKCODE_AUTO_COMPACT_WINDOW`（等价 `/maxtokens`，正整数的会话上下文窗口覆盖，留空＝跟随默认；该覆盖值同时作为主界面进度分母优先显示，设置后即时生效），随每次发送注入子进程、覆盖应用级默认（`SendRequest.proxy_enabled` / `second_brain_enabled` / `auto_compact_window`，状态存 `SessionState.proxyEnabled` / `secondBrainEnabled` / `autoCompactWindow`，null＝跟随）；未设置会话值时进度分母取渠道配置/功能开关里的同名变量（`default_auto_compact_window` 命令，按与启动一致的层序解析），显式会话值优先于渠道配置自带的同名变量；上下文窗口输入在回车、点「应用」或关闭弹层时都会提交合法草稿。新增同类「进程启动期读环境」的会话级开关沿用这一形态。
- 替换内置二进制前必须做接口检查：在 fork 仓库（`hzk-code-agent`）对旧版与新版的提交/标签对比有无影响 GUI 交互的接口变化——核对 GUI 注入的环境变量（`provider_files.rs` 的 `env_names` / `is_provider_env_key` 清单：`HZKCODE_BASE_URL` / `HZKCODE_API_KEY` / `HZKCODE_MODEL` / `HZKCODE_DEFAULT_HIGH|MID|LOW_MODEL` / `HZKCODE_API_MODE` / `HZKCODE_AUTH_MODE` / `HZKCODE_PROVIDER` / `HZKCODE_CONFIG_DIR` / `HZKCODE_PROVIDER_MANAGED_BY_HOST` 等）、无头 stream-json 会话协议与启动参数、配置与会话目录、系统通知输出；CLI 纯内部改动（记忆、第二大脑、提示词等）不算接口变化。方法：对两个提交分别 `git grep` 变量名与协议字段并对比，差异逐项确认无破坏或已在 GUI 侧适配后再替换。
- 运行时解析顺序：设置页自定义路径 → 内置二进制 → 系统 PATH；命中内置时设置页版本行显示「内置」，且不提供 npm / 官方脚本的一键安装入口（随应用一起更新）。
- 引擎配置根目录：`~/.hzkcode`（`HZKCODE_CONFIG_DIR` 可覆盖），与单独安装的 hzkcode CLI 共用同一份配置与会话数据，因此可以同时安装使用；GUI 不再读写 `~/.claude` 与 `CLAUDE_CONFIG_DIR`。
- 提供商与 API Key 由界面管理：渠道配置存在应用自己的配置里，会话启动时以环境变量注入子进程，不依赖用户 shell 配置；变量名只用 CLI 自己的 `HZKCODE_*`（`HZKCODE_BASE_URL` / `HZKCODE_API_KEY` / `HZKCODE_MODEL` / `HZKCODE_DEFAULT_HIGH|MID|LOW_MODEL` / `HZKCODE_MAX_THINKING_TOKENS` 等），不再出现上游 `ANTHROPIC_*`、`CLAUDE_CODE_*` 拼写。注入前会清掉父进程继承的同名变量，选中具体渠道时同时设置 `HZKCODE_PROVIDER_MANAGED_BY_HOST=1`，CLI 自己的 `~/.hzkcode/settings.json` 只作为「官方配置」渠道使用。
- CLI 能力缺口处理：GUI 需求需要 CLI 源码改动才能实现时，不在本仓库改动 CLI 源码；先跳过该项、继续其余工作，完成时把需要 CLI 修改的内容汇总成清单（行为要求与涉及的源码位置）交付；用户先在 `hzk-code-agent` 仓库完成并更新内置二进制后，再做 GUI 侧适配。

## 品牌与标识约定

- 应用显示名统一为 **HZK CODE**（窗口标题、关于页、安装包名、README 文案）。
- 品牌图标为蓝色方块 H（#478CF0）：设计源 `assets/hzkcode-icon.svg`；应用图标由源图 `src/hzkcode/src-tauri/icons/app-icon.png`（深灰圆角底板 + H）经 `pnpm tauri icon` 生成全套；侧边栏 logo 与 favicon 使用 `src/hzkcode/public/app-icon.png`（同一源图）；界面内引擎与模型图标使用透明底 H 标 `src/hzkcode/src/assets/brand/hzkcode-mark.svg`。
- 界面不出现 Claude Code 品牌：引擎显示名统一为 HZK CODE（`CLI_DISPLAY_NAMES` 与 i18n `engines`），CLI 版本状态只显示版本号（Rust `display_version` 剥离引擎品牌后缀）。
- 界面文案不出现「CLI」字样：内置终端程序是应用自身组成部分，用户可见处的表述统一用「程序 / 引擎 / 版本」，引擎固定可用、无启用开关。
- 内部标识统一为 **hzkcode**：npm 包名、Rust crate（`hzkcode` / `hzkcode_lib`）、事件名、localStorage 键、插件 SDK 包名（`@hzkcode/plugin-sdk`）、CSS 层名（`hzkcode-plugins`）、环境变量前缀（`HZKCODE_`）。
- bundle identifier：`com.hzkcode.app`。
- 应用数据目录：`~/.hzkcode/gui/`；工作区提示词目录：`<项目>/.hzkcode/prompts`。
- 旧数据迁移源保持原样、不在改名范围内：`~/.ccgui`、`com.zhukunpenglinyutong.ccgui`、`desktop-cc-gui` 来源注释。
- 更新检查指向本项目 GitHub Releases（github.com/Tonyhzk/hzkcode）；签名公钥与发布流程见「版本记录与发布」。
- 插件市场入口由 `src/features/plugins/marketplace/store.ts` 的 `MARKETPLACE_ENABLED` 控制，当前关闭（代码完整保留）。

## 版本记录与发布

- 版本号四处保持一致：外层 `VERSION`、`src/hzkcode/package.json`、`src/hzkcode/src-tauri/Cargo.toml`、`src/hzkcode/src-tauri/tauri.conf.json`。
- 版本号采用四段语义：前三段跟随内置 CLI 版本、第四段为本程序在该 CLI 版本下的自增序号，统一写作 `3.0.0-1`（第四段放 semver 的 pre-release 段；Cargo/npm/Tauri 都拒绝四段点分写法），视觉与存储一致、不出现四段点分；CLI 升版时前三段跟随、第四段从 1 重新计数。插件侧的宿主版本比较（前端 `ipcBackend.appVersion`、Rust `manifest.rs` 的 `minAppVersion` 校验）剥离 pre-release 段后按三段比较。注意 semver 里 `3.0.0-1` 低于同三段正式版（`3.0.0-1 < 3.0.0`），发布时必须实测 Tauri updater 对 `latest.json` 中该写法的比较与更新判断，避免新版本被判为更旧或触发稳定性过滤。
- 外层 `CHANGELOG.md` 是真实完整的记录，包含内部改动与源码级细节；bug 修复的完整描述写在这里。
- 应用内 `src/hzkcode/src/version/changelog.ts` 的 `CHANGELOG_DATA`（设置 → 社区与反馈 → 版本记录）面向用户，只写功能与修复等用户可感知的变化，不出现源码相关内容。
- 发布手动维护（CI 自动发布 workflow 已移除）：本地构建 → 创建 `v<版本号>` 标签与 GitHub Release → 上传安装包与 updater 产物（`latest.json`、`.app.tar.gz` 及其 `.sig`）。
- macOS 打包：`pnpm build:mac`（`src/hzkcode/scripts/build-macos.sh`）；本机无 Apple 开发者证书，产物未签名，用户首次打开需右键 → 打开。
- 更新签名：项目自己的 minisign 密钥在 `~/.tauri/hzkcode.key`（公钥在 `tauri.conf.json` 的 `plugins.updater.pubkey`）；私钥丢失会导致所有已安装客户端无法自动更新。

## 上游同步记录

- 上游项目：desktop-cc-gui（https://github.com/zhukunpenglinyutong/desktop-cc-gui，MIT 协议）
- 本地源码路径：`src/hzkcode/`
- 初始基线：v1.0.5 源码包（非 Git 克隆，无 commit 记录）
- 已检查完的上游位置：v1.0.5（初始基线，尚未开始逐条同步）
- 上游的 `.github/workflows/`（自动发布与 Windows 构建）已按本项目手动发布策略删除，同步时跳过。

## 开发命令

在 `src/hzkcode/` 下执行：

- `pnpm dev`：启动开发模式（自动启动 Vite，端口 14210，随后编译并运行 Tauri 应用；关闭应用窗口后该进程退出）
- `pnpm install`：安装依赖
- `pnpm build`：前端类型检查与构建
- `pnpm test`：运行 Vitest 测试（Node 26 下需 `NODE_OPTIONS=--no-experimental-webstorage`，否则 Node 原生 localStorage 与 jsdom 注入冲突导致用例收集失败）

开发实例开关约定（用户明确要求）：启动按需，只有用户明确要求时才启动；用户手动退出实例（关闭应用窗口）后保持关闭，不得自动重新启动或恢复；无法确认是否为用户主动关闭时，同样不得自动重启；修改代码前必须先关闭开发实例（窗口会随 `tauri dev` 重建闪烁、自动跳转抢焦点，严重影响用户工作），代码改完必须立即重新打开——编辑前关闭的实例由你在完成后恢复运行，关闭是编辑流程的一步、不是结束状态，不得以「等用户要求」为由保持关闭。`tauri dev` 会在每次 Rust 源码变更时自动重建重启应用窗口并抢焦点；前端改动走 Vite 热更新、不会弹窗。

验证口径（Rust）：涉及公共签名变更（`SendRequest` 字段、tauri 命令参数、`EngineEvent` 变体等）时，以 `cargo test --no-run`（编译 lib / tests / examples 全目标）与 `cargo test --test send_path` 作为完成标准，不得只跑 `cargo test --lib`。

测试写入护栏（Rust）：测试构建只允许写入系统临时目录（`test_support::guard_test_write`，已接入 `settings::atomic_write` 与 `agents::write_store_to`）；新增持久化写入点或新的 HOME/config 目录操控测试时必须接同一护栏与共享锁，防止夹具写入真实用户目录。护栏拒绝即测试失败，按失败处理，不得放宽护栏绕过。

## UI 验证

- 截图只截应用窗口本身（不截桌面、不激活窗口）：`1_Script/mac-window-shot list [过滤词]` 列窗口，`1_Script/mac-window-shot shot <匹配词> <输出.png>` 直接截取（去阴影，走系统 screencapture；源码 `1_Script/mac-window-shot.swift`，编译产物不入库）。
- 禁止模拟用户的鼠标 / 键盘操作；需要交互的验证交由用户手动完成（鼠标键盘约束见《用户信息》工作偏好）。

## Git 服务器

- 平台：GitHub（https://github.com/Tonyhzk）
- 仓库地址：https://github.com/Tonyhzk/hzkcode（公开）
- 推送通道：HTTPS，凭据由系统级 osxkeychain 提供
- 默认分支：main

## 必读文档

- `src/hzkcode/AGENTS.md`：项目开发与 Agent 协作约定
- `src/hzkcode/README.zh-CN.md`：基座功能说明
