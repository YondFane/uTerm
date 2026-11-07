import AppKit
import UTermBridge

@MainActor
enum TransitionSmoke {
    static func run(model: WorkspaceModel, window: NSWindow, openFile: (URL, String) async throws -> ContentWindow,
                    report: inout [String: Any]) async throws {
        guard let bridge = model.bridge, let reportPath = WorkspaceModel.argument("--transition-smoke-report"),
              let phase = WorkspaceModel.argument("--transition-smoke-phase"), ["checkpoint", "reopen"].contains(phase) else { throw BridgeFailure(code: "TRANSITION_CONTEXT", message: "Missing private transition context") }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent()
        let input = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: root.appendingPathComponent("transition-native-input.json")))
        guard let id = input["id"].string, let generation = input["generation"].string,
              let projectPath = input["project"].string, let file = input["fileName"].string,
              let legacyText = input["legacyDraft"].string, let nativeText = input["nativeDraft"].string,
              let saved = input["savedText"].string else { throw BridgeFailure(code: "TRANSITION_CONTEXT", message: "Invalid private transition fixture") }
        try await TerminalSmoke.wait("Attach the actual historical Tauri process in the native client") {
            model.terminals[id]?.generation == generation && (model.terminals[id]?.qaRenderedFrames ?? 0) > 0 && model.terminals[id]?.error.isEmpty == true
        }
        await model.selectSession(id)
        guard let terminal = model.selectedTerminal else { throw BridgeFailure(code: "TRANSITION_SESSION", message: "Missing historical session reference") }
        try await TerminalSmoke.wait("Display the historical session in the native window") { terminal.view.window === window && terminal.view.visibleRect.width > 0 }
        let status = try await bridge.call("host.status")
        guard status["pid"] == input["hostPID"], status["sessions"].array.contains(where: { $0["spec"]["id"].string == id && $0["generation"].string == generation }) else { throw BridgeFailure(code: "TRANSITION_HOST", message: "Native transition restarted the active historical host") }
        let project = URL(fileURLWithPath: projectPath)
        let expectedBytes = Data(("\u{feff}" + saved).utf8)
        guard try Data(contentsOf: project.appendingPathComponent(file)) == expectedBytes else { throw BridgeFailure(code: "TRANSITION_SOURCE", message: "Transition changed original file bytes") }
        let content = try await openFile(project, file)
        let expected = phase == "checkpoint" ? legacyText : nativeText
        report["phase"] = phase
        report["nativeDocumentDirectory"] = content.documentDirectory
        report["resolvedNativeDirectory"] = content.directory.path
        guard content.documentDirectory == projectPath else { throw BridgeFailure(code: "TRANSITION_ROOT", message: "Native editor rewrote the historical draft root identity") }
        let initial = try await bridge.call("editor.drafts.document", params: .object(["directory": .string(projectPath), "path": .string(file)]))
        let initialText = initial["draft"]["text"].string ?? ""
        report["initialCoreDraftUTF8"] = Array(initialText.utf8)
        guard Data(initialText.utf8) == Data(expected.utf8) else { throw BridgeFailure(code: "TRANSITION_CORE_DRAFT", message: "Native client could not read the exact imported/latest draft bytes") }
        let quoted = String(data: try JSONEncoder().encode(expected.trimmingCharacters(in: .whitespacesAndNewlines)), encoding: .utf8)!
        do {
            // CodeMirror mounts before its asynchronous draft is restored; wait for the actual text.
            // CodeMirror 挂载早于异步草稿恢复；等待实际文本就绪。
            try await ContentSmoke.wait(content, "document.querySelector('.cm-content[contenteditable=true]')?.textContent.includes(\(quoted)) === true")
        } catch {
            report["restoreFailureDOMText"] = (try? await content.webView.evaluateJavaScript("document.querySelector('.cm-content')?.innerText || ''")) as? String ?? ""
            let directory = URL(fileURLWithPath: reportPath).deletingLastPathComponent()
            do {
                let main = "transition-native-" + phase + "-failure.png"
                try await TerminalSmoke.capture(window: window, path: directory.appendingPathComponent(main))
                var images = [main]
                if let editor = content.window {
                    let image = "transition-native-editor-" + phase + "-failure.png"
                    try await TerminalSmoke.capture(window: editor, path: directory.appendingPathComponent(image))
                    images.append(image)
                }
                report["failureCaptures"] = images
            } catch { report["failureCaptureError"] = error.localizedDescription }
            throw error
        }
        if phase == "checkpoint" {
            try await EditorSmoke.replace(content, text: nativeText)
            await model.patchSettings(["fontSize": input["rollbackFontSize"]])
        }
        var durable = false
        for _ in 0..<500 {
            let entry = try await bridge.call("editor.drafts.document", params: .object(["directory": .string(projectPath), "path": .string(file)]))
            if let text = entry["draft"]["text"].string, Data(text.utf8) == Data(nativeText.utf8) { durable = true; break }
            try await Task.sleep(for: .milliseconds(30))
        }
        guard durable, model.settings["fontSize"] == input["rollbackFontSize"],
              try Data(contentsOf: project.appendingPathComponent(file)) == expectedBytes else { throw BridgeFailure(code: "TRANSITION_DRAFT", message: "Latest native draft/settings were not durable or changed the original file") }
        terminal.enqueue(Data("printf 'TRANSITION_%s\\n' \(phase.uppercased())\r".utf8))
        try await TerminalSmoke.wait("Fresh retained historical PTY output through the native client") { terminal.text.contains("TRANSITION_" + phase.uppercased()) }
        let directory = URL(fileURLWithPath: reportPath).deletingLastPathComponent()
        let mainImage = "transition-native-" + phase + ".png"
        let editorImage = "transition-native-editor-" + phase + ".png"
        try await TerminalSmoke.capture(window: window, path: directory.appendingPathComponent(mainImage))
        guard let editorWindow = content.window else { throw BridgeFailure(code: "TRANSITION_EDITOR", message: "Missing actual native editor window") }
        try await TerminalSmoke.capture(window: editorWindow, path: directory.appendingPathComponent(editorImage))
        report["captures"] = [mainImage, editorImage]; report["phase"] = phase
        report["realHistoricalHostAndGenerationRetained"] = true; report["actualNativeEditorInput"] = phase == "checkpoint"
        report["actualNativeEditorRecovery"] = true
        report["latestDraftBytesDurable"] = true; report["originalFileUnchanged"] = true
        report["latestSettingsDurable"] = true; report["awaitingForcedExit"] = phase == "checkpoint"
        if phase == "reopen" {
            // QA closes the view without saving only after exact durable draft verification.
            // QA 仅在核对准确持久草稿后，关闭视图且不保存文件。
            content.forceClose()
            report["qaForcedContentClosePreservedDraft"] = true
        }
    }
}
