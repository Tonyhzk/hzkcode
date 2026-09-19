# 更新日志

## [Unreleased]

- 引擎裁剪：删除 Claude Code 之外的全部 CLI 引擎（Codex、Kimi、Grok、Antigravity、OpenCode、Qoder、PI/OMP、DeepSeek Harness），设置页与对话界面只保留 Claude 引擎入口
- Rust 后端：引擎适配器、会话扫描/解析、渠道注入、CLI 生命周期管理与二进制搜索路径均只保留 claude 分支；删除 DSH host、PI/OMP 认证等引擎专属命令与设置字段
- 前端：移除 DSH 与 PI/OMP 专属设置区块、Fast 模式（service tier）功能与引擎专属文案；模型第三方厂商徽标保留（claude 渠道仍可服务第三方模型）
- 全面品牌改名：应用显示名改为 HZK CODE，内部标识（包名、Rust crate、事件名、localStorage 键、插件 SDK 包名、CSS 层名、环境变量前缀）从 ccgui / ccgui-next 统一为 hzkcode
- 应用标识与目录变更：bundle identifier 改为 `com.hzkcode.app`，应用数据目录改为 `~/.hzkcode/gui/`，工作区提示词目录改为 `<项目>/.hzkcode/prompts`
- 插件市场入口暂时关闭（代码完整保留，恢复时打开 `MARKETPLACE_ENABLED`）
- 更新检查与发布地址改为本项目 GitHub Releases（github.com/Tonyhzk/hzkcode）

## [0.1.0] - 2026-09-19

- 初始化项目：引入 desktop-cc-gui v1.0.5 基座源码，建立项目骨架