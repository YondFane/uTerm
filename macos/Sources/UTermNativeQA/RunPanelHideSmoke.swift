import AppKit
import UTermBridge

@MainActor
enum RunPanelHideSmoke {
    static func run(model: WorkspaceModel, panel: NativeWorkspacePanels.Panel, window: NSWindow, evidence: URL) async throws -> [String: Any] {
        guard let kind = panel.runKind, let bridge = model.bridge, let root = window.contentView else {
            throw BridgeFailure(code: "RUN_HIDE_QA", message: "Missing actual docked run panel")
        }
        let java = (panel.controller as? JavaWindow)?.model
        let python = (panel.controller as? PythonWindow)?.model
        guard let directory = java?.directory ?? python?.directory else {
            throw BridgeFailure(code: "RUN_HIDE_QA", message: "Missing exact run configuration directory")
        }
        func state() -> (busy: Bool, dirty: Bool, error: String, arguments: [String]) {
            if let java { return (java.busy, java.dirty, java.error, java.arguments.map(\.text)) }
            return (python!.busy, python!.dirty, python!.error, python!.arguments.map(\.text))
        }
        func draft(_ arguments: [String]) {
            if let java { java.arguments = arguments.map { JavaArgument(text: $0) }; java.dirty = true; java.error = "" }
            if let python { python.arguments = arguments.map { PythonArgument(text: $0) }; python.dirty = true; python.error = "" }
        }
        func hide() throws {
            guard let button = TerminalSmoke.descendants(root).first(where: { $0.identifier?.rawValue == "native-run-panel-hide-" + panel.id }) as? NSButton, button.isEnabled else {
                throw BridgeFailure(code: "RUN_HIDE_QA", message: "Missing actual enabled Hide run panel button")
            }
            button.performClick(nil)
        }
        func configuration() async throws -> JSONValue {
            try await bridge.call(kind + ".configuration", params: .object(["directory": .string(directory)]))
        }
        try await TerminalSmoke.wait("Load the actual docked configuration before hide checks") { !state().busy }
        guard !state().dirty, state().error.isEmpty else { throw BridgeFailure(code: "RUN_HIDE_QA", message: "Expected an initially clean, error-free run configuration: " + state().error) }
        let original = try await configuration()
        guard case .object(var peerProject) = original["project"] else { throw BridgeFailure(code: "RUN_HIDE_QA", message: "Missing persisted project configuration") }
        let peerArguments = ["QA_PEER_" + kind + " 中文"]
        let draftArguments = ["QA_HIDE_" + kind + " literal & 中文"]
        let conflictCode = kind == "java" ? "JAVA_CONFIG_CONFLICT" : "PYTHON_CONFIG_CONFLICT"
        peerProject["arguments"] = .array(peerArguments.map(JSONValue.string))
        let projectKey = kind == "java" ? "project" : "config"
        var params: [String: JSONValue] = ["directory": .string(directory), "revision": original["revision"], projectKey: .object(peerProject)]
        if kind == "java" { params["global"] = original["global"] }
        let peer = try await bridge.call(kind + ".saveConfiguration", params: .object(params))
        func peerUnchanged() async throws -> Bool {
            let current = try await configuration()
            return current["revision"] == peer["revision"] && current["project"] == peer["project"]
                && (kind != "java" || current["global"] == peer["global"])
        }
        try hide()
        try await TerminalSmoke.wait("A clean stale configuration refuses the actual hide action") { !state().busy && !state().error.isEmpty }
        guard model.panels.active(in: model.inspectorContextKey)?.id == panel.id, panel.view.window === window,
              !state().dirty, state().error.contains(conflictCode), try await peerUnchanged() else {
            throw BridgeFailure(code: "RUN_HIDE_QA", message: "Clean stale hide lost the panel or peer configuration: " + state().error)
        }
        draft(draftArguments)
        try hide()
        try await TerminalSmoke.wait("A dirty stale configuration refuses the actual hide action") { !state().busy && !state().error.isEmpty }
        guard model.panels.active(in: model.inspectorContextKey)?.id == panel.id, panel.view.window === window,
              state().dirty, state().arguments == draftArguments, state().error.contains(conflictCode), try await peerUnchanged() else {
            throw BridgeFailure(code: "RUN_HIDE_QA", message: "Dirty stale hide lost the draft, peer value or panel: " + state().error)
        }
        let screenshot = "native-workspace-" + kind + "-hide-conflict.png"
        try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent(screenshot))
        // This explicit fixture reload accepts the peer revision; failed application writes never retry.
        // 此处明确重读测试配置以接受对端修订，应用写入失败不会自动重试。
        if let java { await java.reload() }
        if let python { await python.reload() }
        guard !state().busy, !state().dirty, state().arguments == peerArguments else {
            throw BridgeFailure(code: "RUN_HIDE_QA", message: "Explicit fixture reload did not accept the peer configuration")
        }
        draft(draftArguments)
        try hide()
        try await TerminalSmoke.wait("The actual hide action saves the draft and closes its panel") { !model.panels.panels.contains { $0.id == panel.id } }
        let saved = try await configuration()
        guard saved["project"]["arguments"] == .array(draftArguments.map(JSONValue.string)), saved["revision"] != peer["revision"],
              kind != "java" || saved["global"] == peer["global"] else {
            throw BridgeFailure(code: "RUN_HIDE_QA", message: "Successful hide did not persist the exact draft")
        }
        return ["passed": true, "actualHideButton": true, "cleanStaleHideRefused": true, "dirtyStaleHideRefused": true,
                "draftRetained": true, "peerValueRetained": true, "explicitFixtureReload": true, "savedDraftAfterReload": true,
                "draftInjectedForQA": true, "failedHideAttempts": 2, "directory": directory, "screenshot": screenshot,
                "input": "Actual native Hide button; explicitly injected QA draft and peer Core write, no physical text-input claim"]
    }
}
