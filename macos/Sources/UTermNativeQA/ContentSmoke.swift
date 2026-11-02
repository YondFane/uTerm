import AppKit
import WebKit
import UTermBridge

@MainActor
enum ContentSmoke {
    private static func wait(_ content: ContentWindow, _ script: String) async throws {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if !content.navigationError.isEmpty { throw BridgeFailure(code: "CONTENT_NAVIGATION", message: content.navigationError) }
            if let error = try? await content.webView.evaluateJavaScript("document.querySelector('[role=alert]')?.textContent || ''"),
               let message = error as? String, !message.isEmpty {
                throw BridgeFailure(code: "CONTENT_RENDER", message: message)
            }
            if let value = try? await content.webView.evaluateJavaScript(script), value as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        let state = (try? await content.webView.evaluateJavaScript("document.documentElement.outerHTML")) as? String ?? "No DOM"
        throw BridgeFailure(code: "CONTENT_TIMEOUT", message: String(state.prefix(6000)))
    }
    private static func request(_ content: ContentWindow, method: String, params: [String: Any], wrongDocument: Bool = false) async throws -> String {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            content.webView.callAsyncJavaScript("""
                const reply = await window.webkit.messageHandlers.utermContent.postMessage({kind:'request',version:1,id:operationID,document:wrongDocument?'old-document':window.utermContentDocument,method,params});
                return reply.error ? reply.error.code : 'SUCCESS';
                """, arguments: ["method": method, "params": params, "wrongDocument": wrongDocument, "operationID": UUID().uuidString], in: nil, in: .page) { result in
                    switch result {
                    case .success(let value):
                        guard let code = value as? String else { continuation.resume(throwing: BridgeFailure(code: "CONTENT_REPLY", message: "JavaScript did not return an error code")); return }
                        continuation.resume(returning: code)
                    case .failure(let error): continuation.resume(throwing: error)
                    }
                }
        }
    }

    static func run(model: WorkspaceModel, report: inout [String: Any]) async throws {
        guard let bridge = model.bridge, model.ready,
              let reportPath = WorkspaceModel.argument("--content-smoke-report") else { throw BridgeFailure(code: "CONTENT_STARTUP", message: model.error) }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent().appendingPathComponent("content-project")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let original = Data("UTERM_CONTENT_中文 é\nreadonly file QA\n".utf8)
        try original.write(to: root.appendingPathComponent("中文.txt"))
        try Data("<html><head><style>body{font:24px system-ui;padding:30px}</style></head><body><h1>STATIC_QA 中文</h1><script>window.parent.document.body.textContent='UNSAFE'</script></body></html>".utf8).write(to: root.appendingPathComponent("preview.html"))
        let page = NSTextField(labelWithString: "UTERM_PDF_QA 中文")
        page.frame = NSRect(x: 0, y: 0, width: 420, height: 240)
        try page.dataWithPDF(inside: page.bounds).write(to: root.appendingPathComponent("preview.pdf"))
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        var captures: [String] = []
        let before = try await bridge.snapshot()
        let font = before.document.settings["fileFontSize"].number ?? 14
        for (path, name, script) in [
            ("中文.txt", "native-content-text.png", "document.querySelector('.cm-content[contenteditable=false]')?.textContent.includes('UTERM_CONTENT_中文') === true"),
            ("preview.html", "native-content-html.png", "document.querySelector('.html-preview')?.getAttribute('srcdoc')?.includes('STATIC_QA') === true"),
            ("preview.pdf", "native-content-pdf.png", "document.querySelector('option[value=marks]') === null && Array.from(document.querySelectorAll('.pdf-page canvas')).some(canvas => canvas.width > 0 && canvas.height > 0 && canvas.dataset.rendered === 'true' )")
        ] {
            let content = try ContentWindow(bridge: bridge, directory: root, path: path)
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
            content.forceClose()
        }
        report["contentCaptures"] = captures
        report["contentScenario"] = ["language": "en", "appearance": "dark", "windowWidth": 1000, "readonly": true, "data": "temporary UTF-8, static HTML and generated PDF"] as [String: Any]
    }
}
