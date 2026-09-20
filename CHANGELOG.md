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

## [0.1.0] - 2026-09-19

- 初始化项目：引入 desktop-cc-gui v1.0.5 基座源码，建立项目骨架