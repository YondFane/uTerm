import AppKit
import UTermBridge

@MainActor
enum ProjectRunSmoke {
    static func run(model: WorkspaceModel, language: String, controller: NSWindowController, task: JSONValue, evidence: URL, report: inout [String: Any]) async throws {
        guard let id = task["spec"]["id"].string, let generation = task["generation"].string,
              let backing = controller.window else { throw BridgeFailure(code: "RUN_LIST", message: "Missing live task") }
        await model.projectRuns.refresh()
        guard model.projectRuns.tasks(language).contains(where: { $0["spec"]["id"].string == id && $0["generation"].string == generation }) else { throw BridgeFailure(code: "RUN_LIST", message: "Shared run discovery missed the actual host task") }
        let coordinator = NativeProjectRunButton.Coordinator(model: model, language: language)
        let menu = coordinator.menu()
        guard let index = menu.items.firstIndex(where: { ($0.representedObject as? JSONValue)?["spec"]["id"].string == id }) else { throw BridgeFailure(code: "RUN_LIST", message: "Native launch menu missed the live task") }
        let scope = model.inspectorContextKey
        guard case .object(var stale) = task else { throw BridgeFailure(code: "RUN_LIST", message: "Invalid task fixture") }
        stale["generation"] = .string("stale-generation")
        model.revealProjectRunRequested?(language, .object(stale))
        try await TerminalSmoke.wait("Stale launch-menu generation is rejected") { model.error.contains("TASK_STALE") }
        guard model.inspectorContextKey == scope else { throw BridgeFailure(code: "RUN_LIST", message: "Stale task selection changed the project") }
        model.error = ""
        withExtendedLifetime(coordinator) { menu.performActionForItem(at: index) }
        try await TerminalSmoke.wait("Actual launch-menu action reveals its retained main-window panel") { model.panels.panels.contains { $0.controller === controller && $0.view.window?.isVisible == true && $0.view.window !== backing } }
        guard let panel = model.panels.panels.first(where: { $0.controller === controller }), let window = panel.view.window else { throw BridgeFailure(code: "RUN_LIST", message: "No mounted run panel") }
        let terminal = (controller as? JavaWindow)?.model.terminal ?? (controller as? PythonWindow)?.model.terminal
        guard terminal?.id == id, terminal?.generation == generation else { throw BridgeFailure(code: "RUN_LIST", message: "Launch selection replaced the task generation") }
        let screenshot = "native-" + language + "-launch-list-workspace.png"
        try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent(screenshot))
        guard let content = window.contentView else { throw BridgeFailure(code: "RUN_LIST", message: "Missing actual workspace view") }
        try await TerminalSmoke.wait("Toolbar run toggle becomes enabled after task selection") {
            (TerminalSmoke.descendants(content).first { $0.identifier?.rawValue == "native-project-run-" + language } as? NSButton)?.isEnabled == true
        }
        guard let toggle = TerminalSmoke.descendants(content).first(where: { $0.identifier?.rawValue == "native-project-run-" + language }) as? NSButton else { throw BridgeFailure(code: "RUN_LIST", message: "Missing actual toolbar run button") }
        toggle.performClick(nil)
        try await TerminalSmoke.wait("Clicking the active toolbar run button returns to the terminal") { model.panels.active(in: model.inspectorContextKey) == nil }
        guard terminal?.id == id, terminal?.generation == generation else { throw BridgeFailure(code: "RUN_LIST", message: "Hiding the run panel replaced its task") }
        toggle.performClick(nil)
        try await TerminalSmoke.wait("Clicking again reopens the exact run panel") { model.panels.active(in: model.inspectorContextKey)?.id == panel.id && panel.view.window === window }
        model.panels.remove(controller); backing.contentView = panel.view
        controller.showWindow(nil); backing.makeKeyAndOrderFront(nil)
        report[language + "ToolbarRunList"] = ["passed": true, "realHostTask": true, "actualMenuAction": true, "staleGenerationRejected": true, "scopeRetainedOnRejection": true, "sameTaskGeneration": true, "actualMainWindow": true, "actualToggleButtonRetainedGeneration": true, "screenshot": screenshot, "input": "Automated NSMenu action and real Core host task; no physical popup pointer/keyboard claim"]
    }
}
