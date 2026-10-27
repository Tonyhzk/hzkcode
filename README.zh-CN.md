<div align="center">

# HZK CODE

<img width="120" alt="hzkcode 图标" src="./src/hzkcode/public/app-icon.png" />

[English](./README.md) · **简体中文**

<a href="https://atomgit.com/Tonyhzk/hzkcode" target="_blank"><img src="https://atomgit.com/Tonyhzk/hzkcode/star/new_badge.svg" alt="AtomGit G-Star" width="250" height="54"/></a>

![][github-contributors-shield] ![][github-forks-shield] ![][github-stars-shield] ![][github-issues-shield]

</div>

**HZK CODE** 是一个开源的 AI 编程桌面客户端。简单说：它把 **Claude Code** 命令行 AI 编程 runtime 放进一个统一的图形界面里。

你不用再盯着黑乎乎的终端敲命令——打开 HZK CODE，选好项目，像聊天一样让 AI 帮你写代码、改 Bug、提交 Git。流式输出、思考过程和工具调用都会实时展示；token 用量在引擎上报时同步呈现。

应用基于 **Tauri 2 + React 18 + TypeScript + Rust** 开发，支持 macOS / Windows / Linux。设置与状态默认在本机持久化；发送给 AI provider 的内容，遵循你为对应 CLI 配置的渠道边界。

---

## HZK CODE 能干什么

### 一个客户端，装下 Claude Code

- 注册了 **Claude Code** 的 runtime adapter——在输入框的引擎选择器里使用。
- **供应商渠道由应用保存，启动时注入引擎**：渠道配置存在应用自己的设置里，启动会话时以环境变量下发，不改写 CLI 的原生配置文件；内置 GLM、Kimi、DeepSeek、MiniMax、MiMo、LongCat、OpenCode Go、OpenRouter 等精选预设。高、中、低三档模型可分别指定接口协议与思考默认值，留空跟随全局。
- 支持**按标签页覆盖模型与 effort 档位**：同一个窗口里，不同标签页可以跑不同模型或思考强度。effort 分 off、none、low、medium、high、xhigh、max 七档；off 表示不发送 effort 字段，不是关闭思考。
- 会话历史不丢：历史扫描器直接读取 CLI 的原生会话文件并保持标题同步，关掉应用再打开还能接着聊。

### 当前版本使用说明

- 内置 **3.5.3 引擎**，桌面端版本为 **3.5.3-1**。
- **MCP 按需连接**：普通外部服务不再随聊天自动连接，使用时通过 `LoadMCP` 提供启动参数或 HTTP 地址，再通过 `UseMCP` 调用工具；每轮聊天的连接 ID 不会延续到下一轮。身份编辑器已提供这两个工具选项，已有身份的选择保持不变。
- **输入框外侧显示会话操作**：身份、行为、提示词、协议、代理、第二大脑与上下文和用量统计同排显示；空间充足时展开独立按钮，聊天列变窄时合为一个「会话」菜单，靠右紧邻用量统计，不占输入框内部空间、不换行。协议入口显示当前实际使用的接口协议，身份、提示词、行为与协议修改不需要发送聊天消息。工作模式紧邻输入框右侧的发送按钮，窄列自动缩为图标，发送按钮保持完整显示。
- **身份应用方式可选**：已有聊天时可在当前会话切换、克隆会话或追加身份；空会话直接切换，默认身份不可追加。应用自带角色、自定义角色及引擎身份均可使用。
- **会话设置随恢复保留**：原地修改不丢历史，克隆保留原会话；追加身份不替换基础身份、模型与权限。失败时保留当前会话与选择，可重试。
- **操作结果在聊天中可见**：切换身份、行为、提示词或协议，以及修改代理、第二大脑和上下文窗口，会在对应会话显示操作记录；指令输出也会保留在历史中。关闭「详细显示」不隐藏这些反馈，界面操作记录不会作为新提问发送给模型。
- **工作模式分边界与开关**：默认、只读、规划是边界，自动审查、自动继续、自动接受修改是开关；开关受边界约束，菜单内修改确认后生效。
- **工具默认按需发现**：关闭后在初始提示里一次性提供全部工具说明。
- **压缩有独立设置**：生成摘要的模型、渠道、思考等级与流式可与主对话不同。
- **提示词模式与文件位置可选**：内置规范可选完整或精简；临时文件与规划文件可选项目目录或系统临时目录，删除方式可选系统回收站或项目 `.delete/`。
- **思考内容是否显示由界面开关控制**，只影响显示，不改变引擎发送的内容。

