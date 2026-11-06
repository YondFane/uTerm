import AppKit
import CoreGraphics
import Foundation

guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true", CommandLine.arguments.count == 3 else {
    fatalError("Display configuration is limited to the owned GitHub Actions desktop")
}
let operation = CommandLine.arguments[1]
let path = URL(fileURLWithPath: CommandLine.arguments[2])
let display = CGMainDisplayID()
let modes = CGDisplayCopyAllDisplayModes(display, nil) as? [CGDisplayMode] ?? []
guard let current = CGDisplayCopyDisplayMode(display) else { fatalError("Missing actual CI display mode") }
func record(_ mode: CGDisplayMode) -> [String: Any] {
    ["id": mode.ioDisplayModeID, "width": mode.width, "height": mode.height,
     "pixelWidth": mode.pixelWidth, "pixelHeight": mode.pixelHeight]
}
func git(_ args: [String]) throws -> String {
    let child = Process(); child.executableURL = URL(fileURLWithPath: "/usr/bin/git"); child.arguments = args
    let pipe = Pipe(); child.standardOutput = pipe
    try child.run(); let data = pipe.fileHandleForReading.readDataToEndOfFile(); child.waitUntilExit()
    guard child.terminationStatus == 0 else { throw NSError(domain: "QA_DISPLAY_GIT", code: 1) }
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}
var report: [String: Any]
let chosen: CGDisplayMode
if operation == "configure" {
    let candidates = modes.filter { $0.width >= 1280 && $0.height >= 900 }
        .sorted { $0.width * $0.height < $1.width * $1.height }
    guard let selected = current.width >= 1280 && current.height >= 900 ? current : candidates.first else {
        throw NSError(domain: "QA_DISPLAY_MODE_UNAVAILABLE", code: 1)
    }
    chosen = selected
    let tested = try git(["rev-parse", "HEAD"])
    let dirty = try git(["status", "--porcelain"])
    report = ["sourceHeadSHA": ProcessInfo.processInfo.environment["PR_HEAD_SHA"] ?? tested,
        "testedMergeSHA": tested, "sourceTreeDirty": !dirty.isEmpty,
        "productionDataAccess": false, "passed": false, "original": record(current), "selected": record(selected)]
} else {
    guard operation == "restore", let data = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any],
          let original = data["original"] as? [String: Any], let id = original["id"] as? NSNumber,
          let selected = modes.first(where: { UInt64($0.ioDisplayModeID) == id.uint64Value }) else {
        throw NSError(domain: "QA_DISPLAY_RESTORE_CONTEXT", code: 1)
    }
    chosen = selected; report = data
}
try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: path, options: .atomic)
guard CGDisplaySetDisplayMode(display, chosen, nil) == .success else { throw NSError(domain: "QA_DISPLAY_CHANGE_FAILED", code: 1) }
RunLoop.current.run(until: Date().addingTimeInterval(1))
guard let actual = CGDisplayCopyDisplayMode(display), actual.ioDisplayModeID == chosen.ioDisplayModeID else {
    throw NSError(domain: "QA_DISPLAY_CHANGE_NOT_APPLIED", code: 1)
}
report[operation == "configure" ? "configured" : "restored"] = record(actual)
report["passed"] = operation == "restore" && report["configured"] != nil
try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: path, options: .atomic)
