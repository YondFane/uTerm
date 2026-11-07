import AppKit
import UTermBridge

@MainActor
enum CandidateSmoke {
    static func run(model: WorkspaceModel, window: NSWindow, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.bridge, let path = WorkspaceModel.argument("--candidate-smoke-report") else { throw BridgeFailure(code: "CANDIDATE_CONTEXT", message: "Missing isolated candidate context") }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent().appendingPathComponent("installed-project")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("Installed candidate QA"), "directory": .string(root.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "CANDIDATE_PROJECT", message: model.error) }
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        await model.newTerminal()
        try await TerminalSmoke.wait("Start the installed app's bundled helper and PTY") { model.selectedTerminal?.generation != nil && model.selectedTerminal?.error.isEmpty == true && (model.selectedTerminal?.qaRenderedFrames ?? 0) > 0 }
        guard let terminal = model.selectedTerminal else { throw BridgeFailure(code: "CANDIDATE_PTY", message: "Installed terminal is missing") }
        terminal.enqueue(Data("printf '\\033[32mCANDIDATE_%s 中文\\033[0m\\n' INSTALLED\r".utf8))
        try await TerminalSmoke.wait("Render output through the installed helper and bridge") { terminal.text.contains("CANDIDATE_INSTALLED 中文") && terminal.view.window === window }
        let name = "candidate-installed-native-window.png"
        try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name))
        report["captures"] = [name]; report["installedHelperPTYAndUnicodeOutput"] = true
        report["helperPath"] = Bundle.main.resourceURL?.appendingPathComponent("bin/utermd-local").path
        report["sessionID"] = terminal.id; report["generation"] = terminal.generation
        await model.closeSession()
        guard model.state?.sessions.isEmpty == true, try await bridge.call("host.status")["sessions"].array.isEmpty else { throw BridgeFailure(code: "CANDIDATE_CLOSE", message: "Installed helper retained a closed fixture PTY") }
        _ = try await bridge.call("host.shutdownIdle")
        report["explicitFixtureCloseAndIdleHostShutdown"] = true
    }
}
