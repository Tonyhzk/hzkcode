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
- 引擎配置根目录从 Claude Code 的 `~/.claude` / `CLAUDE_CONFIG_DIR` 切换为 fork 的 `~/.hzkcode` / `HZKCODE_CONFIG_DIR`：会话扫描与远程回放白名单、渠道官方配置文件路径、全局 commands/skills 目录、模型目录（含 WSL 远端探针）、`config.rs` 测试用环境变量列表一并更新，GUI 与单独安装的 CLI 共用同一份数据

## [0.1.0] - 2026-09-19

- 初始化项目：引入 desktop-cc-gui v1.0.5 基座源码，建立项目骨架