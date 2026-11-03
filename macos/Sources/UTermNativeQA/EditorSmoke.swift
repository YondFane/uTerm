import AppKit
import WebKit
import UTermBridge

@MainActor
enum EditorSmoke {
    private static let name = "editor-中文.txt"
    private static let original = Data("\u{feff}ORIGINAL_DISK 中文\r\n".utf8)
    private static let edited = "NATIVE_EDIT_中文 é\r\ndurable recovery text\r\n"

    static func evaluate(_ content: ContentWindow, script: String, arguments: [String: Any]) async throws -> Bool {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
            content.webView.callAsyncJavaScript(script, arguments: arguments, in: nil, in: .page) { result in
                switch result {
                case .success(let value):
                    guard let value = value as? Bool else { continuation.resume(throwing: BridgeFailure(code: "EDITOR_REPLY", message: "Editor script did not return a boolean")); return }
                    continuation.resume(returning: value)
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
    }

    static func replace(_ content: ContentWindow, text: String) async throws {
        guard let window = content.window else { throw BridgeFailure(code: "EDITOR_WINDOW", message: "Editor window missing") }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        guard window.makeFirstResponder(content.webView) else { throw BridgeFailure(code: "EDITOR_FOCUS", message: "Native WK editor cannot become first responder") }
        try await Task.sleep(for: .milliseconds(100))
        let ready = try await evaluate(content, script: """
            const editor=document.querySelector('.cm-content[contenteditable=true]');
            if(!editor) return false;
            editor.focus();
            document.execCommand('selectAll',false);
            return document.execCommand('insertText',false,text);
            """, arguments: ["text": text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")])
        guard ready else { throw BridgeFailure(code: "EDITOR_INPUT", message: "Native WK editor did not accept DOM insertText") }
    }
    static func click(_ content: ContentWindow, title: String) async throws {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            let found = try await evaluate(content, script: """
            const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===title);
            if(!button || button.disabled) return false;
            button.click();return true;
            """, arguments: ["title": title])
            if found { return }
            try await Task.sleep(for: .milliseconds(30))
        }
        throw BridgeFailure(code: "EDITOR_ACTION", message: "Editor button unavailable: " + title)
    }
    private static func capture(_ content: ContentWindow, reportPath: String, name: String) async throws {
        guard let window = content.window else { throw BridgeFailure(code: "EDITOR_WINDOW", message: "Editor window missing") }
        try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name))
    }
    private static func draft(_ bridge: CoreBridge, root: URL) async throws -> JSONValue {
        try await bridge.call("editor.drafts.document", params: .object(["directory": .string(root.path), "path": .string(name)]))
    }
    static func run(model: WorkspaceModel, parent: NSWindow, open: (URL, String) async throws -> ContentWindow,
                    lookup: @escaping (URL, String) -> ContentWindow?, report: inout [String: Any]) async throws {
        guard let bridge = model.bridge, model.ready, let reportPath = WorkspaceModel.argument("--editor-smoke-report"),
              let phase = WorkspaceModel.argument("--editor-smoke-phase"), ["checkpoint", "reopen"].contains(phase) else {
            throw BridgeFailure(code: "EDITOR_START", message: "Missing isolated editor QA context")
        }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent().appendingPathComponent("editor-project")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent(name)
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        report["editorPhase"] = phase
        report["inputMethod"] = "DOM execCommand insertText in real native WKWebView; not manual keyboard/IME acceptance"
        report["editorScenario"] = ["language": "en", "appearance": "dark", "width": 1000, "project": "isolated temporary files", "source": "versioned shared Rust drafts"] as [String: Any]
        if phase == "checkpoint" {
            try original.write(to: file)
            let disk = try await bridge.call("files.read", params: .object(["directory": .string(root.path), "path": .string(name)]))
            let source = JSONValue.object(["directory": .string(root.path), "path": .string(name), "kind": .string("text"),
                "text": .string("RECOVER_ME 中文\r\n"), "saved": disk["text"], "version": disk["version"], "bom": disk["bom"], "line_ending": disk["line_ending"]])
            let legacy = String(data: try JSONEncoder().encode(source), encoding: .utf8)!
            _ = try await bridge.call("editor.drafts.import", params: .object(["legacy": .string(legacy)]))
            let content = try await open(root, name)
            try await ContentSmoke.wait(content, "document.querySelector('.cm-content[contenteditable=true]')?.textContent.includes('RECOVER_ME') === true")
            try await replace(content, text: edited)
            let deadline = Date().addingTimeInterval(15)
            var durable = false
            var storedText = ""
            while Date() < deadline {
                let stored = try await draft(bridge, root: root)
                storedText = stored["draft"]["text"].string ?? ""
                if Data(storedText.utf8) == Data(edited.utf8) { durable = true; break }
                try await Task.sleep(for: .milliseconds(30))
            }
            let unchanged = try Data(contentsOf: file) == original
            report["checkpointExpectedUTF8"] = Array(edited.utf8)
            report["checkpointActualUTF8"] = Array(storedText.utf8)
            report["checkpointStoredText"] = storedText
            report["checkpointDOMText"] = (try? await content.webView.evaluateJavaScript("document.querySelector('.cm-content')?.innerText || ''")) as? String ?? ""
            report["checkpointAlert"] = (try? await content.webView.evaluateJavaScript("document.querySelector('[role=alert]')?.textContent || ''")) as? String ?? ""
            report["checkpointSaveState"] = (try? await content.webView.evaluateJavaScript("document.querySelector('.editor-save-state')?.textContent || ''")) as? String ?? ""
            report["checkpointGeometry"] = (try? await content.webView.evaluateJavaScript("JSON.stringify({viewport:innerWidth,documentWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,headerWidth:document.querySelector('.editor-header').getBoundingClientRect().width,buttons:[...document.querySelectorAll('.editor-header button')].map(b=>({text:b.textContent.trim(),left:b.getBoundingClientRect().left,right:b.getBoundingClientRect().right}))})")) as? String ?? ""
            report["checkpointOriginalUnchanged"] = unchanged
            guard durable, unchanged else {
                let image = "native-editor-checkpoint-failure.png"
                do { try await capture(content, reportPath: reportPath, name: image); report["failureCapture"] = image }
                catch { report["failureCaptureError"] = error.localizedDescription }
                throw BridgeFailure(code: "EDITOR_CHECKPOINT", message: "Edited draft was not durable while original file remained unchanged")
            }
            report["editedDraftDurableBeforeKill"] = true
            report["originalBytesBeforeKill"] = true
            report["wrongFileWriteRejected"] = try await ContentSmoke.request(content, method: "file_save", params: ["directory": root.path, "path": "other.txt", "text": "denied", "expected": String(repeating: "a", count: 64), "force": true]) == "ROOT_DENIED"
            let image = "native-editor-durable-draft.png"
            try await capture(content, reportPath: reportPath, name: image)
            report["editorCaptures"] = [image]
            // The runner kills this QA process only after it reads the durable checkpoint report.
            // 运行器读取已持久化检查点报告后，才会强制结束此 QA 进程。
            report["awaitingForcedExit"] = true
            return
        }
        guard try Data(contentsOf: file) == original else { throw BridgeFailure(code: "EDITOR_REOPEN", message: "Original file changed during forced-exit scenario") }
        let content = try await open(root, name)
        defer { content.forceClose() }
        try await ContentSmoke.wait(content, "document.querySelector('.cm-content[contenteditable=true]')?.textContent.includes('NATIVE_EDIT_中文') === true")
        let restored = try await draft(bridge, root: root)
        guard let restoredText = restored["draft"]["text"].string, Data(restoredText.utf8) == Data(edited.utf8) else { throw BridgeFailure(code: "EDITOR_REOPEN", message: "Reopen lost exact edited draft bytes") }
        report["forcedExitDraftRestored"] = true
        var captures = ["native-editor-recovered.png"]
        try await capture(content, reportPath: reportPath, name: captures[0])
        let external = Data("\u{feff}EXTERNAL_CHANGE 中文\r\n".utf8)
        try external.write(to: file)
        try await click(content, title: "Save")
        try await ContentSmoke.wait(content, "document.querySelector('[role=alert]')?.textContent.length > 0", allowAlert: true)
        guard try Data(contentsOf: file) == external else { throw BridgeFailure(code: "EDITOR_CONFLICT", message: "Save replaced an external change") }
        report["externalConflictRetainedFileAndDraft"] = (try await draft(bridge, root: root))["draft"]["text"].string.map { Data($0.utf8) == Data(edited.utf8) } == true
        captures.append("native-editor-conflict.png")
        try await capture(content, reportPath: reportPath, name: captures.last!)
        content.window?.performClose(nil)
        try await ContentSmoke.wait(content, "document.querySelector('dialog[open]') !== null", allowAlert: true)
        captures.append("native-editor-close-guard.png")
        try await capture(content, reportPath: reportPath, name: captures.last!)
        try await click(content, title: "Keep editing")
        try await Task.sleep(for: .milliseconds(850))
        guard content.window?.isVisible == true else { throw BridgeFailure(code: "EDITOR_CLOSE", message: "Editable window closed despite retaining changes") }
        report["closeRefusedWithoutReadonlyFallback"] = true
        content.window?.performClose(nil)
        try await ContentSmoke.wait(content, "document.querySelector('dialog[open]') !== null", allowAlert: true)
        try await click(content, title: "Discard changes and continue")
        try await TerminalSmoke.wait("Discard own draft and close editable window") { content.window?.isVisible == false }
        guard try Data(contentsOf: file) == external, (try await draft(bridge, root: root)) == .null else { throw BridgeFailure(code: "EDITOR_DISCARD", message: "Explicit discard changed the file or retained the local draft") }
        report["discardRemovedOnlyOwnDraft"] = true
        let saved = try await open(root, name)
        defer { saved.forceClose() }
        try await ContentSmoke.wait(saved, "document.querySelector('.cm-content[contenteditable=true]')?.textContent.includes('EXTERNAL_CHANGE') === true")
        let finalText = "EXPLICIT_NATIVE_SAVE 中文 é\r\n"
        try await replace(saved, text: finalText)
        try await click(saved, title: "Save")
        try await ContentSmoke.wait(saved, "document.querySelector('.editor-save-state')?.textContent.trim() === 'Saved'")
        guard try Data(contentsOf: file) == Data(("\u{feff}" + finalText).utf8), (try await draft(bridge, root: root)) == .null else { throw BridgeFailure(code: "EDITOR_SAVE", message: "Native save did not retain BOM/CRLF or clear the acknowledged draft") }
        report["savedExactBytesAndClearedDraft"] = true
        captures.append("native-editor-saved.png")
        try await capture(saved, reportPath: reportPath, name: captures.last!)
        saved.window?.setContentSize(NSSize(width: 640, height: 600))
        try await ContentSmoke.wait(saved, "innerWidth===640 && [...document.querySelectorAll('.editor-header button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1}) && document.documentElement.scrollWidth<=innerWidth")
        report["narrowEditorControlsWithinViewport"] = true
        report["narrowEditorScene"] = ["width": 640, "height": 600, "language": "en", "appearance": "dark", "capture": "native-editor-saved-640.png"] as [String: Any]
        captures.append("native-editor-saved-640.png")
        try await capture(saved, reportPath: reportPath, name: captures.last!)
        report["cleanEditorQuitPrepared"] = try await saved.prepareForQuit()
        saved.resumeAfterQuit()
        try await ContentSmoke.wait(saved, "document.querySelector('.cm-content[contenteditable=true]') !== null")
        _ = try await saved.webView.evaluateJavaScript("(()=>{const editor=document.querySelector('.cm-content');editor.focus();return editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true,cancelable:true}))})()")
        try await TerminalSmoke.wait("Close clean editor through its Escape handler and document transport") { saved.window?.isVisible == false }
        report["escapeClosedNativeFileWindow"] = true
        report["escapeInputMethod"] = "Synthetic DOM KeyboardEvent inside the real native WKWebView"
        let metadata = try await bridge.call("files.read", params: .object(["directory": .string(root.path), "path": .string(name)]))
        let missingText = "MISSING_SOURCE_RECOVERY 中文 é\r\n"
        _ = try await bridge.call("editor.drafts.putDocument", params: .object([
            "expectedDraftRevision": .null, "draft": .object([
                "directory": .string(root.path), "path": .string(name), "kind": .string("text"),
                "text": .string(missingText), "saved": metadata["text"], "version": metadata["version"],
                "line_ending": metadata["line_ending"], "bom": metadata["bom"]
            ])
        ]))
        try FileManager.default.removeItem(at: file)
        let missing = try await open(root, name)
        defer { missing.forceClose() }
        try await ContentSmoke.wait(missing, "document.querySelector('.cm-content[contenteditable=false]')?.textContent.includes('MISSING_SOURCE_RECOVERY') === true", allowAlert: true)
        captures.append("native-editor-missing-source.png")
        try await capture(missing, reportPath: reportPath, name: captures.last!)
        missing.window?.performClose(nil)
        try await TerminalSmoke.wait("Close missing-source readonly recovery without deleting its draft") { missing.window?.isVisible == false }
        report["missingSourceRetainedReadonlyAfterClose"] = (try await draft(bridge, root: root))["draft"]["text"].string.map { Data($0.utf8) == Data(missingText.utf8) } == true
        try await EditorRecoverySmoke.run(model: model, parent: parent, root: root, path: name, text: missingText,
                                          lookup: lookup, reportPath: reportPath, captures: &captures, report: &report)
        report["editorCaptures"] = captures
    }
}
