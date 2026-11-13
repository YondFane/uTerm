import AppKit
import UTermBridge

@MainActor
enum ProjectRunSmoke {
    static func restoreStandalone(model: WorkspaceModel, panel: NativeWorkspacePanels.Panel) async throws {
        guard let backing = panel.controller.window else { throw BridgeFailure(code: "RUN_PANEL", message: "The retained panel window is missing") }
        model.panels.remove(panel.controller)
        try await Task.sleep(for: .milliseconds(100))
        panel.view.removeFromSuperview()
        panel.view.translatesAutoresizingMaskIntoConstraints = true
        panel.view.autoresizingMask = [.width, .height]
        backing.contentView = panel.view
        panel.controller.showWindow(nil); backing.makeKeyAndOrderFront(nil)
        try await Task.sleep(for: .milliseconds(100))
        try await TerminalSmoke.wait("Restore the exact panel content to its standalone QA window") { backing.contentView === panel.view && panel.view.window === backing && backing.isVisible }
    }
    static func run(model: WorkspaceModel, language: String, controller: NSWindowController, task: JSONValue, evidence: URL, report: inout [String: Any]) async throws {
        guard let id = task["spec"]["id"].string, let generation = task["generation"].string,
              let backing = controller.window,
              let retainedView = (controller as? NativeWorkspacePanelContent)?.workspacePanelView else { throw BridgeFailure(code: "RUN_LIST", message: "Missing live task or retained panel view") }
        let backingHadContent = backing.contentView != nil
        backing.contentView = nil
        await model.projectRuns.refresh()
        guard model.projectRuns.error.isEmpty else { throw BridgeFailure(code: "RUN_LIST", message: model.projectRuns.error) }
        guard model.projectRuns.tasks(language).contains(where: { $0["spec"]["id"].string == id && $0["generation"].string == generation }) else { throw BridgeFailure(code: "RUN_LIST", message: "Shared run discovery missed the actual host task") }
        let identifier = "native-project-run-" + language
        func mountedButton() -> NSButton? {
            NSApp.windows.compactMap { window -> NSButton? in
                guard let content = window.contentView else { return nil }
                return TerminalSmoke.descendants(content).first { $0.identifier?.rawValue == identifier && ($0 as? NSButton)?.isEnabled == true } as? NSButton
            }.first
        }
        try await TerminalSmoke.wait("Actual toolbar launch control is enabled") { mountedButton() != nil }
        guard let origin = mountedButton(), let coordinator = origin.target as? NativeProjectRunButton.Coordinator,
              origin.window?.isVisible == true else { throw BridgeFailure(code: "RUN_LIST", message: "Missing mounted toolbar coordinator") }
        let menu = coordinator.menu()
        defer { withExtendedLifetime((coordinator, menu)) {} }
        guard let index = menu.items.firstIndex(where: { ($0.representedObject as? JSONValue)?["spec"]["id"].string == id }) else { throw BridgeFailure(code: "RUN_LIST", message: "Native launch menu missed the live task") }
        let item = menu.items[index]
        guard let action = item.action, item.target === coordinator, item.isEnabled else { throw BridgeFailure(code: "RUN_LIST", message: "Launch menu action is not bound to the mounted toolbar") }
        let scope = model.inspectorContextKey
        guard case .object(var stale) = task else { throw BridgeFailure(code: "RUN_LIST", message: "Invalid task fixture") }
        stale["generation"] = .string("stale-generation")
        let staleItem = NSMenuItem(title: item.title, action: action, keyEquivalent: "")
        staleItem.target = coordinator; staleItem.representedObject = JSONValue.object(stale)
        guard NSApp.sendAction(action, to: coordinator, from: staleItem) else { throw BridgeFailure(code: "RUN_LIST", message: "AppKit did not dispatch stale launch selection") }
        try await TerminalSmoke.wait("Stale launch-menu generation is rejected") { model.error.contains("TASK_STALE") }
        guard model.inspectorContextKey == scope else { throw BridgeFailure(code: "RUN_LIST", message: "Stale task selection changed the project") }
        model.error = ""
        guard NSApp.sendAction(action, to: item.target, from: item) else { throw BridgeFailure(code: "RUN_LIST", message: "AppKit did not dispatch the actual launch action") }
        do {
            try await TerminalSmoke.wait("Actual launch-menu action reveals its retained main-window panel") { !model.error.isEmpty || model.panels.panels.contains { $0.controller === controller && $0.view.window?.isVisible == true && $0.view.window !== backing } }
            guard model.error.isEmpty else { throw BridgeFailure(code: "RUN_LIST", message: model.error) }
        } catch {
            let mounted: [[String: Any]] = model.panels.panels.map { ["id": $0.id, "scope": $0.scope, "matchesController": $0.controller === controller, "windowNumber": $0.view.window?.windowNumber ?? -1, "visible": $0.view.window?.isVisible == true] }
            report[language + "LaunchSelectionDiagnostics"] = ["operationError": model.error, "busy": model.busy,
                "taskRoot": task["task"]["root"].string ?? "", "scope": model.inspectorContextKey,
                "selectedProject": model.workspace["selectedProject"].string ?? "", "selectedWorktree": model.workspace["selectedWorktree"].string ?? "", "panels": mounted, "selectionTrace": model.projectRuns.selectionTrace,
                "backingHasContent": backing.contentView != nil, "backingVisible": backing.isVisible,
                "backingContentClass": backing.contentView.map { NSStringFromClass(type(of: $0)) } ?? ""]
            throw error
        }
        guard let panel = model.panels.panels.first(where: { $0.controller === controller }), let window = panel.view.window else { throw BridgeFailure(code: "RUN_LIST", message: "No mounted run panel") }
        guard panel.view === retainedView else { throw BridgeFailure(code: "RUN_LIST", message: "Launch selection replaced the retained panel view") }
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
        try await restoreStandalone(model: model, panel: panel)
        var proof: [String: Any] = ["passed": true, "realHostTask": true, "actualMenuAction": true, "actualToolbarCoordinator": true,
            "appKitActionDispatched": true, "staleGenerationRejected": true, "scopeRetainedOnRejection": true, "sameTaskGeneration": true,
            "actualMainWindow": true, "actualToggleButtonRetainedGeneration": true, "retainedContentAfterBackingWindowCleared": true,
            "backingHadContentBeforeQA": backingHadContent]
        proof["screenshot"] = screenshot
        proof["input"] = "NSApplication.sendAction using the mounted toolbar coordinator and actual NSMenuItem; explicit backing content removal reproduces the observed loss; real Core host task; no physical popup pointer/keyboard claim"
        report[language + "ToolbarRunList"] = proof
    }
}
