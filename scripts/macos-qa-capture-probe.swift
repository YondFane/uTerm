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
            let pointer = try await pointerProbe(window: window, root: root)
            report["pointerProbe"] = pointer
            report["passed"] = surfaces.allSatisfy { ($0["nontransparentPixelsInTarget"] as? Int) == 0 } && pointer["hiddenPointerIdentityVerified"] as? Bool == true
        } catch { report["failure"] = error.localizedDescription }
        try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent("report.json"), options: .atomic)
        if report["passed"] as? Bool != true { exit(1) }
    }

    @MainActor
    private static func pointerProbe(window: NSWindow, root: URL) async throws -> [String: Any] {
        guard let frame = NSScreen.main?.frame else { throw failure("Missing probe display") }
        window.styleMask = [.borderless]; window.setFrame(frame, display: true)
        func cursorSurfaces() throws -> [[String: Any]] {
            guard let above = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow, .excludeDesktopElements], CGWindowID(window.windowNumber)) as? [[String: Any]] else { throw failure("Could not inspect pointer surfaces") }
            return above.filter { ($0[kCGWindowOwnerName as String] as? String) == "Window Server" && ($0[kCGWindowLayer as String] as? Int) == 2147483630 }
                .map { item in
                    let pid = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
                    return ["windowNumber": item[kCGWindowNumber as String] ?? 0, "bounds": item[kCGWindowBounds as String] ?? [:],
                            "layer": item[kCGWindowLayer as String] ?? 0, "executable": pid.flatMap { WindowCaptureSystemPointer.executable(pid: $0) } ?? "unavailable"]
                }
        }
        let before = try cursorSurfaces(), display = CGMainDisplayID()
        guard CGDisplayHideCursor(display) == .success else { throw failure("Could not hide the probe pointer") }
        var hidden = true
        defer { if hidden { _ = CGDisplayShowCursor(display) } }
        try await Task.sleep(for: .milliseconds(100))
        let during = try cursorSurfaces()
        let verified = during.allSatisfy { item in
            guard let bounds = item["bounds"] as? [String: Any], let rectangle = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
            return WindowCaptureSystemPointer.isHiddenPointer(hiddenByQA: true, executable: item["executable"] as? String, layer: item["layer"] as? Int ?? 0, width: rectangle.width, height: rectangle.height)
        }
        let filename = "probe-fullscreen-pointer-hidden.png"
        try await capture(window: window.windowNumber, path: root.appendingPathComponent(filename))
        let restored = CGDisplayShowCursor(display) == .success; hidden = !restored
        guard restored else { throw failure("Could not restore the probe pointer") }
        return ["frame": NSStringFromRect(frame), "before": before, "during": during, "pointerHidden": true, "pointerRestored": restored, "cursorSurfacesGoneDuringCapture": during.isEmpty, "hiddenPointerIdentityVerified": verified, "capture": filename]
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
