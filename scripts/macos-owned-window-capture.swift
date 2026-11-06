import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 4,
      let pid = Int32(CommandLine.arguments[1]), pid > 0,
      let number = UInt32(CommandLine.arguments[2]), number > 0 else { exit(2) }
let path = CommandLine.arguments[3]
guard !FileManager.default.fileExists(atPath: path) else { exit(3) }
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
guard let window = windows.first(where: { item in
    let owner = item[kCGWindowOwnerPID as String] as? NSNumber
    let identifier = item[kCGWindowNumber as String] as? NSNumber
    let layer = item[kCGWindowLayer as String] as? NSNumber
    return owner?.int32Value == pid && identifier?.uint32Value == number && layer?.intValue == 0
}), let bounds = window[kCGWindowBounds as String] as? [String: NSNumber],
      let width = bounds["Width"]?.doubleValue, let height = bounds["Height"]?.doubleValue,
      width >= 640, height >= 420 else { exit(4) }

// Capture from the original CI process tree; Sparkle's relaunched app has a different parent.
// 从原 CI 进程树截图，Sparkle 重启的应用具有不同父进程。
let capture = Process()
capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
capture.arguments = ["-x", "-o", "-l", String(number), path]
try capture.run()
capture.waitUntilExit()
guard capture.terminationStatus == 0,
      let bytes = try? Data(contentsOf: URL(fileURLWithPath: path)), bytes.count > 1000,
      Array(bytes.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10] else { exit(5) }
let metadata: [String: Any] = ["ownerPID": pid, "windowNumber": number, "width": width, "height": height,
    "method": "WindowServer screencapture -l from original CI coordinator; exact owner PID/window number validated",
    "screenshot": URL(fileURLWithPath: path).lastPathComponent]
print(String(decoding: try JSONSerialization.data(withJSONObject: metadata, options: .sortedKeys), as: UTF8.self))
