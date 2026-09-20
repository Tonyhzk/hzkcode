# 内置 CLI 槽位

放在这里的 CLI 二进制会随打包进入应用包：macOS 为 `HZK CODE.app/Contents/Resources/binaries/`，Windows 为安装目录下的 `binaries\`。

- macOS：文件名 `hzkcode`，需要保留可执行权限（`chmod +x`）。
- Windows：文件名 `hzkcode.exe`。
- 也可以命名成 `claude`，用于直接放入上游构建产物；两个都在时优先 `hzkcode`。

运行时解析顺序是「设置页的自定义路径 → 这里的二进制 → 系统 PATH」。命中内置时，设置页版本行会显示「内置」，并且不再提供 npm / 官方脚本的一键安装入口：这份 CLI 随应用一起更新。

本文件只说明槽位，不参与运行。
