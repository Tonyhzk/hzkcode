# 更新日志

## [Unreleased]

- 全面品牌改名：应用显示名改为 HZK CODE，内部标识（包名、Rust crate、事件名、localStorage 键、插件 SDK 包名、CSS 层名、环境变量前缀）从 ccgui / ccgui-next 统一为 hzkcode
- 应用标识与目录变更：bundle identifier 改为 `com.hzkcode.app`，应用数据目录改为 `~/.hzkcode/gui/`，工作区提示词目录改为 `<项目>/.hzkcode/prompts`
- 插件市场入口暂时关闭（代码完整保留，恢复时打开 `MARKETPLACE_ENABLED`）
- 更新检查与发布地址改为本项目 GitHub Releases（github.com/Tonyhzk/hzkcode）

## [0.1.0] - 2026-09-19

- 初始化项目：引入 desktop-cc-gui v1.0.5 基座源码，建立项目骨架