### 聊天框是为写代码设计的

- 流式回复按动画帧逐步展示，配合语法高亮缓存——长输出也保持流畅，不会每来一个 token 就重排一遍 markdown。
- **思考流**与正文合并展示，结束后自动折叠，需要时一键展开看全文。
- 工具调用以实时行呈现，参数与结果可展开查看，内置美化的 **Git Diff**、**Bash** 查看器和每次运行的完成元数据。
- **运行状态条**实时镜像引擎进度（含 todo 快照），消息**锚点导航栏**让你在用户消息之间快速跳转。
- 粘贴图片自动转附件；`@` 文件引用基于感知 `.gitignore` 的项目文件索引；回复中的文件链接能处理 URL 编码路径，并支持右键菜单。
- 权限被拒时可以在对话内直接为引擎追加授权目录；输入框还内置提示词历史。

### 不只是聊天，是一整套开发面板

- **文件树**：虚拟化渲染，带 Git 状态颜色、嵌套仓库徽标、右键菜单与拖拽——内置 CodeMirror 编辑器面板，支持 Markdown 预览。
- **内置终端**：真正的 PTY 终端坞（xterm + WebGL），不用切窗口。
- **Git 面板**：暂存、提交、分支搜索、看 diff、翻提交历史。
- **命令面板**：一个键盘驱动的入口，调起应用内所有命令。

### 插件系统

- 自研 **插件 SDK**（`@hzkcode/plugin-sdk`），配套应用内运行时、管理界面与信任边界。
- **声明式插件**无需编写前端代码即可新增设置区块与配置驱动的界面；应用内建界面（包括设置页本身）也走同一套扩展点注册。
- 完整开发指南见 [0_Doc/plugin-development-guide.zh-CN.md](./0_Doc/plugin-development-guide.zh-CN.md)。

### 设置、网络与更新

- **配置备份**：在桌面主窗口的「设置 → 数据与连接 → 配置备份」用密码导出 `.hzkbackup`，在另一台电脑解密预览后恢复；包含应用管理的渠道与密钥、模型、工具与后台助手设置、自定义智能体、全局提示词和界面偏好。导入前自动加密备份当前配置到 `~/.hzkcode/gui/config-backups/`（使用本次导入密码），确认恢复后重启。应用设置、渠道与智能体被替换，同名全局提示词覆盖，其余提示词保留。请先保存文件和输入草稿、结束会话与终端、关闭其他窗口及远程访问。备份不含聊天、项目与工作区列表、项目提示词、插件及其独立数据、程序外部的官方配置 / Rules / Skills / MCP 或系统钥匙串登录状态；换机后需核对本机路径与网络地址，目录授权不迁移，远程连接不自动开启。密码遗失无法恢复。
- **代理设置**：为应用与引擎流量配置代理。
- **局域网网页访问**：通过 token 鉴权的 WebSocket 桥接，把界面共享给局域网内其他设备，设置页提供二维码入口。
- **工作区管理**：给项目分组，快速切换。
- 应用内**自动更新**（Tauri updater，对接 GitHub Releases）、版本记录对话框、macOS 打包。
- 中英双语界面。

---

## 下载安装

