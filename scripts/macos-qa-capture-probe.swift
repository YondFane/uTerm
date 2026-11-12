import AppKit
import Foundation
import ImageIO

@main
struct CaptureProbe {
    @MainActor
    static func main() async {
        let root = URL(fileURLWithPath: CommandLine.arguments.last ?? ".")
        var report: [String: Any] = ["passed": false, "platform": "macOS", "system": ProcessInfo.processInfo.operatingSystemVersionString,
                                     "sourceHeadSHA": ProcessInfo.processInfo.environment["PR_HEAD_SHA"] ?? "",
                                     "testedMergeSHA": ProcessInfo.processInfo.environment["UTERM_QA_TESTED_SHA"] ?? "",
                                     "scope": "Capture infrastructure only; this is not the uTerm application or product acceptance"]
        #if arch(arm64)
        report["architecture"] = "arm64"
        #else
        report["architecture"] = "x86_64"
        #endif
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Isolated capture infrastructure probe"
        window.center(); window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps: true)
        defer { window.orderOut(nil) }
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try await Task.sleep(for: .milliseconds(500))
            window.displayIfNeeded()
            let targetInfo = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(window.windowNumber)) as? [[String: Any]]
            guard let bounds = targetInfo?.first?[kCGWindowBounds as String] as? [String: Any],
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { throw failure("Probe window is missing from WindowServer") }
            report["targetBounds"] = bounds
            try await capture(window: window.windowNumber, path: root.appendingPathComponent("probe-window.png"))
            guard let above = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow, .excludeDesktopElements], CGWindowID(window.windowNumber)) as? [[String: Any]] else { throw failure("Could not inspect WindowServer surfaces") }
            var surfaces: [[String: Any]] = []
            for item in above {
                guard let pid = item[kCGWindowOwnerPID as String] as? Int, let processID = Int32(exactly: pid),
                      NSRunningApplication(processIdentifier: processID)?.bundleIdentifier == "com.apple.dock",
                      item[kCGWindowLayer as String] as? Int == 20,
                      let bounds = item[kCGWindowBounds as String] as? [String: Any],
                      let rectangle = CGRect(dictionaryRepresentation: bounds as CFDictionary), rectangle == CGDisplayBounds(CGMainDisplayID()),
                      let number = item[kCGWindowNumber as String] as? Int else { continue }
                let path = root.appendingPathComponent("dock-\(number).png")
                try await capture(window: number, path: path)
                guard let source = CGImageSourceCreateWithURL(path as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw failure("Could not decode the original Dock capture") }
                let count = try WindowCaptureAlpha.nontransparentPixels(image: image, windowFrame: rectangle, targetFrame: frame)
                surfaces.append(["windowNumber": number, "bounds": bounds, "capture": path.lastPathComponent, "nontransparentPixelsInTarget": count])
            }
            report["desktopSurfaceObserved"] = !surfaces.isEmpty
            report["desktopSurfaces"] = surfaces
            report["passed"] = surfaces.allSatisfy { ($0["nontransparentPixelsInTarget"] as? Int) == 0 }
        } catch { report["failure"] = error.localizedDescription }
        try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent("report.json"), options: .atomic)
        if report["passed"] as? Bool != true { exit(1) }
    }

    private static func failure(_ message: String) -> NSError { NSError(domain: "UTermCaptureProbe", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }

    private static func capture(window: Int, path: URL) async throws {
        try await Task.detached {
            let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            process.arguments = ["-x", "-o", "-l", String(window), path.path]
            try process.run(); process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw failure("WindowServer capture failed") }
        }.value
    }
}
