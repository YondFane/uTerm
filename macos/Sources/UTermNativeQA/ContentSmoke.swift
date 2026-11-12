import AppKit
import WebKit
import UTermBridge

@MainActor
enum ContentSmoke {
    static func wait(_ content: ContentWindow, _ script: String, allowAlert: Bool = false) async throws {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if !content.navigationError.isEmpty { throw BridgeFailure(code: "CONTENT_NAVIGATION", message: content.navigationError) }
            if !allowAlert, let error = try? await content.webView.evaluateJavaScript("document.querySelector('[role=alert]')?.textContent || ''"),
               let message = error as? String, !message.isEmpty {
                throw BridgeFailure(code: "CONTENT_RENDER", message: message)
            }
            if let value = try? await content.webView.evaluateJavaScript(script), value as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        let state = (try? await content.webView.evaluateJavaScript("JSON.stringify({title:document.title,text:document.body.innerText,body:document.body.innerHTML.slice(-6000)})")) as? String ?? "No DOM"
        throw BridgeFailure(code: "CONTENT_TIMEOUT", message: script + ": " + String(state.prefix(8000)))
    }
    static func request(_ content: ContentWindow, method: String, params: [String: Any], wrongDocument: Bool = false, document: String? = nil) async throws -> String {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            content.webView.callAsyncJavaScript("""
                const reply = await window.webkit.messageHandlers.utermContent.postMessage({kind:'request',version:1,id:operationID,document:documentOverride||(wrongDocument?'old-document':window.utermContentDocument),method,params});
                return reply.error ? reply.error.code : 'SUCCESS';
                """, arguments: ["method": method, "params": params, "wrongDocument": wrongDocument, "operationID": UUID().uuidString, "documentOverride": document ?? ""], in: nil, in: .page) { result in
                    switch result {
                    case .success(let value):
                        guard let code = value as? String else { continuation.resume(throwing: BridgeFailure(code: "CONTENT_REPLY", message: "JavaScript did not return an error code")); return }
                        continuation.resume(returning: code)
                    case .failure(let error): continuation.resume(throwing: error)
                    }
                }
        }
    }

    static func run(model: WorkspaceModel, open: (URL, String) throws -> ContentWindow, report: inout [String: Any]) async throws {
        guard let bridge = model.bridge, model.ready,
              let reportPath = WorkspaceModel.argument("--content-smoke-report") else { throw BridgeFailure(code: "CONTENT_STARTUP", message: model.error) }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent().appendingPathComponent("content-project")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let original = Data("UTERM_CONTENT_中文 é\nreadonly file QA\n".utf8)
        try original.write(to: root.appendingPathComponent("中文.txt"))
        try Data("<html><head><style>body{font:24px system-ui;padding:30px}</style></head><body><h1>STATIC_QA 中文</h1><script>window.parent.document.body.textContent='UNSAFE'</script></body></html>".utf8).write(to: root.appendingPathComponent("preview.html"))
        let page = NSTextField(labelWithString: "UTERM_PDF_QA 中文")
        page.textColor = .black
        page.font = NSFont.systemFont(ofSize: 24)
        page.frame = NSRect(x: 0, y: 0, width: 420, height: 240)
        try page.dataWithPDF(inside: page.bounds).write(to: root.appendingPathComponent("preview.pdf"))
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        _ = try await bridge.call("editor.drafts.import", params: .object(["legacy": .null]))
        let otherRoot = root.deletingLastPathComponent().appendingPathComponent("unselected-project")
        for (directory, text) in [(root, "VISIBLE_DRAFT 中文"), (otherRoot, "HIDDEN_DRAFT_SECRET")] {
            _ = try await bridge.call("editor.drafts.putDocument", params: .object([
                "expectedDraftRevision": .null, "draft": .object([
                    "directory": .string(directory.path), "path": .string("中文.txt"), "kind": .string("text"),
                    "text": .string(text), "saved": .string("saved"), "version": .string(String(repeating: "a", count: 64)),
                    "line_ending": .string("\n"), "bom": .bool(false)
                ])
            ]))
        }
        var captures: [String] = []
        let before = try await bridge.snapshot()
        let font = before.document.settings["fileFontSize"].number ?? 14
        for (path, name, script) in [
            ("中文.txt", "native-content-text.png", "document.querySelector('.cm-content[contenteditable=false]')?.textContent.includes('UTERM_CONTENT_中文') === true"),
            ("preview.html", "native-content-html.png", "document.querySelector('.html-preview')?.getAttribute('srcdoc')?.includes('STATIC_QA') === true"),
            ("preview.pdf", "native-content-pdf.png", "document.querySelector('option[value=marks]') !== null && Array.from(document.querySelectorAll('.pdf-page canvas')).some(canvas => canvas.width > 0 && canvas.height > 0 && canvas.dataset.rendered === 'true' )")
        ] {
            let content = try open(root, path)
            defer { content.forceClose() }
            content.showWindow(nil)
            content.window?.makeKeyAndOrderFront(nil)
            try await wait(content, script)
            if path == "中文.txt" {
                report["realCodeMirrorReadonly"] = true
                _ = try await content.webView.evaluateJavaScript("document.querySelector('.editor-font-controls button:last-child').click()")
                try await wait(content, "document.documentElement.style.getPropertyValue('--file-font-size') === '\(Int(font + 1))px'")
                let saved = try await bridge.snapshot()
                guard saved.document.settings["fileFontSize"].number == font + 1 else { throw BridgeFailure(code: "CONTENT_SETTINGS", message: "File font did not reach canonical storage") }
                report["fontSavedByCore"] = true
                let wrongDocument = try await request(content, method: "file_read", params: ["directory": root.path, "path": path], wrongDocument: true)
                let rootEscape = try await request(content, method: "file_read", params: ["directory": "/", "path": "etc/passwd"])
                let write = try await request(content, method: "file_save", params: ["directory": root.path, "path": path, "text": "bad", "expected": "", "force": true])
                report["rejectionCodes"] = ["wrongDocument": wrongDocument, "rootEscape": rootEscape, "write": write]
                report["wrongDocumentRejected"] = wrongDocument == "DOCUMENT_DENIED"
                report["rootEscapeRejected"] = rootEscape == "ROOT_DENIED"
                report["writeRejected"] = write == "READ_ONLY"
                let scoped = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
                    content.webView.callAsyncJavaScript("""
                        const reply = await window.webkit.messageHandlers.utermContent.postMessage({kind:'request',version:1,id:operationID,document:window.utermContentDocument,method:'editor_drafts_list',params:{directory}});
                        return !reply.error && reply.result.drafts.length===1 && typeof reply.result.drafts[0].revision==='string' && /^[a-f0-9]{64}$/.test(reply.result.drafts[0].revision) && reply.result.drafts[0].draft.text==='VISIBLE_DRAFT 中文' && !JSON.stringify(reply.result).includes('HIDDEN_DRAFT_SECRET');
                        """, arguments: ["directory": root.path, "operationID": UUID().uuidString], in: nil, in: .page) { result in
                            switch result {
                            case .success(let value): continuation.resume(returning: value as? Bool == true)
                            case .failure(let error): continuation.resume(throwing: error)
                            }
                        }
                }
                report["scopedDraftsOnlySelectedRoot"] = scoped
                report["draftRootRejected"] = try await request(content, method: "editor_drafts_list", params: ["directory": otherRoot.path]) == "ROOT_DENIED"
                report["draftWriteRejected"] = try await request(content, method: "editor_drafts_remove", params: ["directory": root.path, "path": "中文.txt", "expectedDraftRevision": NSNull()]) == "READ_ONLY"
                let retained = try await bridge.call("editor.drafts.document", params: .object(["directory": .string(root.path), "path": .string("中文.txt")]))
                report["draftStoreUnaffectedByPreview"] = retained["draft"]["text"].string == "VISIBLE_DRAFT 中文"
                guard let oldDocument = try await content.webView.evaluateJavaScript("window.utermContentDocument") as? String, !oldDocument.isEmpty else { throw BridgeFailure(code: "CONTENT_DOCUMENT", message: "Content document identity is missing") }
                content.webView.reload()
                let quoted = String(data: try JSONEncoder().encode(oldDocument), encoding: .utf8)!
                try await wait(content, "window.utermContentDocument !== " + quoted + " && document.querySelector('.cm-content[contenteditable=false]')?.textContent.includes('UTERM_CONTENT_中文') === true")
                report["documentRotatedOnReload"] = true
                report["oldDocumentRejectedAfterReload"] = try await request(content, method: "file_read", params: ["directory": root.path, "path": path], document: oldDocument) == "DOCUMENT_DENIED"
                let quitReady = try await content.prepareForQuit()
                guard quitReady, content.isPreparedForQuit, content.window?.isVisible == true else {
                    throw BridgeFailure(code: "CONTENT_QUIT", message: "Content did not confirm prepare without closing")
                }
                report["quitPreparedWithoutClosing"] = true
                content.resumeAfterQuit()
                report["quitResumedWithoutClosing"] = !content.isPreparedForQuit && content.window?.isVisible == true
                _ = try await content.webView.evaluateJavaScript("window.utermQADispatch=window.dispatchEvent;window.dispatchEvent=function(event){window.utermQASuppressed=event.detail;return true};true")
                do {
                    _ = try await content.prepareForQuit(timeout: .milliseconds(100))
                    throw BridgeFailure(code: "CONTENT_QUIT", message: "Unresponsive content was allowed to quit")
                } catch let error as BridgeFailure where error.code == "QUIT_TIMEOUT" {
                    report["quitTimeoutRetainedWindow"] = !content.isPreparedForQuit && content.window?.isVisible == true
                }
                _ = try await content.webView.evaluateJavaScript("window.dispatchEvent=window.utermQADispatch;true")
                report["lateQuitResultRejected"] = try await request(content, method: "editor_prepare_result", params: ["token": "expired-quit-request", "ready": true]) == "STALE_QUIT"
                guard try Data(contentsOf: root.appendingPathComponent(path)) == original else { throw BridgeFailure(code: "CONTENT_WRITE", message: "Read-only preview changed its source") }
            } else if path == "preview.html" {
                let sandbox = try await content.webView.evaluateJavaScript("""
                    (() => { const frame=document.querySelector('.html-preview'); if(frame.getAttribute('sandbox')!=='') return false; try { return frame.contentWindow.document === null; } catch (error) { return error.name === 'SecurityError'; } })()
                    """)
                report["sandboxPreviewIsolated"] = sandbox as? Bool == true
            } else { report["pdfRendered"] = true }
            guard let window = content.window else { throw BridgeFailure(code: "CONTENT_WINDOW", message: "Content window is missing") }
            try await Task.sleep(for: .milliseconds(150))
            try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name))
            captures.append(name)
            guard let menu = NSApp.mainMenu?.items.dropFirst().first?.submenu,
                  let index = menu.items.firstIndex(where: { $0.action.map(NSStringFromSelector) == "closeSession" }) else { throw BridgeFailure(code: "CONTENT_MENU", message: "Native close menu is missing") }
            menu.update()
            guard menu.items[index].title == "Close file" else { throw BridgeFailure(code: "CONTENT_MENU", message: "Close menu did not target the focused content window") }
            menu.performActionForItem(at: index)
            try await TerminalSmoke.wait("Close file through its native menu and document transport") { !window.isVisible }
        }
        report["closedThroughNativeMenu"] = true
        let alias = root.deletingLastPathComponent().appendingPathComponent("content-alias")
        let replacement = root.deletingLastPathComponent().appendingPathComponent("content-alias-replacement")
        try FileManager.default.createDirectory(at: replacement, withIntermediateDirectories: true)
        let external = Data("EXTERNAL_ALIAS_TARGET\n".utf8)
        try external.write(to: replacement.appendingPathComponent("中文.txt"))
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: root)
        let aliased = try open(alias, "中文.txt")
        defer { aliased.forceClose() }
        try await wait(aliased, "document.querySelector('.cm-content[contenteditable=false]')?.textContent.includes('UTERM_CONTENT_中文') === true")
        try FileManager.default.removeItem(at: alias)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: replacement)
        let pinned = try await EditorSmoke.evaluate(aliased, script: """
            const reply = await window.webkit.messageHandlers.utermContent.postMessage({kind:'request',version:1,id:operationID,document:window.utermContentDocument,method:'file_read',params:{directory,path}});
            return !reply.error && reply.result.text === expected;
            """, arguments: ["directory": alias.path, "path": "中文.txt", "expected": String(decoding: original, as: UTF8.self), "operationID": UUID().uuidString])
        let denied = try await request(aliased, method: "file_read", params: ["directory": replacement.path, "path": "中文.txt"]) == "ROOT_DENIED"
        guard pinned, denied, try Data(contentsOf: replacement.appendingPathComponent("中文.txt")) == external else { throw BridgeFailure(code: "CONTENT_ROOT", message: "Retargeting a selected alias changed the native window filesystem scope") }
        report["logicalAliasRetainsPinnedFilesystemRoot"] = true
        report["retargetedAliasCannotSelectAnotherRoot"] = true
        guard let aliasWindow = aliased.window else { throw BridgeFailure(code: "CONTENT_WINDOW", message: "Alias content window is missing") }
        aliasWindow.makeKeyAndOrderFront(nil)
        let aliasImage = "native-content-alias-root.png"
        try await TerminalSmoke.capture(window: aliasWindow, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(aliasImage))
        captures.append(aliasImage)
        aliasWindow.performClose(nil)
        try await TerminalSmoke.wait("Close the readonly alias preview after its scoped read") { !aliasWindow.isVisible }
        report["aliasRootScenario"] = "Real filesystem retarget and fresh WebKit read; alternate root denied; normal readonly window close"
        let loading = try open(root, "中文.txt")
        defer { loading.forceClose() }
        report["loadingAtCloseRequest"] = loading.webView.isLoading
        loading.window?.performClose(nil)
        try await TerminalSmoke.wait("Close readonly preview before Web content is ready") { loading.window?.isVisible == false }
        report["earlyCloseSucceeded"] = true
        report["contentCaptures"] = captures
        report["contentScenario"] = ["language": "en", "appearance": "dark", "windowWidth": 1000, "readonly": true, "data": "temporary UTF-8, static HTML and generated PDF"] as [String: Any]
    }
}
