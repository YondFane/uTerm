import CoreGraphics
import AppKit
import Foundation

let display = CGMainDisplayID()
let verifyOnly = CommandLine.arguments.dropFirst().contains("--verify-only")
func rectangle() -> [String: Double] {
    let bounds = CGDisplayBounds(display)
    return ["width": bounds.width, "height": bounds.height]
}
var report: [String: Any] = ["minimumWidth": 1280, "minimumHeight": 900, "before": rectangle(), "scope": "login-session", "verifyOnly": verifyOnly]
var passed = false
do {
    let bounds = CGDisplayBounds(display)
    if bounds.width < 1280 || bounds.height < 900 {
        guard !verifyOnly else { throw NSError(domain: "uTermQA", code: 3, userInfo: [NSLocalizedDescriptionKey: "The capture display did not persist after the configuration process exited"]) }
        let modes = CGDisplayCopyAllDisplayModes(display, nil) as? [CGDisplayMode] ?? []
        report["availableModes"] = modes.map { ["width": $0.width, "height": $0.height, "pixelWidth": $0.pixelWidth, "pixelHeight": $0.pixelHeight] }
        guard let mode = modes.filter({ $0.width >= 1280 && $0.height >= 900 })
            .min(by: { $0.width * $0.height < $1.width * $1.height }) else {
            throw NSError(domain: "uTermQA", code: 1, userInfo: [NSLocalizedDescriptionKey: "The runner has no display mode large enough for real 1100x720 window captures"])
        }
        // Keep the mode after this helper exits; app-only configuration reverts before capture.
        // 在此辅助进程退出后保留显示模式；仅应用配置会在截图前回退。
        var configuration: CGDisplayConfigRef?
        guard CGBeginDisplayConfiguration(&configuration) == .success, let configuration else {
            throw NSError(domain: "uTermQA", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not begin runner display configuration"])
        }
        let configured = CGConfigureDisplayWithDisplayMode(configuration, display, mode, nil)
        guard configured == .success else {
            CGCancelDisplayConfiguration(configuration)
            throw NSError(domain: "uTermQA", code: Int(configured.rawValue), userInfo: [NSLocalizedDescriptionKey: "Could not select runner display mode"])
        }
        let result = CGCompleteDisplayConfiguration(configuration, .forSession)
        guard result == .success else {
            throw NSError(domain: "uTermQA", code: Int(result.rawValue), userInfo: [NSLocalizedDescriptionKey: "Could not configure the isolated runner display"])
        }
        for _ in 0..<10 {
            if CGDisplayBounds(display).width >= 1280 && CGDisplayBounds(display).height >= 900 { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
    }
    let actual = CGDisplayBounds(display)
    guard actual.width >= 1280 && actual.height >= 900 else {
        throw NSError(domain: "uTermQA", code: 2, userInfo: [NSLocalizedDescriptionKey: "Runner display remains too small for the required capture grid"])
    }
    if verifyOnly {
        let screen = NSScreen.main?.frame ?? .zero
        report["cocoaFrame"] = NSStringFromRect(screen)
        report["cocoaVisibleFrame"] = NSStringFromRect(NSScreen.main?.visibleFrame ?? .zero)
        guard screen.width >= 1280 && screen.height >= 900 else {
            throw NSError(domain: "uTermQA", code: 5, userInfo: [NSLocalizedDescriptionKey: "AppKit still sees a display smaller than the capture requirements"])
        }
    }
    passed = true
} catch {
    report["failure"] = error.localizedDescription
}
report["passed"] = passed
report["after"] = rectangle()
print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
if !passed { exit(1) }
