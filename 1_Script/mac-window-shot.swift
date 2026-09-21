// macOS 窗口截图小工具：列出窗口 / 直接截取指定应用窗口。
// 不激活窗口、不移动鼠标、不截整个桌面，适合自动化验证 UI。
//
// 编译：
//   swiftc -O 1_Script/mac-window-shot.swift -o 1_Script/mac-window-shot
//
// 用法：
//   mac-window-shot list [过滤词]                  # 列出当前屏幕上的窗口
//   mac-window-shot shot <匹配词> <输出.png>       # 按窗口名匹配（取面积最大者）
//   mac-window-shot shot --id <窗口ID> <输出.png>  # 按窗口 ID 截图
//
// 说明：截图走系统 screencapture（-l 指定窗口、-o 去阴影、-x 静音），
// 需要「屏幕录制」权限（终端所在应用已授权即可）。

import CoreGraphics
import Foundation

struct WindowInfo {
    let id: Int
    let owner: String
    let title: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func onScreenWindows() -> [WindowInfo] {
    let options = CGWindowListOption([.optionOnScreenOnly, .excludeDesktopElements])
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    return list.compactMap { info in
        guard
            let number = info[kCGWindowNumber as String] as? Int,
            let bounds = info[kCGWindowBounds as String] as? [String: Any]
        else { return nil }
        return WindowInfo(
            id: number,
            owner: info[kCGWindowOwnerName as String] as? String ?? "",
            title: info[kCGWindowName as String] as? String ?? "",
            x: bounds["X"] as? Double ?? 0,
            y: bounds["Y"] as? Double ?? 0,
            width: bounds["Width"] as? Double ?? 0,
            height: bounds["Height"] as? Double ?? 0
        )
    }
}

func capture(_ window: WindowInfo, to path: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    // -x 静音；-o 不含窗口阴影；-l<id> 只截这个窗口。
    process.arguments = ["-x", "-o", "-l\(window.id)", path]
    do {
        try process.run()
    } catch {
        fail("无法运行 screencapture：\(error)")
    }
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        fail("screencapture 失败（退出码 \(process.terminationStatus)）")
    }
    let owner = window.owner.isEmpty ? "?" : window.owner
    let title = window.title.isEmpty ? "(无标题)" : window.title
    print("已截取 \(owner)「\(title)」→ \(path)")
}

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "list"

switch command {
case "list":
    let filter = args.count > 1 ? args[1].lowercased() : nil
    for window in onScreenWindows() {
        if let filter {
            let haystack = (window.owner + " " + window.title).lowercased()
            if !haystack.contains(filter) { continue }
        }
        print(
            "\(window.id)\t\(window.owner)\t\(window.title)\t\(Int(window.x)),\(Int(window.y))\t\(Int(window.width))x\(Int(window.height))"
        )
    }
case "shot":
    let windows = onScreenWindows()
    let target: WindowInfo?
    let output: String
    if args.count >= 2, args[1] == "--id" {
        guard args.count >= 4, let id = Int(args[2]) else {
            fail("用法：mac-window-shot shot --id <窗口ID> <输出.png>")
        }
        target = windows.first { $0.id == id }
        output = args[3]
    } else {
        guard args.count >= 3 else {
            fail("用法：mac-window-shot shot <匹配词> <输出.png>")
        }
        let match = args[1].lowercased()
        let matches = windows.filter {
            ($0.owner + " " + $0.title).lowercased().contains(match)
        }
        // 多个候选时取面积最大的窗口（通常是主窗口）。
        target = matches.max { $0.width * $0.height < $1.width * $1.height }
        output = args[2]
    }
    guard let window = target else {
        fail("没有匹配的窗口（先用 list 查看）")
    }
    capture(window, to: output)
default:
    fail("用法：mac-window-shot list [过滤词] | shot <匹配词> <输出.png> | shot --id <窗口ID> <输出.png>")
}
