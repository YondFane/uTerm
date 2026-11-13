import AppKit
import UTermBridge

@MainActor
enum RunPanelFormSmoke {
    static func run(model: WorkspaceModel, window: NSWindow, panel: NativeWorkspacePanels.Panel, evidence: URL, phase: String, scene: JSONValue, input: JSONValue,
                    readSnapshot: @MainActor () async throws -> CoreSnapshot, report: inout [String: Any], captures: inout [String]) async throws {
        guard let kind = panel.runKind, let root = window.contentView,
              let language = scene["language"].string, let appearance = scene["appearance"].string, let width = scene["width"].number else {
            throw BridgeFailure(code: "RUN_FORM_QA", message: "Missing actual run form")
        }
        let before = try await readSnapshot(), selected = model.selectedID, generation = model.selectedTerminal?.generation
        let java = (panel.controller as? JavaWindow)?.model, python = (panel.controller as? PythonWindow)?.model
        func view(_ suffix: String) -> NSView? { TerminalSmoke.descendants(root).first { $0.identifier?.rawValue == "native-" + kind + "-" + suffix } }
        func button(_ suffix: String) async throws -> NSButton {
            try await TerminalSmoke.wait("Attach and enable the actual run form action: " + suffix) {
                guard let control = view(suffix) as? NSButton else { return false }
                return control.isEnabled && control.window === window && !control.isHiddenOrHasHiddenAncestor
            }
            guard let control = view(suffix) as? NSButton, control.isEnabled, control.window === window else { throw BridgeFailure(code: "RUN_FORM_QA", message: "Missing attached, enabled run form control: " + suffix) }
            _ = control.scrollToVisible(control.bounds)
            return control
        }
        guard let bridge = java?.bridge ?? python?.bridge, let directory = java?.directory ?? python?.directory,
              let literal = input["arguments"].string, let invalid = input["invalidArguments"].string,
              let environment = input["environment"].string, let vmInput = input["vmArguments"].string else {
            throw BridgeFailure(code: "RUN_FORM_QA", message: "Missing shared literal input fixture")
        }
        let originalArguments = java?.argumentInput ?? python?.argumentInput ?? ""
        let originalEnvironment = java?.environmentInput ?? python?.environmentInput ?? ""
        let originalVM = java?.vmArgumentInput ?? ""
        func configuration() async throws -> JSONValue {
            try await bridge.call(kind + ".configuration", params: .object(["directory": .string(directory)]))
        }
        func enter(_ suffix: String, _ text: String) async throws {
            try await TerminalSmoke.wait("Attach the actual run form editor: " + suffix) { view(suffix)?.window === window }
            guard let actual = view(suffix) else { throw BridgeFailure(code: "RUN_FORM_QA", message: "Missing run form editor") }
            _ = actual.scrollToVisible(actual.bounds); window.makeKeyAndOrderFront(nil)
            let editor: NSTextView
            if let field = actual as? NSTextField {
                guard window.makeFirstResponder(field), let active = field.currentEditor() as? NSTextView else { throw BridgeFailure(code: "RUN_FORM_QA", message: "Could not focus the actual run field editor") }
                editor = active
            } else if let active = actual as? NSTextView, window.makeFirstResponder(active) { editor = active }
            else { throw BridgeFailure(code: "RUN_FORM_QA", message: "Could not focus the actual run text editor") }
            editor.insertText(text, replacementRange: NSRange(location: 0, length: (editor.string as NSString).length))
            try await TerminalSmoke.wait("Apply actual run editor input") {
                if suffix == "environment" { return (java?.environmentInput ?? python?.environmentInput) == text }
                if suffix == "vm-arguments" { return java?.vmArgumentInput == text }
                return (java?.argumentInput ?? python?.argumentInput) == text
            }
        }
        func saveAndWait(expectError: Bool = false) async throws {
            // Previous feedback must not complete the next awaited control action.
            // 旧反馈不能被当成下一次控件操作的完成结果。
            if let java { java.feedback = ""; java.error = "" }; if let python { python.feedback = ""; python.error = "" }
            try await button("save-configuration").performClick(nil)
            try await TerminalSmoke.wait("Complete the actual Save configuration callback") {
                if let java { return !java.busy && (!java.feedback.isEmpty || !java.error.isEmpty) }
                if let python { return !python.busy && (!python.feedback.isEmpty || !python.error.isEmpty) }
                return false
            }
            let error = java?.error ?? python?.error ?? "Missing model"
            guard expectError ? !error.isEmpty : error.isEmpty else { throw BridgeFailure(code: "RUN_FORM_QA", message: error.isEmpty ? "Invalid argument was saved" : error) }
        }
        let fields = kind == "java" ? ["module", "mode", "version"] : ["interpreter", "mode", "target"]
        let columns = RunPanelLayout.formColumns(viewportWidth: Double(root.bounds.width))
        let fullInterpreter = kind == "python" && RunPanelLayout.interpreterFillsRow(viewportWidth: Double(root.bounds.width))
        func measuredFields() -> [CGRect] {
            fields.compactMap { field in
                guard let actual = view("field-" + field), actual.window === window else { return nil }
                let rect = actual.convert(actual.bounds, to: panel.view)
                return CGRect(x: rect.minX, y: panel.view.isFlipped ? rect.minY : panel.view.bounds.height - rect.maxY, width: rect.width, height: rect.height)
            }
        }
        func measuredGrid() -> CGRect? {
            guard let actual = view("primary-grid"), actual.window === window else { return nil }
            let rect = actual.convert(actual.bounds, to: panel.view)
            return CGRect(x: rect.minX, y: panel.view.isFlipped ? rect.minY : panel.view.bounds.height - rect.maxY, width: rect.width, height: rect.height)
        }
        let backingScale = Double(window.backingScaleFactor)
        func responsiveFieldsMatch() -> Bool {
            let frames = measuredFields()
            guard let grid = measuredGrid(), grid.minX >= 0, grid.maxX <= panel.view.bounds.width + 0.5,
                  frames.allSatisfy({ $0.minX >= 0 && $0.maxX <= panel.view.bounds.width + 0.5 }) else { return false }
            return RunPanelLayout.formGridMatches(grid, fields: frames, columns: columns, interpreterFullRow: fullInterpreter, scale: backingScale)
        }
        _ = try await button("configuration-toggle")
        do {
            try await TerminalSmoke.wait("Apply the actual wide or narrow run form layout") { responsiveFieldsMatch() }
        } catch {
            var diagnostic: [String: Any] = [:]
            diagnostic["kind"] = kind; diagnostic["viewportWidth"] = Double(root.bounds.width)
            diagnostic["panelWidth"] = Double(panel.view.bounds.width); diagnostic["panelHeight"] = Double(panel.view.bounds.height)
            diagnostic["columnCount"] = columns; diagnostic["interpreterFullRow"] = fullInterpreter
            diagnostic["configurationToggleAttached"] = view("configuration-toggle")?.window === window
            diagnostic["fieldFrames"] = measuredFields().map { ["left": Double($0.minX), "top": Double($0.minY), "width": Double($0.width), "height": Double($0.height)] }
            diagnostic["backingScale"] = backingScale
            if let grid = measuredGrid() { diagnostic["formGridFrame"] = ["left": Double(grid.minX), "top": Double(grid.minY), "width": Double(grid.width), "height": Double(grid.height)] }
            report["runPanelFormLayoutDiagnostics"] = diagnostic
            throw error
        }
        var frames: [[String: Any]] = []
        for (field, rect) in zip(fields, measuredFields()) {
            frames.append(["id": field, "left": Double(rect.minX), "top": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)])
        }
        guard let grid = measuredGrid() else { throw BridgeFailure(code: "RUN_FORM_QA", message: "Actual run form grid is detached") }
        let gridFrame = ["left": Double(grid.minX), "top": Double(grid.minY), "width": Double(grid.width), "height": Double(grid.height)]
        try await button("advanced-toggle").performClick(nil)
        try await TerminalSmoke.wait("Mount the actual advanced Save configuration action") { (view("save-configuration") as? NSButton)?.isEnabled == true }
        let save = try await button("save-configuration"), saveRect = save.convert(save.bounds, to: panel.view)
        let inset = panel.view.bounds.maxX - saveRect.maxX
        guard abs(saveRect.height - 28) < 1, saveRect.width > 0, saveRect.width < 200, inset >= 0, inset <= 40 else {
            throw BridgeFailure(code: "RUN_FORM_QA", message: "Save configuration is stretched or not aligned to the right")
        }
        let configurationBefore = try await configuration()
        try await enter("arguments", invalid)
        try await saveAndWait(expectError: true)
        let invalidAfter = try await configuration()
        guard (java?.argumentInput ?? python?.argumentInput) == invalid,
              invalidAfter["revision"] == configurationBefore["revision"], invalidAfter["project"] == configurationBefore["project"] else {
            throw BridgeFailure(code: "RUN_FORM_QA", message: "Invalid argument input was discarded or changed saved configuration")
        }
        try await enter("arguments", literal); try await enter("environment", environment)
        if java != nil { try await enter("vm-arguments", vmInput) }
        try await saveAndWait()
        let saved = try await configuration()
        guard saved["project"]["arguments"] == input["argumentValues"],
              (java?.argumentInput ?? python?.argumentInput) == literal,
              java == nil || java?.vmArgumentInput == vmInput,
              java == nil || saved["project"]["vm_arguments"] == input["vmArgumentValues"],
              saved["project"]["environment"] == .null,
              (java?.environmentInput ?? python?.environmentInput) == environment,
              (java?.dirty ?? python?.dirty) == false else {
            throw BridgeFailure(code: "RUN_FORM_QA", message: "Actual save changed literal arguments or persisted temporary environment")
        }
        let name = "personal-\(phase)-run-form-\(kind)-\(language)-\(appearance)-\(Int(width)).png"
        try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent(name)); captures.append(name)
        try await enter("arguments", originalArguments); try await enter("environment", originalEnvironment)
        if java != nil { try await enter("vm-arguments", originalVM) }
        try await saveAndWait()
        try await button("advanced-toggle").performClick(nil)
        try await TerminalSmoke.wait("Collapse advanced fields after the real save") { view("save-configuration") == nil }
        try await button("configuration-toggle").performClick(nil)
        try await TerminalSmoke.wait("Collapse the actual run configuration") { view("field-" + fields[0]) == nil }
        try await button("configuration-toggle").performClick(nil)
        try await TerminalSmoke.wait("Restore the same run configuration fields") { fields.allSatisfy { view("field-" + $0)?.window === window } }
        let after = try await readSnapshot()
        guard model.selectedID == selected, model.selectedTerminal?.generation == generation, panel.view.window === window,
              after.document.workspace == before.document.workspace, after.document.settings == before.document.settings else {
            throw BridgeFailure(code: "RUN_FORM_QA", message: "Run form actions changed the retained session or canonical workspace/settings")
        }
        var proof: [String: Any] = ["kind": kind, "language": language, "appearance": appearance, "width": Int(width), "height": Int(scene["height"].number ?? 0),
            "passed": true, "actualAdvancedToggle": true, "actualTextEditorInput": true, "invalidArgumentRetainedWithoutWrite": true, "literalArgumentsSaved": true, "validArgumentTextRetained": true, "temporaryEnvironmentRetainedWithoutPersistence": true, "fixtureArguments": literal, "fixtureEnvironment": environment, "savedArguments": input["argumentValues"].array.compactMap(\.string), "actualSaveButtonAndFeedback": true, "compactRightAlignedSave": true,
            "actualConfigurationCollapseAndRestore": true, "canonicalStateAndSessionRetained": true, "fieldFrames": frames, "columnCount": columns, "interpreterFullRow": fullInterpreter,
            "panelWidth": Double(panel.view.bounds.width), "saveWidth": Double(saveRect.width), "saveHeight": Double(saveRect.height), "saveRightInset": Double(inset), "screenshot": name,
            "formGridFrame": gridFrame, "backingScale": backingScale,
            "input": "Actual attached AppKit field/text editors and NSButton actions; no physical pointer claim"]
        for key in ["sourceHeadSHA", "testedMergeSHA", "platform", "architecture", "system"] { proof[key] = report[key] }
        var proofs = report["runPanelFormProof"] as? [[String: Any]] ?? []; proofs.append(proof); report["runPanelFormProof"] = proofs
    }
}