直接去 [Releases 页面](https://github.com/Tonyhzk/hzkcode/releases) 下载安装包：

| 平台 | 安装包 |
| --- | --- |
| macOS（M 系列芯片） | `aarch64.dmg` |

macOS 安装包未签名（项目暂无 Apple 开发者证书），首次打开需要右键 → 打开。

装好之后，打开设置配置供应商渠道（或直接登录），即可新建会话，不必先添加工作区。没有项目时，会话使用自动创建的 `~/hzkcode-default-workspace`，归在侧栏置顶的「默认」分组；该分组不能移除、归档或拖入其他分组。目录不会自动初始化 Git，也不会写入项目指令；顶部的 Finder 入口可打开该目录。需要在现有项目里工作时，再添加项目文件夹。

---

## 把项目跑起来（启动教程）

想自己编译、或者参与开发？跟着下面三步走。

### 第一步：准备环境

| 工具 | 版本要求 | 用来干嘛 |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | 20 或更新 | 跑前端工具链 |
| [pnpm](https://pnpm.io/) | 10（`packageManager` 字段已锁定） | 安装依赖 |
| [Rust](https://rustup.rs/) | stable（用 rustup 装） | 编译后端 |

不同系统还需要一点额外准备（这是 Tauri 框架的要求，详见 [Tauri 官方环境文档](https://v2.tauri.app/start/prerequisites/)）：

- **macOS**：装 Xcode 命令行工具：`xcode-select --install`。
- **Windows**：装 Microsoft C++ Build Tools 和 WebView2（Win 11 自带 WebView2）。
- **Linux**：装 `webkit2gtk` 等系统库，照着 Tauri 官方文档抄命令就行。

### 第二步：装依赖

```bash
git clone https://github.com/Tonyhzk/hzkcode.git
cd hzkcode/src/hzkcode
pnpm install
```

注意：这是一个 **pnpm workspace**（插件 SDK 在 `src/hzkcode/packages/plugin-sdk`），锁定文件是 `src/hzkcode/pnpm-lock.yaml`。以下开发、测试和构建命令均在 `src/hzkcode/` 中执行，不在外层主目录执行。

### 第三步：启动

```bash
pnpm dev
```

几个小提示：

- **第一次启动要编译整个 Rust 后端，可能等上几分钟**，去倒杯水。之后是增量编译，很快。
- 前端开发服务器跑在 `14210` 端口。

### 打安装包

```bash
pnpm build:mac   # macOS 构建（scripts/build-macos.sh）
```

发布采用本地手动构建流程（本项目没有 CI 流水线）。

---

## 怎么改代码（开发教程）

### 技术栈一览

| 部分 | 用的什么 |
| --- | --- |
| 界面 | React 18 + TypeScript + Tailwind CSS 4 + zustand |
| 构建 | Vite 6 |
| 桌面框架 | Tauri 2（Rust 后端：git2、rusqlite、portable-pty、axum） |
| 测试 | Vitest（前端）+ cargo test（Rust） |

### 目录结构

```text
hzkcode/
├── CLAUDE.md               # 项目开发约定
├── README.md               # 英文项目说明
├── README.zh-CN.md         # 中文项目说明
├── CHANGELOG.md            # 应用完整版本记录
├── VERSION                 # 应用版本号
├── 0_Doc/                  # 开发、插件与测试文档
├── 0_Backup/               # 本地备份
├── 0_Reference/            # 参考资料
├── 0_Release/              # 发布产物
├── 1_Script/               # 维护脚本
├── assets/                 # 项目素材
└── src/hzkcode/            # 源码工作区，开发命令在此执行
    ├── src/                # 前端功能、组件、国际化与工具函数
    ├── src-tauri/          # Rust 后端与应用资源
    ├── packages/plugin-sdk/ # @hzkcode/plugin-sdk
    ├── tests/              # 回归测试与浏览器测试页面
    └── scripts/            # 构建与打包脚本
```

### 改一个功能的套路

1. **只改界面**：找到 `src/features/` 下对应的模块改就行。新组件直接放在该模块自己的目录里。
2. **需要后端配合**：在 `src-tauri/src/` 对应模块里加 `#[tauri::command]`，前端通过 Tauri API 调用。
3. **改了界面文字**：必须走 i18n，并同步两套 bundle（`src/i18n/zh.ts`、`src/i18n/en.ts`）；界面文字不允许硬编码。

### 常用命令

| 命令 | 干嘛的 |
| --- | --- |
| `pnpm dev` | 启动完整应用（Tauri 开发模式） |
| `pnpm build` | TypeScript 类型检查 + 前端生产构建 |
| `pnpm test` | 跑 Vitest 测试套件 |
| `pnpm preview` | 预览生产构建的前端 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 跑 Rust 测试 |

### 测试怎么写

- 前端测试用 [Vitest](https://vitest.dev/)——源码旁边放 `xxx.test.ts(x)` 同位测试，较重的套件统一放 `tests/` 目录。
- Rust 端测试照常写在模块里，用 `cargo test --manifest-path src-tauri/Cargo.toml` 跑。

---

## 开发规范

规矩不多，但都有原因，提交前过一遍：

1. **提 PR 前跑通本地验证**：`pnpm build`（类型检查）和 `pnpm test` 全绿；动了 Rust 再加 `cargo test`。
2. **界面文字必须走 i18n**：所有用户可见文案都从 `src/i18n/` 取，并保持两套 locale bundle 同步，不许硬编码。
3. **组件就近放**：新组件先放自己 feature 的目录里；确实被多个功能复用了，再挪到 `src/components/`。
4. **TypeScript 严格模式**：别用 `any` 糊弄，类型写明白。
5. **优先通过插件 SDK 扩展**：新增设置区块与界面，尽量走内建界面同款扩展点注册。
6. **永远不要提交密钥**：API Key、token 这类东西绝对不能进代码和提交记录。

### Commit 信息怎么写

默认使用中文主体的 [Conventional Commits](https://www.conventionalcommits.org/)：`type(scope): 中文动宾短句`。

| type | 什么时候用 |
| --- | --- |
| `feat` | 加新功能 |
| `fix` | 修 Bug |
| `refactor` | 重构（行为不变） |
| `docs` | 改文档 |
| `test` | 加/改测试 |
| `chore` | 杂活（版本号、依赖、脚本） |
| `perf` / `style` / `ci` | 性能优化 / 格式 / CI |

仓库里的真实例子：

```text
feat(chat): 支持工具调用参数与结果展开、Git Diff/Bash美化及完成元数据展示
fix(chat): 消息文件链接在嵌套工程下解析失败
perf(chat): reveal streamed text per frame without reparsing markdown
```

不要在 commit 信息里写 emoji，也不要带 AI 生成署名。

---

## 怎么提交你的代码（贡献流程）

1. **Fork** 本仓库，clone 到本地。
2. 从 `main` 切一个分支，名字按 `feat/xxx`、`fix/xxx` 这种风格起。
3. 改代码，本地把 `pnpm build` + `pnpm test` 跑绿。
4. 提 PR 到本仓库的 **`main` 分支**。标题按 commit 格式写，描述里说清楚：改了什么、为什么改、怎么验证的。

不知道从哪下手？看看 [Issues](https://github.com/Tonyhzk/hzkcode/issues)，挑一个感兴趣的开干。发现 Bug 或有新点子，也欢迎直接开 Issue 聊。

### 想深入了解项目内部？

- [插件开发指南](0_Doc/plugin-development-guide.zh-CN.md) — SDK、manifest、权限模型与信任边界。
- [插件 SDK 版本记录](0_Doc/plugin-sdk-changelog.md)。
- [内置引擎说明](0_Doc/bundled-engine.md)。
- [浏览器回归测试说明](0_Doc/browser-tests.md)。
- [v1.0.3 版本说明](0_Doc/RELEASE_NOTES_v1.0.3.md)。

---

## License

[MIT](https://github.com/Tonyhzk/hzkcode?tab=MIT-1-ov-file)

---

## 友链

感谢 [LINUX DO](https://linux.do/) 用户的支持与反馈。

[AtomGit](https://atomgit.com/Tonyhzk/hzkcode)：在国内托管本项目，帮助中国大陆用户更快访问项目与下载 Release。

感谢 [AtomGit](https://atomgit.com/Tonyhzk/hzkcode) 平台 G-Star 认证

---

## 贡献者列表

感谢所有帮助 HZK CODE 变得更好的贡献者。

<a href="https://github.com/Tonyhzk/hzkcode/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Tonyhzk/hzkcode" alt="Contributors" />
</a>

---

## 参考项目说明

本项目最初源自 [CodexMonitor](https://github.com/Dimillian/CodexMonitor)。自 v1.0.0 起代码库已从零完全重写，不再包含 CodexMonitor 的任何代码，但仍感谢其最初带来的启发。

---

## Star History

[![Star History Chart](https://star-history.dera.page/svg?repos=Tonyhzk/hzkcode&type=date&legend=top-left)](https://star-history.dera.page/#Tonyhzk/hzkcode&type=date&legend=top-left)

<!-- LINK GROUP -->

[github-contributors-shield]: https://img.shields.io/github/contributors/Tonyhzk/hzkcode?color=c4f042&labelColor=black&style=flat-square
[github-forks-shield]: https://img.shields.io/github/forks/Tonyhzk/hzkcode?color=8ae8ff&labelColor=black&style=flat-square
[github-issues-link]: https://github.com/Tonyhzk/hzkcode/issues
[github-issues-shield]: https://img.shields.io/github/issues/Tonyhzk/hzkcode?color=ff80eb&labelColor=black&style=flat-square
[github-license-link]: https://github.com/Tonyhzk/hzkcode/blob/main/LICENSE
[github-stars-shield]: https://img.shields.io/github/stars/Tonyhzk/hzkcode?color=ffcb47&labelColor=black&style=flat-square
