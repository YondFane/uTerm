import AppKit
import Foundation
import UTermBridge

@MainActor
enum ControlSmoke {
    private static func pressControlToggle(in window: NSWindow) throws -> Bool {
        var queue = window.contentView.map { [$0] } ?? []
        while !queue.isEmpty {
            let view = queue.removeFirst()
            if let button = view as? NSButton,
               button.identifier?.rawValue == "native-local-control-toggle" {
                guard button.isEnabled else { return false }
                button.performClick(nil)
                return true
            }
            queue.append(contentsOf: view.subviews)
        }
        return false
    }
    private static func cli(root: URL, args: [String], failure: Bool = false) async throws -> JSONValue {
        guard let resources = Bundle.main.resourceURL else { throw BridgeFailure(code: "CONTROL_SMOKE", message: "Missing helper resources") }
        let executable = resources.appendingPathComponent("bin/utermd-local")
        let arguments = ["--control", "--data-dir", root.path] + args
        let response = try await Task.detached(priority: .userInitiated) {
            let process = Process()
            let output = Pipe(), errors = Pipe()
            process.executableURL = executable
            process.arguments = arguments
            process.standardOutput = output
            process.standardError = errors
            try process.run()
            let bytes = output.fileHandleForReading.readDataToEndOfFile()
            let error = errors.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return (process.terminationStatus, bytes, String(decoding: error, as: UTF8.self))
        }.value
        if failure {
            guard response.0 != 0 else { throw BridgeFailure(code: "CONTROL_SMOKE", message: "Disabled or guarded command unexpectedly succeeded") }
            return .object(["error": .string(response.2)])
        }
        guard response.0 == 0 else { throw BridgeFailure(code: "CONTROL_SMOKE", message: response.2) }
        return try JSONDecoder().decode(JSONValue.self, from: response.1)
    }

    static func run(model: WorkspaceModel, window: NSWindow?, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.bridge, let window,
              let path = WorkspaceModel.argument("--control-smoke-report") else {
            throw BridgeFailure(code: "CONTROL_SMOKE", message: model.error)
        }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent()
        let project = root.appendingPathComponent("control-project")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("Control QA"), "directory": .string(project.path), "workspaceId": .string(model.groupID)]) else {
            throw BridgeFailure(code: "CONTROL_SMOKE", message: model.error)
        }
        guard let menu = NSApp.mainMenu?.items.first?.submenu,
              let item = menu.items.first(where: { $0.action.map(NSStringFromSelector) == "settings" }),
              let action = item.action, NSApp.sendAction(action, to: item.target, from: item) else {
            throw BridgeFailure(code: "CONTROL_SMOKE", message: "Native Settings action missing")
        }
        try await TerminalSmoke.wait("Show control settings") { window.attachedSheet?.isVisible == true }
        var pressed = false
        for _ in 0..<40 {
            if try pressControlToggle(in: window.attachedSheet!) { pressed = true; break }
            try await Task.sleep(for: .milliseconds(50))
        }
        guard pressed else { throw BridgeFailure(code: "CONTROL_SMOKE", message: "Native control checkbox is unavailable") }
        try await TerminalSmoke.wait("Enable control through the native checkbox") { model.controlStatus["enabled"].bool == true && !model.controlBusy }
        let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
        try await TerminalSmoke.capture(window: window.attachedSheet!, path: directory.appendingPathComponent("native-control-settings.png"))
        let status = try await cli(root: root, args: ["status"])
        guard status["sessions"].number == 0 else { throw BridgeFailure(code: "CONTROL_SMOKE", message: "Status did not use the native snapshot") }
        let guarded = try await cli(root: root, args: ["sessions", "new", project.path], failure: true)
        guard guarded["error"].string?.contains("dialog") == true else { throw BridgeFailure(code: "CONTROL_SMOKE", message: "Modal guard did not reject the command") }
        report["settingsGuardRejectedWrite"] = true
        report["controlSettingsDriver"] = "Native NSButton.performClick target/action; not manual pointer input"
        model.settingsPresented = false
        try await TerminalSmoke.wait("Dismiss control settings") { window.attachedSheet == nil }
        let projects = try await cli(root: root, args: ["projects", "list"])
        guard projects.array.contains(where: { $0["name"].string == "Control QA" }) else { throw BridgeFailure(code: "CONTROL_SMOKE", message: "Project list did not use the native store") }
        let first = try await cli(root: root, args: ["sessions", "new", project.path])
        guard let firstID = first["id"].string else { throw BridgeFailure(code: "CONTROL_SMOKE", message: "Missing CLI-created session") }
        try await TerminalSmoke.wait("Start the CLI-created PTY") { model.terminals[firstID]?.generation != nil }
        let second = try await cli(root: root, args: ["sessions", "new", project.path])
        guard let secondID = second["id"].string else { throw BridgeFailure(code: "CONTROL_SMOKE", message: "Missing second session") }
        try await TerminalSmoke.wait("Start the second CLI-created PTY") { model.terminals[secondID]?.generation != nil }
        let sessions = try await cli(root: root, args: ["sessions", "list"])
        guard sessions.array.count == 2 else { throw BridgeFailure(code: "CONTROL_SMOKE", message: "CLI sessions were duplicated or lost") }
        window.performClose(nil)
        guard !window.isVisible else { throw BridgeFailure(code: "CONTROL_SMOKE", message: "Window did not hide") }
        _ = try await cli(root: root, args: ["open", "uterm://session/\(firstID)"])
        try await TerminalSmoke.wait("Focus through the authenticated CLI") { window.isVisible && model.selectedID == firstID }
        _ = try await cli(root: root, args: ["sessions", "send", firstID, "printf 'CLI_%s 中文 é\\n' READY", "--enter"])
        try await TerminalSmoke.wait("Read CLI input from the real PTY") { model.terminals[firstID]?.text.contains("CLI_READY 中文 é") == true }
        try await TerminalSmoke.capture(window: window, path: directory.appendingPathComponent("native-control-terminal.png"))
        let retained = model.terminals[secondID]?.generation
        _ = try await cli(root: root, args: ["sessions", "close", firstID])
        let host = try await bridge.call("host.status")
        guard model.state?.sessions.count == 1, model.terminals[secondID]?.generation == retained,
              host["sessions"].array.contains(where: { $0["spec"]["id"].string == secondID && $0["running"].bool == true }) else {
            throw BridgeFailure(code: "CONTROL_SMOKE", message: "Closing the first session affected its peer")
        }
        _ = try await cli(root: root, args: ["sessions", "close", secondID])
        guard model.state?.sessions.isEmpty == true else { throw BridgeFailure(code: "CONTROL_SMOKE", message: "Session configuration was not removed") }
        _ = try await bridge.call("host.shutdownIdle")
        await model.configureControl(false)
        let disabled = try await cli(root: root, args: ["status"], failure: true)
        guard disabled["error"].string?.contains("endpoint not found") == true else { throw BridgeFailure(code: "CONTROL_SMOKE", message: "Disabled endpoint remained discoverable") }
        report["realStandaloneCLI"] = true
        report["cliCreatedRealPTYs"] = 2
        report["unicodeInputParsed"] = true
        report["focusReopenedWindow"] = true
        report["explicitClosePreservedPeer"] = true
        report["disabledEndpointUnavailable"] = true
        report["controlCaptures"] = ["native-control-settings.png", "native-control-terminal.png"]
        report["sessionCountAfterClose"] = 0
    }
}
