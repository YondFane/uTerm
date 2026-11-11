import AppKit
import CryptoKit
import UTermBridge

@MainActor
enum PdfParitySmoke {
    private static func close(_ content: ContentWindow, model: WorkspaceModel, window: NSWindow) async throws {
        guard let document = model.documents.visible(in: model.inspectorContextKey).first(where: { $0.content === content }),
              let button = window.contentView.flatMap({ TerminalSmoke.descendants($0).first { $0.identifier?.rawValue == "native-file-close-" + document.id.uuidString } as? NSButton }) else { throw BridgeFailure(code: "PDF_TAB", message: "Missing actual PDF close tab") }
        button.performClick(nil)
        try await TerminalSmoke.wait("Close PDF through the actual workspace tab") { !model.documents.visible(in: model.inspectorContextKey).contains { $0.content === content } }
    }
    private static func draw(_ content: ContentWindow, window: NSWindow) async throws {
        _ = try await content.webView.evaluateJavaScript("document.querySelector('.pdf-controls button[aria-pressed]').click()")
        try await ContentSmoke.wait(content, "document.querySelector('.pdf-controls button[aria-pressed]')?.getAttribute('aria-pressed')==='true'")
        let raw = try await content.webView.evaluateJavaScript("JSON.stringify((()=>{const r=document.querySelector('.pdf-page').getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height}})())")
        guard let text = raw as? String, let data = text.data(using: .utf8), let box = try JSONSerialization.jsonObject(with: data) as? [String: Double],
              let x = box["x"], let y = box["y"], let width = box["width"], let height = box["height"], width > 0, height > 0 else { throw BridgeFailure(code: "PDF_GESTURE", message: "Missing actual PDF page geometry") }
        window.makeKeyAndOrderFront(nil); window.makeFirstResponder(content.webView)
        for (type, dx, dy) in [(NSEvent.EventType.leftMouseDown, 0.55, 0.55), (.leftMouseDragged, 0.75, 0.75), (.leftMouseUp, 0.75, 0.75)] {
            let css = NSPoint(x: x + width * dx, y: y + height * dy)
            let local = NSPoint(x: css.x, y: content.webView.isFlipped ? css.y : content.webView.bounds.height - css.y)
            let point = content.webView.convert(local, to: nil)
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1) else { throw BridgeFailure(code: "PDF_GESTURE", message: "Could not create native PDF gesture") }
            window.sendEvent(event)
            try await Task.sleep(for: .milliseconds(60))
        }
        try await ContentSmoke.wait(content, "document.querySelectorAll('.pdf-mark').length === 2 && !document.querySelector('.pdf-controls button[aria-pressed]').disabled")
        _ = try await content.webView.evaluateJavaScript("document.querySelector('.pdf-controls button[aria-pressed]').click()")
        _ = try await content.webView.evaluateJavaScript("[...document.querySelectorAll('.pdf-layout nav > div')].at(-1).querySelector('button:last-child').click()")
        try await ContentSmoke.wait(content, "document.querySelectorAll('.pdf-mark').length === 1 && !document.querySelector('.pdf-controls button[aria-pressed]').disabled")
    }
    static func run(model: WorkspaceModel, window: NSWindow, project: URL, output: URL, fixture: JSONValue, phase: String, open: (URL, String) async throws -> ContentWindow, report: inout [String: Any], captures: inout [String]) async throws {
        guard let bridge = model.bridge, let path = fixture["pdf"]["path"].string, let digest = fixture["pdf"]["sha256"].string, let terminal = model.selectedTerminal else { throw BridgeFailure(code: "PDF_PARITY", message: "Missing shared PDF context") }
        let source = try Data(contentsOf: project.appendingPathComponent(path))
        guard SHA256.hash(data: source).map({ String(format: "%02x", $0) }).joined() == digest else { throw BridgeFailure(code: "PDF_FIXTURE", message: "Shared PDF bytes differ") }
        let file = try await bridge.call("files.read", params: .object(["directory": .string(project.path), "path": .string(path)]))
        guard file["kind"].string == "pdf", file["version"].string == digest else { throw BridgeFailure(code: "PDF_VERSION", message: "Shared PDF version differs") }
        let target: [String: JSONValue] = ["directory": .string(project.path), "path": .string(path), "version": .string(digest)]
        let before = try await bridge.call("pdf.marks.read", params: .object(target))
        let expected: JSONValue = .array([fixture["pdf"]["mark"]])
        if phase != "initial" { guard before["marks"] == expected else { throw BridgeFailure(code: "PDF_REPLACEMENT", message: "Application replacement did not retain PDF highlights") } }
        var seed = target; seed["expectedRevision"] = before["revision"]; seed["marks"] = expected
        _ = try await bridge.call("pdf.marks.write", params: .object(seed))
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        _ = try await TerminalSmoke.sizeCaptureWindow(window, width: 1100, height: 720)
        let generation = terminal.generation, terminalView = ObjectIdentifier(terminal.view)
        var content = try await open(project, path)
        try await TerminalSmoke.wait("Display PDF inside the actual workspace") { content.webView.window === window && content.presentEmbedded != nil }
        try await ContentSmoke.wait(content, "[...document.querySelectorAll('.pdf-page canvas')].some(c=>c.dataset.rendered==='true') && document.querySelectorAll('.pdf-mark').length===1 && !document.querySelector('.pdf-controls button[aria-pressed]').disabled")
        let wrongRoot = try await ContentSmoke.request(content, method: "pdf_marks_read", params: ["directory": project.deletingLastPathComponent().path, "path": path, "version": digest])
        let wrongPath = try await ContentSmoke.request(content, method: "pdf_marks_read", params: ["directory": project.path, "path": "other.pdf", "version": digest])
        guard wrongRoot == "ROOT_DENIED", wrongPath == "ROOT_DENIED" else { throw BridgeFailure(code: "PDF_SCOPE", message: "PDF annotations accessed another document") }
        report["pdfMarkWrongRootAndPathRejected"] = true
        _ = try await content.webView.evaluateJavaScript("const select=document.querySelector('.pdf-layout nav select');select.value='marks';select.dispatchEvent(new Event('change',{bubbles:true}))")
        try await EditorSmoke.click(content, title: "Delete highlight")
        try await ContentSmoke.wait(content, "document.querySelectorAll('.pdf-mark').length===0 && !document.querySelector('.pdf-controls button[aria-pressed]').disabled")
        let deleted = try await bridge.call("pdf.marks.read", params: .object(target))
        guard deleted["marks"] == .array([]) else { throw BridgeFailure(code: "PDF_DELETE", message: "Actual deletion did not reach the core") }
        try await close(content, model: model, window: window)
        content = try await open(project, path)
        try await ContentSmoke.wait(content, "[...document.querySelectorAll('.pdf-page canvas')].some(c=>c.dataset.rendered==='true') && document.querySelectorAll('.pdf-mark').length===0 && !document.querySelector('.pdf-controls button[aria-pressed]').disabled")
        try await close(content, model: model, window: window)
        seed["expectedRevision"] = deleted["revision"]
        _ = try await bridge.call("pdf.marks.write", params: .object(seed))
        content = try await open(project, path)
        try await ContentSmoke.wait(content, "document.querySelectorAll('.pdf-mark').length===1 && !document.querySelector('.pdf-controls button[aria-pressed]').disabled")
        _ = try await content.webView.evaluateJavaScript("const select=document.querySelector('.pdf-layout nav select');select.value='marks';select.dispatchEvent(new Event('change',{bubbles:true}))")
        try await draw(content, window: window)
        let saved = try await bridge.call("pdf.marks.read", params: .object(target))
        guard saved["marks"] == expected else { throw BridgeFailure(code: "PDF_DRAW", message: "Native draw and delete changed the retained fixture mark") }
        let identity = ObjectIdentifier(content.webView)
        var scenes: [[String: Any]] = []
        for scene in fixture["contentScenes"].array {
            guard let language = scene["language"].string, let appearance = scene["appearance"].string,
                  let rawWidth = scene["width"].number, let rawHeight = scene["height"].number,
                  let width = Int(exactly: rawWidth), let height = Int(exactly: rawHeight) else { throw BridgeFailure(code: "PDF_SCENE", message: "Invalid shared PDF scene") }
            await model.patchSettings(["language": .string(language), "appearance": .string(appearance)])
            _ = try await TerminalSmoke.sizeCaptureWindow(window, width: width, height: height)
            let label = language == "en" ? "Delete highlight" : "删除高亮"
            let quoted = String(data: try JSONEncoder().encode(label), encoding: .utf8)!
            try await ContentSmoke.wait(content, "[...document.querySelectorAll('.pdf-layout nav button')].some(button=>button.textContent.trim()===" + quoted + ")")
            try await ContentSmoke.wait(content, "document.querySelectorAll('.pdf-mark').length===1 && [...document.querySelectorAll('.pdf-page canvas')].some(c=>c.dataset.rendered==='true')")
            guard ObjectIdentifier(content.webView) == identity, content.webView.window === window else { throw BridgeFailure(code: "PDF_IDENTITY", message: "Settings replaced the PDF document") }
            let name = "personal-\(phase)-pdf-highlights-\(language)-\(appearance)-\(Int(width)).png"
            try await TerminalSmoke.capture(window: window, path: output.appendingPathComponent(name))
            captures.append(name); report["captures"] = captures
            scenes.append(["scenario": "pdf-highlights", "screenshot": name, "platform": "macOS", "architecture": report["architecture"] ?? "", "system": report["system"] ?? "", "sourceHeadSHA": report["sourceHeadSHA"] ?? "", "testedMergeSHA": report["testedMergeSHA"] ?? "", "language": language, "appearance": appearance, "width": Int(width), "height": Int(height), "pdfSHA256": digest, "markID": fixture["pdf"]["mark"]["id"].string ?? "", "marksCount": 1, "actualRemoveButton": true, "reopenedRestoredMarks": true, "originalPdfUnchanged": true, "inMainWorkspace": true, "settingsPreserveDocument": true, "nativePointerDrawAndDelete": true])
            report["contentScenes"] = scenes
        }
        try await close(content, model: model, window: window)
        guard try Data(contentsOf: project.appendingPathComponent(path)) == source, terminal.generation == generation, ObjectIdentifier(terminal.view) == terminalView else { throw BridgeFailure(code: "PDF_SOURCE", message: "PDF operations changed source bytes or terminal identity") }
        report["pdfHighlightsRetainedAfterReplacement"] = phase != "initial"
        report["pdfHighlightsNativeDrawDeleteReopenAndScopeVerified"] = true
    }
}
