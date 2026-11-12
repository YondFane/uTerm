import AppKit
import UTermBridge

@MainActor
enum RunPanelParitySmoke {
    static func run(model: WorkspaceModel, window: NSWindow, output: URL, fixture: JSONValue, phase: String, report: inout [String: Any], captures: inout [String]) async throws {
        guard let bridge = model.bridge, let terminal = model.selectedTerminal, let generation = terminal.generation,
              let root = window.contentView else { throw BridgeFailure(code: "RUN_PARITY", message: "Missing retained run-panel fixture") }
        var readRetries = 0
        defer { report["runPanelQAReadOnlyRetries"] = readRetries }
        func snapshot() async throws -> CoreSnapshot {
            for attempt in 1...3 {
                do { return try await bridge.snapshot() }
                catch let failure as BridgeFailure where failure.code == "WRITER_BUSY" {
                    guard attempt < 3 else { throw failure }
                    readRetries += 1
                    try await Task.sleep(for: .milliseconds(100))
                }
            }
            throw BridgeFailure(code: "WRITER_BUSY", message: "Run-panel QA read remained busy")
        }
        let original = try await snapshot(), selected = model.selectedID
        let selectedView = terminal.view
        var scenes: [[String: Any]] = []
        func button(_ id: String) throws -> NSButton {
            guard let button = TerminalSmoke.descendants(root).first(where: { $0.identifier?.rawValue == id }) as? NSButton, button.isEnabled else { throw BridgeFailure(code: "RUN_PARITY", message: "Missing enabled native control: " + id) }
            return button
        }
        func unchanged() async throws {
            let after = try await snapshot()
            guard model.selectedID == selected, model.selectedTerminal === terminal, terminal.generation == generation,
                  terminal.view === selectedView, after.document.workspace == original.document.workspace else { throw BridgeFailure(code: "RUN_PARITY", message: "Run-panel controls changed the retained session or canonical workspace") }
        }
        for scene in fixture["runPanelScenes"].array {
            guard let language = scene["language"].string, let appearance = scene["appearance"].string,
                  let width = scene["width"].number, let height = scene["height"].number else { throw BridgeFailure(code: "RUN_PARITY", message: "Invalid shared run-panel scene") }
            await model.patchSettings(["language": .string(language), "appearance": .string(appearance)])
            _ = try await TerminalSmoke.sizeCaptureWindow(window, width: Int(width), height: Int(height))
            guard let tools = model.inspector.content else { throw BridgeFailure(code: "RUN_PARITY", message: "Missing actual tool switcher") }
            let filesLabel = language == "en" ? "Files" : "文件"
            try await ContentSmoke.wait(tools, "document.querySelector('.inspector-switcher button[aria-label=\"" + filesLabel + "\"]') !== null")
            _ = try await tools.webView.evaluateJavaScript("document.querySelector('.inspector-switcher button[aria-label=\"" + filesLabel + "\"]').click()")
            try await TerminalSmoke.wait("The actual tool switcher mounts Files before run-panel capture") { model.inspector.mode == .files && model.inspector.content?.webView.window === window }
            guard let files = model.inspector.content else { throw BridgeFailure(code: "RUN_PARITY", message: "Actual Files tree did not mount") }
            for entry in fixture["runPanelKinds"].array {
                guard let kind = entry.string, ["java", "python"].contains(kind) else { throw BridgeFailure(code: "RUN_PARITY", message: "Invalid shared run-panel kind") }
                try await TerminalSmoke.wait("Enable the actual run-panel toolbar control") { (TerminalSmoke.descendants(root).first { $0.identifier?.rawValue == "native-project-run-" + kind } as? NSButton)?.isEnabled == true }
                try button("native-project-run-" + kind).performClick(nil)
                try await TerminalSmoke.wait("Mount the actual run-panel toolbar target") {
                    guard let panel = model.panels.active(in: model.inspectorContextKey) else { return false }
                    return panel.runKind == kind && panel.view.window === window
                }
                guard let panel = model.panels.active(in: model.inspectorContextKey) else { throw BridgeFailure(code: "RUN_PARITY", message: "Run panel did not mount") }
                let retained = panel.view
                try await TerminalSmoke.wait("Finish actual run configuration detection") {
                    if let controller = panel.controller as? JavaWindow { return !controller.model.busy && controller.model.config != nil }
                    if let controller = panel.controller as? PythonWindow { return !controller.model.busy && controller.model.config != nil }
                    return false
                }
                func capture(_ state: String) async throws {
                    try await unchanged()
                    guard let current = model.panels.active(in: model.inspectorContextKey), current.id == panel.id,
                          current.view === retained, current.controller === panel.controller, retained.window === window else { throw BridgeFailure(code: "RUN_PARITY", message: "Panel view changed across controls") }
                    let activeFile = model.documents.active(in: model.inspectorContextKey)
                    let fileVisible = activeFile?.content.webView.window === window
                    guard fileVisible == (state == "file"), !fileVisible || activeFile?.content.path == "README.md" else { throw BridgeFailure(code: "RUN_PARITY", message: "Unexpected actual file visibility beside the run panel") }
                    try await Task.sleep(for: .milliseconds(200))
                    guard let measured = TerminalSmoke.descendants(root).first(where: { $0.identifier?.rawValue == "native-run-panel-frame-" + panel.id }) else { throw BridgeFailure(code: "RUN_PARITY", message: "Missing actual native panel frame") }
                    let bounds = measured.convert(measured.bounds, to: root)
                    let top = root.isFlipped ? bounds.minY : root.bounds.height - bounds.maxY
                    guard bounds.minX >= 0, bounds.width > 0, bounds.height > 0, top >= 0, top + bounds.height <= root.bounds.height + 0.5, bounds.maxX <= root.bounds.width + 0.5 else { throw BridgeFailure(code: "RUN_PARITY", message: "Run panel extends outside the actual workspace") }
                    let name = "personal-\(phase)-run-\(kind)-\(state)-\(language)-\(appearance)-\(Int(width)).png"
                    try await TerminalSmoke.capture(window: window, path: output.appendingPathComponent(name)); captures.append(name)
                    var row: [String: Any] = ["kind": kind, "state": state, "language": language, "appearance": appearance, "width": Int(width), "height": Int(height), "screenshot": name,
                        "passed": true, "actualToolbarButton": true, "actualExpandAndRestore": true, "retainedPanelView": true, "terminalGenerationRetained": true, "canonicalWorkspaceRetained": true,
                        "fileVisible": fileVisible, "panelLeft": bounds.minX, "panelTop": top, "panelWidth": bounds.width, "panelHeight": bounds.height]
                    for key in ["sourceHeadSHA", "testedMergeSHA", "platform", "architecture", "system"] { row[key] = report[key] }
                    scenes.append(row); report["runPanelScenes"] = scenes
                }
                try button("native-run-panel-expand-" + panel.id).performClick(nil)
                try await TerminalSmoke.wait("Expand the retained run panel") { model.panels.runExpanded(panel.id) }
                try button("native-run-panel-expand-" + panel.id).performClick(nil)
                try await TerminalSmoke.wait("Restore before recording verified expand/restore controls") { !model.panels.runExpanded(panel.id) }
                try button("native-run-panel-expand-" + panel.id).performClick(nil)
                try await TerminalSmoke.wait("Expand again for the original screenshot") { model.panels.runExpanded(panel.id) }
                try await capture("expanded")
                try button("native-run-panel-expand-" + panel.id).performClick(nil)
                try await TerminalSmoke.wait("Restore the retained run panel") { !model.panels.runExpanded(panel.id) }
                try await capture("docked")
                try await ContentSmoke.wait(files, "document.querySelector('.file-row[data-path=\"README.md\"]') !== null")
                _ = try await files.webView.evaluateJavaScript("document.querySelector('.file-row[data-path=\"README.md\"]').click()")
                try await TerminalSmoke.wait("The actual Files row opens beside the retained run panel") {
                    model.documents.active(in: model.inspectorContextKey)?.content.path == "README.md" && model.panels.active(in: model.inspectorContextKey)?.id == panel.id && retained.window === window
                }
                guard let document = model.documents.active(in: model.inspectorContextKey) else { throw BridgeFailure(code: "RUN_PARITY", message: "README did not open") }
                try await ContentSmoke.wait(document.content, "document.querySelector('.file-editor') !== null")
                try await capture("file")
                try button("native-file-close-" + document.id.uuidString).performClick(nil)
                try await TerminalSmoke.wait("Close the actual clean file while retaining the run panel") { model.documents.active(in: model.inspectorContextKey) == nil && retained.window === window }
                try button("native-run-panel-hide-" + panel.id).performClick(nil)
                try await TerminalSmoke.wait("The actual hide button closes only this run panel") { !model.panels.panels.contains { $0.id == panel.id } }
                try await unchanged()
            }
        }
        report["runPanelActualFileCloseAndHideVerified"] = true
    }
}
