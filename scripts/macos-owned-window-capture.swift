import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 4,
      let pid = Int32(CommandLine.arguments[1]), pid > 0,
      let requestedNumber = UInt32(CommandLine.arguments[2]) else { exit(2) }
let path = CommandLine.arguments[3]
guard !FileManager.default.fileExists(atPath: path) else { exit(3) }
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let owned = windows.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid }
let matches = owned.filter { item in
    let owner = item[kCGWindowOwnerPID as String] as? NSNumber
    let identifier = item[kCGWindowNumber as String] as? NSNumber
    let layer = item[kCGWindowLayer as String] as? NSNumber
    let bounds = item[kCGWindowBounds as String] as? [String: NSNumber]
    return owner?.int32Value == pid && (requestedNumber == 0 || identifier?.uint32Value == requestedNumber)
        && layer?.intValue == 0 && (bounds?["Width"]?.doubleValue ?? 0) >= 640
        && (bounds?["Height"]?.doubleValue ?? 0) >= 420
}
// Ambiguous owned windows require an explicit number to preserve capture identity.
// 所属窗口存在歧义时须提供明确编号，以保持截图身份。
guard matches.count == 1, let window = matches.first,
      let number = (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value, number > 0,
      let bounds = window[kCGWindowBounds as String] as? [String: NSNumber],
      let width = bounds["Width"]?.doubleValue, let height = bounds["Height"]?.doubleValue,
      width >= 640, height >= 420 else {
    let diagnostic: [String: Any] = ["ownerPID": pid, "requestedWindow": requestedNumber,
        "eligibleWindows": matches.count, "ownedWindows": owned.map { item in
            ["number": item[kCGWindowNumber as String] ?? NSNull(), "layer": item[kCGWindowLayer as String] ?? NSNull(),
             "bounds": item[kCGWindowBounds as String] ?? NSNull()] as [String: Any]
        }]
    FileHandle.standardError.write(try JSONSerialization.data(withJSONObject: diagnostic, options: .sortedKeys))
    exit(4)
}

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
