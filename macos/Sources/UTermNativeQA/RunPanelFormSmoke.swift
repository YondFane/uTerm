import AppKit
import UTermBridge

@MainActor
enum RunPanelFormSmoke {
    static func run(model: WorkspaceModel, window: NSWindow, panel: NativeWorkspacePanels.Panel, evidence: URL, phase: String, scene: JSONValue,
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
        if let java { java.feedback = "" }; if let python { python.feedback = "" }
        save.performClick(nil)
        try await TerminalSmoke.wait("Complete the actual Save configuration callback") {
            if let java { return !java.busy && (!java.feedback.isEmpty || !java.error.isEmpty) }
            if let python { return !python.busy && (!python.feedback.isEmpty || !python.error.isEmpty) }
            return false
        }
        guard (java?.error.isEmpty ?? python?.error.isEmpty) == true,
              (java?.dirty ?? python?.dirty) == false else { throw BridgeFailure(code: "RUN_FORM_QA", message: java?.error ?? python?.error ?? "Run configuration did not save") }
        let name = "personal-\(phase)-run-form-\(kind)-\(language)-\(appearance)-\(Int(width)).png"
        try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent(name)); captures.append(name)
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
            "passed": true, "actualAdvancedToggle": true, "actualSaveButtonAndFeedback": true, "compactRightAlignedSave": true,
            "actualConfigurationCollapseAndRestore": true, "canonicalStateAndSessionRetained": true, "fieldFrames": frames, "columnCount": columns, "interpreterFullRow": fullInterpreter,
            "panelWidth": Double(panel.view.bounds.width), "saveWidth": Double(saveRect.width), "saveHeight": Double(saveRect.height), "saveRightInset": Double(inset), "screenshot": name,
            "input": "Actual attached AppKit NSButton actions; no physical pointer claim"]
        for key in ["sourceHeadSHA", "testedMergeSHA", "platform", "architecture", "system"] { proof[key] = report[key] }
        var proofs = report["runPanelFormProof"] as? [[String: Any]] ?? []; proofs.append(proof); report["runPanelFormProof"] = proofs
    }
}
