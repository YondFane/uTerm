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
            if let java { java.feedback = "" }; if let python { python.feedback = "" }
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
        func responsiveFieldsMatch() -> Bool {
            let frames = measuredFields()
            guard frames.count == 3, frames.allSatisfy({ $0.width > 0 && $0.height > 0 && $0.minX >= 0 && $0.maxX <= panel.view.bounds.width + 0.5 }) else { return false }
            if fullInterpreter {
                return abs(frames[0].width - (frames[1].width * 2 + 12)) < 1 && abs(frames[1].width - frames[2].width) < 1
                    && abs(frames[0].minX - frames[1].minX) < 1 && frames[2].minX >= frames[1].maxX
                    && abs(frames[1].minY - frames[2].minY) < 1 && frames[1].minY >= frames[0].maxY
            }
            guard frames.allSatisfy({ abs($0.width - frames[0].width) < 1 }), frames[1].minX >= frames[0].maxX,
                  abs(frames[0].minY - frames[1].minY) < 1 else { return false }
            return columns == 3 ? frames[2].minX >= frames[1].maxX && abs(frames[2].minY - frames[0].minY) < 1
                : abs(frames[2].minX - frames[0].minX) < 1 && frames[2].minY >= max(frames[0].maxY, frames[1].maxY)
        }
        _ = try await button("configuration-toggle")
        try await TerminalSmoke.wait("Apply the actual wide or narrow run form layout") { responsiveFieldsMatch() }
        var frames: [[String: Any]] = []
        for (field, rect) in zip(fields, measuredFields()) {
            frames.append(["id": field, "left": Double(rect.minX), "top": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)])
        }
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
            "passed": true, "actualAdvancedToggle": true, "actualTextEditorInput": true, "invalidArgumentRetainedWithoutWrite": true, "literalArgumentsSaved": true, "temporaryEnvironmentRetainedWithoutPersistence": true, "fixtureArguments": literal, "fixtureEnvironment": environment, "savedArguments": input["argumentValues"].array.compactMap(\.string), "actualSaveButtonAndFeedback": true, "compactRightAlignedSave": true,
            "actualConfigurationCollapseAndRestore": true, "canonicalStateAndSessionRetained": true, "fieldFrames": frames, "columnCount": columns, "interpreterFullRow": fullInterpreter,
            "panelWidth": Double(panel.view.bounds.width), "saveWidth": Double(saveRect.width), "saveHeight": Double(saveRect.height), "saveRightInset": Double(inset), "screenshot": name,
            "input": "Actual attached AppKit field/text editors and NSButton actions; no physical pointer claim"]
        for key in ["sourceHeadSHA", "testedMergeSHA", "platform", "architecture", "system"] { proof[key] = report[key] }
        var proofs = report["runPanelFormProof"] as? [[String: Any]] ?? []; proofs.append(proof); report["runPanelFormProof"] = proofs
    }
}
