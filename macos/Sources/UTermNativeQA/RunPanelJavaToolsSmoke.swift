import AppKit
import UTermBridge

@MainActor
enum RunPanelJavaToolsSmoke {
    static func run(model: WorkspaceModel, window: NSWindow, panel: NativeWorkspacePanels.Panel, evidence: URL, phase: String, scene: JSONValue, readSnapshot: @MainActor () async throws -> CoreSnapshot, report: inout [String: Any], captures: inout [String]) async throws {
        guard let controller = panel.controller as? JavaWindow, let config = controller.model.config,
              !controller.model.busy, let root = window.contentView,
              let language = scene["language"].string, let appearance = scene["appearance"].string,
              let width = scene["width"].number else { throw BridgeFailure(code: "JAVA_TOOLS_QA", message: "Missing retained Java run configuration") }
        let run = controller.model, selected = model.selectedID, generation = model.selectedTerminal?.generation
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let originalArguments = run.arguments, originalDirty = run.dirty
        defer { run.arguments = originalArguments; run.dirty = originalDirty }
        run.arguments.append(JavaArgument(text: "retained tools draft 中文 & %PATH%")); run.dirty = true
        let configBytes = try encoder.encode(config), globalBytes = try encoder.encode(run.global)
        let arguments = run.arguments.map(\.text), vmArguments = run.vmArguments.map(\.text), environment = run.environment.map { [$0.key, $0.value] }
        let detection = run.qaCompletedDetections
        let before = try await readSnapshot()
        let identifier = "native-run-panel-java-tools-" + panel.id
        func button() -> NSButton? { TerminalSmoke.descendants(root).first { $0.identifier?.rawValue == identifier } as? NSButton }
        try await TerminalSmoke.wait("Enable the actual Java run tools button") { button()?.isEnabled == true }
        guard let tools = button() else { throw BridgeFailure(code: "JAVA_TOOLS_QA", message: "Missing actual Java tools control") }
        run.busy = true
        do {
            try await TerminalSmoke.wait("Disable Java tools during the injected busy state") { button()?.isEnabled == false }
            guard let action = tools.action else { throw BridgeFailure(code: "JAVA_TOOLS_QA", message: "Missing Java tools action") }
            _ = NSApp.sendAction(action, to: tools.target, from: tools)
            guard !model.settingsPresented else { throw BridgeFailure(code: "JAVA_TOOLS_QA", message: "A disabled Java tools action bypassed the busy guard") }
        } catch { run.busy = false; throw error }
        run.busy = false
        try await TerminalSmoke.wait("Re-enable Java tools after the injected busy state") { button()?.isEnabled == true }
        tools.performClick(nil)
        try await TerminalSmoke.wait("Open the actual Java development settings over the workspace") { model.settingsPresented && window.childWindows?.contains { $0.identifier?.rawValue == "native-full-settings" && $0.isVisible } == true }
        guard let settings = window.childWindows?.first(where: { $0.identifier?.rawValue == "native-full-settings" })?.delegate as? NativeSettingsWindow,
              settings.model.section == "java" else { throw BridgeFailure(code: "JAVA_TOOLS_QA", message: "Java tools opened a different settings section") }
        try await TerminalSmoke.wait("Load the actual managed Java tool catalog") {
            !settings.model.busy && !settings.model.automaticSaving && !settings.model.javaComponents.loading && settings.model.javaComponents.catalog != .null && settings.window.contentView.map { TerminalSmoke.descendants($0).contains { $0.identifier?.rawValue == "native-java-detect" && ($0 as? NSButton)?.isEnabled == true } } == true
        }
        guard settings.model.error.isEmpty, settings.model.javaComponents.error.isEmpty,
              Set(settings.model.javaComponents.catalog["items"].array.compactMap { $0["id"].string }) == Set(["jdk-8", "jdk-11", "jdk-17", "jdk-21", "maven"]) else { throw BridgeFailure(code: "JAVA_TOOLS_QA", message: "Java tools did not mount the complete shared catalog") }
        let name = "personal-\(phase)-java-tools-\(language)-\(appearance)-\(Int(width)).png"
        try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(name)); captures.append(name)
        guard let content = settings.window.contentView,
              let close = TerminalSmoke.descendants(content).first(where: { $0.identifier?.rawValue == "native-settings-close" }) as? NSButton,
              close.isEnabled else { throw BridgeFailure(code: "JAVA_TOOLS_QA", message: "Missing actual Java settings close control") }
        close.performClick(nil)
        try await TerminalSmoke.wait("Close Java settings and complete fresh project detection") { !model.settingsPresented && !run.busy && run.qaCompletedDetections > detection }
        let after = try await readSnapshot()
        guard run.error.isEmpty, try encoder.encode(run.config) == configBytes, try encoder.encode(run.global) == globalBytes,
              run.arguments.map(\.text) == arguments, run.vmArguments.map(\.text) == vmArguments,
              run.environment.map({ [$0.key, $0.value] }) == environment, run.dirty,
              model.selectedID == selected, model.selectedTerminal?.generation == generation,
              model.panels.active(in: model.inspectorContextKey)?.id == panel.id, panel.view.window === window,
              after.document.workspace == before.document.workspace, after.document.settings == before.document.settings else { throw BridgeFailure(code: "JAVA_TOOLS_QA", message: "Java tools replaced configuration, panel or canonical workspace state") }
        var proof: [String: Any] = ["language": language, "appearance": appearance, "width": Int(width), "height": Int(scene["height"].number ?? 0), "screenshot": name,
            "passed": true, "actualManageToolsButton": true, "busyStateInjectedForQA": true, "busyActionRejected": true,
            "argumentDraftInjectedForQA": true, "argumentDraftRetained": true,
            "actualSharedJavaCatalog": true, "actualCloseControl": true, "projectDetectionCompletedAfterClose": true,
            "runConfigurationAndPanelRetained": true, "terminalGenerationRetained": true, "canonicalStateUnchanged": true]
        for key in ["sourceHeadSHA", "testedMergeSHA", "platform", "architecture", "system"] { proof[key] = report[key] }
        var proofs = report["runPanelJavaToolsProof"] as? [[String: Any]] ?? []; proofs.append(proof); report["runPanelJavaToolsProof"] = proofs
    }
}
