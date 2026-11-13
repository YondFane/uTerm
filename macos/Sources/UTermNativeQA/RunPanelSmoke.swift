import AppKit
import UTermBridge

@MainActor
enum RunPanelSmoke {
    static func run(model: WorkspaceModel, panel: NativeWorkspacePanels.Panel, window: NSWindow, prefix: String, evidence: URL) async throws -> [String: Any] {
        guard let kind = panel.runKind, let root = window.contentView else { throw BridgeFailure(code: "RUN_DOCK_QA", message: "Missing actual run panel") }
        let available = Double(root.bounds.height) - Double(model.toolbarHeight)
        let viewport = Double(root.bounds.height)
        func layout() -> RunPanelLayout { model.panels.runLayout(panel, available: available, viewport: viewport) }
        func task() -> TerminalSession? { (panel.controller as? JavaWindow)?.model.terminal ?? (panel.controller as? PythonWindow)?.model.terminal }
        let originalTask = task(), originalGeneration = originalTask?.generation, originalFollow = originalTask?.taskLogFollowsOutput
        func wait(_ label: String, until condition: @escaping @MainActor () -> Bool) async throws {
            do { try await TerminalSmoke.wait(label, until: condition) }
            catch {
                let host = panel.view.superview
                try? await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent(prefix + "-dock-failure.png"))
                let details = "expected=\(layout().height), min=\(layout().minimum), max=\(layout().maximum), available=\(available), viewport=\(viewport), toolbar=\(model.toolbarHeight), expanded=\(model.panels.runExpanded(panel.id)), window=\(NSStringFromRect(root.bounds)), host=\(host.map { NSStringFromRect($0.bounds) } ?? "missing"), content=\(NSStringFromRect(panel.view.bounds)), mounted=\(panel.view.window === window)"
                throw BridgeFailure(code: "RUN_DOCK_QA", message: error.localizedDescription + "; " + details)
            }
        }
        let mainTerminal = model.selectedTerminal, mainGeneration = model.selectedTerminal?.generation
        func view(_ id: String) -> NSView? { TerminalSmoke.descendants(root).first { $0.identifier?.rawValue == id } }
        func bodyFits(_ height: Double) -> Bool {
            guard let host = panel.view.superview, host.identifier?.rawValue == "native-workspace-panel-" + panel.id else { return false }
            return panel.view.window === window && abs(Double(host.bounds.height) - max(0, height - CoreChrome.runPanelHeaderHeight)) < 1
        }
        try await wait("The actual dock uses its bounded default height") { bodyFits(layout().height) }
        guard let resize = view("native-run-panel-resize-" + panel.id), window.makeFirstResponder(resize) else { throw BridgeFailure(code: "RUN_DOCK_QA", message: "Run-panel separator cannot receive native keyboard focus") }
        let initial = layout().height
        try TerminalSmoke.postKey(window: window, code: 126, characters: "\u{F700}")
        let raised = min(layout().maximum, initial + CoreChrome.runPanelResizeStep)
        try await wait("Arrow Up resizes the actual retained panel") { layout().height == raised && bodyFits(raised) }
        try TerminalSmoke.postKey(window: window, code: 115, characters: "\u{F729}")
        try await wait("Home reaches the bounded panel minimum") { layout().height == layout().minimum && bodyFits(layout().height) }
        try TerminalSmoke.postKey(window: window, code: 119, characters: "\u{F72B}")
        try await wait("End reserves space above the actual run panel") { layout().height == layout().maximum && bodyFits(layout().height) }
        try TerminalSmoke.postKey(window: window, code: 125, characters: "\u{F701}")
        try await wait("Arrow Down decreases the actual panel height") { layout().height == max(layout().minimum, layout().maximum - CoreChrome.runPanelResizeStep) && bodyFits(layout().height) }
        let defaultHeight = RunPanelLayout(kind: kind, available: available, viewport: viewport, requested: nil).height
        guard defaultHeight > layout().minimum else { throw BridgeFailure(code: "RUN_DOCK_QA", message: "The QA window is too short to observe a default-height reset") }
        try TerminalSmoke.postKey(window: window, code: 115, characters: "\u{F729}")
        try await wait("Prepare a different height before the reset event") { layout().height == layout().minimum && bodyFits(layout().height) }
        guard let currentResize = view("native-run-panel-resize-" + panel.id) else { throw BridgeFailure(code: "RUN_DOCK_QA", message: "The actual separator disappeared") }
        let point = currentResize.convert(NSPoint(x: currentResize.bounds.midX, y: currentResize.bounds.minY + 1), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 2, pressure: 1) else { throw BridgeFailure(code: "RUN_DOCK_QA", message: "Could not construct the labelled AppKit double-click event") }
            window.sendEvent(event)
        }
        try await wait("An AppKit double-click restores the shared default") { layout().height == defaultHeight && bodyFits(defaultHeight) }
        guard let expand = view("native-run-panel-expand-" + panel.id) as? NSButton else { throw BridgeFailure(code: "RUN_DOCK_QA", message: "Missing actual expand control") }
        expand.performClick(nil)
        try await wait("Actual expand control enlarges the same native view") { model.panels.runExpanded(panel.id) && bodyFits(layout().expandedHeight) }
        let expandedImage = prefix + "-dock-expanded.png"
        try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent(expandedImage))
        guard let restore = view("native-run-panel-expand-" + panel.id) as? NSButton else { throw BridgeFailure(code: "RUN_DOCK_QA", message: "Missing actual restore control") }
        restore.performClick(nil)
        try await wait("Restore retains the previous docked height") { !model.panels.runExpanded(panel.id) && layout().height == defaultHeight && bodyFits(defaultHeight) }
        let restoredImage = prefix + "-dock-restored.png"
        try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent(restoredImage))
        if let originalTask {
            guard task() === originalTask, originalTask.generation == originalGeneration, originalTask.taskLogFollowsOutput == originalFollow,
                  originalTask.view.window === window else { throw BridgeFailure(code: "RUN_DOCK_QA", message: "Dock resizing or expansion replaced the task, log view or follow mode") }
        }
        if let mainTerminal {
            guard model.selectedTerminal === mainTerminal, mainTerminal.generation == mainGeneration, mainTerminal.view.window === window,
                  !mainTerminal.view.isHiddenOrHasHiddenAncestor, mainTerminal.view.bounds.height > 0 else { throw BridgeFailure(code: "RUN_DOCK_QA", message: "Docking replaced or hid the retained main terminal") }
        }
        var proof: [String: Any] = ["passed": true, "nativeKeyboardResize": true, "boundedHomeAndEnd": true, "labelledDoubleClickReset": true,
                                   "actualExpandAndRestore": true, "retainedPanelView": true]
        proof["realTaskPresent"] = originalTask != nil; proof["taskID"] = originalTask?.id ?? ""
        proof["taskGeneration"] = originalGeneration ?? ""; proof["taskAndFollowRetained"] = originalTask != nil
        proof["mainTerminalPresent"] = mainTerminal != nil; proof["mainTerminalRetainedAndVisible"] = mainTerminal != nil
        proof["initialHeight"] = initial; proof["restoredHeight"] = layout().height
        proof["minimum"] = layout().minimum; proof["maximum"] = layout().maximum
        proof["captures"] = [expandedImage, restoredImage]
        proof["input"] = "Actual NSWindow responder/key dispatch, NSButton actions and labelled synthetic AppKit double-click; no physical pointer claim"
        return proof
    }
}
