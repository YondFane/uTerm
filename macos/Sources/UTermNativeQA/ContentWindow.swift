import AppKit
import WebKit
import UTermBridge

@MainActor
private final class ContentSchemeHandler: NSObject, WKURLSchemeHandler {
    private let resources: ContentResources
    private var active: [ObjectIdentifier: Task<Void, Never>] = [:]
    init(resources: ContentResources) { self.resources = resources }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let key = ObjectIdentifier(task as AnyObject)
        let resources = resources
        let url = task.request.url
        active[key] = Task { @MainActor [weak self] in
            let result = await Task.detached { () -> Result<(Data, String), Error> in
                do {
                    guard let url else { throw BridgeFailure(code: "RESOURCE_DENIED", message: "Missing content URL") }
                    return .success(try resources.data(for: url))
                } catch { return .failure(error) }
            }.value
            guard !Task.isCancelled, let self, self.active.removeValue(forKey: key) != nil else { return }
            switch result {
            case .success(let (data, mime)):
                guard let url = task.request.url,
                      let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": mime, "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff"]) else { task.didFailWithError(BridgeFailure(code: "RESOURCE_RESPONSE", message: "Could not create content response")); return }
                task.didReceive(response); task.didReceive(data); task.didFinish()
            case .failure(let error): task.didFailWithError(error)
            }
        }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        active.removeValue(forKey: ObjectIdentifier(task as AnyObject))?.cancel()
    }
}

private struct ContentMessage: Decodable {
    let version: UInt32
    let kind: String
    let id: String
    let document: String
    let method: String?
    let params: [String: JSONValue]?
}

@MainActor
final class ContentWindow: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    let webView: WKWebView
    let directory: URL
    let path: String
    private let bridge: CoreBridge
    private var documentID = UUID().uuidString
    private var tasks: [String: Task<Void, Never>] = [:]
    private var permitsClose = false
    private(set) var navigationError = ""
    var closed: (() -> Void)?
    private let entry = URL(string: "uterm-content://bundle/native-content.html")!

    init(bridge: CoreBridge, directory: URL, path: String) throws {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("content") else {
            throw BridgeFailure(code: "RESOURCE_MANIFEST", message: "Bundled content is missing")
        }
        let resources = try ContentResources(root: root)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(ContentSchemeHandler(resources: resources), forURLScheme: ContentResources.scheme)
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700), configuration: configuration)
        self.bridge = bridge
        self.directory = directory.standardizedFileURL.resolvingSymlinksInPath()
        self.path = path
        let window = NSWindow(contentRect: webView.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = path
        window.minSize = NSSize(width: 540, height: 360)
        window.contentView = webView
        super.init(window: window)
        window.delegate = self
        webView.navigationDelegate = self
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "utermContent")
        prepareDocument()
        webView.load(URLRequest(url: entry))
        window.center()
    }
    required init?(coder: NSCoder) { return nil }

    private func prepareDocument() {
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        documentID = UUID().uuidString
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source: "Object.defineProperty(window,'utermContentDocument',{value:'\(documentID)',writable:false,configurable:false});", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { prepareDocument() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationError = error.localizedDescription }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationError = error.localizedDescription }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        let allowed = action.targetFrame?.isMainFrame == false
            ? ["about:blank", "about:srcdoc"].contains(url?.absoluteString ?? "")
            : url == entry
        decisionHandler(allowed ? .allow : .cancel)
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url == entry else { replyHandler(nil, "Content frame is not allowed"); return }
        do {
            let bytes = try JSONSerialization.data(withJSONObject: message.body)
            guard bytes.count <= 32 * 1024 * 1024 else { throw BridgeFailure(code: "REQUEST_TOO_LARGE", message: "Content request exceeds the control limit") }
            let request = try JSONDecoder().decode(ContentMessage.self, from: bytes)
            guard request.version == 1, !request.id.isEmpty, request.id.count <= 128, request.document == documentID else {
                reply(request, error: BridgeFailure(code: "DOCUMENT_DENIED", message: "Content document is no longer active"), handler: replyHandler); return
            }
            let key = request.document + ":" + request.id
            if request.kind == "cancel" { tasks[key]?.cancel(); reply(request, result: .null, handler: replyHandler); return }
            guard request.kind == "request", tasks[key] == nil, tasks.count < 32 else {
                reply(request, error: BridgeFailure(code: "INVALID_OPERATION", message: "Content operation is invalid or busy"), handler: replyHandler); return
            }
            tasks[key] = Task { @MainActor [weak self] in
                guard let self else { replyHandler(nil, "Content window is closed"); return }
                defer { self.tasks.removeValue(forKey: key) }
                do {
                    let result = try await self.execute(request)
                    try Task.checkCancellation()
                    guard request.document == self.documentID else { throw CancellationError() }
                    self.reply(request, result: result, handler: replyHandler)
                } catch { self.reply(request, error: error, handler: replyHandler) }
            }
        } catch { replyHandler(nil, error.localizedDescription) }
    }
    private func reply(_ request: ContentMessage, result: JSONValue? = nil, error: Error? = nil, handler: (Any?, String?) -> Void) {
        var value: [String: Any] = ["version": 1, "id": request.id, "document": request.document]
        do {
            if let error {
                value["error"] = ["code": (error as? BridgeFailure)?.code ?? (error is CancellationError ? "CANCELLED" : "HOST_ERROR"), "message": error.localizedDescription]
            } else { value["result"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(result ?? .null), options: [.fragmentsAllowed]) }
            handler(value, nil)
        } catch { handler(nil, error.localizedDescription) }
    }
    private func execute(_ request: ContentMessage) async throws -> JSONValue {
        let params = request.params ?? [:]
        switch request.method {
        case "content_context":
            let state = try await bridge.snapshot()
            return .object(["directory": .string(directory.path), "path": .string(path), "settings": state.document.settings])
        case "file_read", "files_list", "files_search":
            guard params["directory"] == .string(directory.path) else { throw BridgeFailure(code: "ROOT_DENIED", message: "Content cannot select a different project root") }
            let methods = ["file_read": "files.read", "files_list": "files.list", "files_search": "files.search"]
            return try await bridge.call(methods[request.method!]!, params: .object(params))
        case "editor_drafts_list", "editor_drafts_document":
            guard params["directory"] == .string(directory.path) else { throw BridgeFailure(code: "ROOT_DENIED", message: "Draft cannot select another project root") }
            let method = request.method == "editor_drafts_list" ? "editor.drafts.list" : "editor.drafts.document"
            return try await bridge.call(method, params: .object(params))
        case "editor_drafts_import", "editor_drafts_put", "editor_drafts_remove":
            throw BridgeFailure(code: "READ_ONLY", message: localized("This window opens files read-only.", "此窗口以只读方式打开文件。"))
        case "file_save", "file_copy", "file_mutate":
            throw BridgeFailure(code: "READ_ONLY", message: localized("This window opens files read-only.", "此窗口以只读方式打开文件。"))
        case "editor_guard":
            guard params["active"] == .bool(false) else { throw BridgeFailure(code: "READ_ONLY", message: "Native preview cannot enable editing") }
            return .null
        case "editor_exit": forceClose(); return .null
        case "open_external":
            guard let text = params["url"]?.string, let url = URL(string: text), ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, NSWorkspace.shared.open(url) else {
                throw BridgeFailure(code: "URL_DENIED", message: "Could not open external web address")
            }
            return .null
        case "content_font_adjust", "content_settings_patch":
            let snapshot = try await bridge.snapshot()
            var values = params
            values["expectedRevision"] = .string(snapshot.revision)
            let method = request.method == "content_font_adjust" ? "settings.font.adjust" : "settings.patch"
            let saved = try await bridge.call(method, params: .object(values))
            return saved["document"]["settings"]
        default: throw BridgeFailure(code: "METHOD_DENIED", message: "Content method is not allowed")
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if permitsClose { return true }
        let event: [String: Any] = ["version": 1, "document": documentID, "kind": "editor-close-request", "payload": NSNull()]
        if let bytes = try? JSONSerialization.data(withJSONObject: event), let json = String(data: bytes, encoding: .utf8) {
            webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('uterm-content-event',{detail:\(json)}));")
        }
        // This window only previews files; it must also close when its Web content fails.
        // 此窗口只预览文件；Web 内容失效时也必须能关闭。
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard let self, !self.permitsClose, self.window?.isVisible == true else { return }
            self.forceClose()
        }
        return false
    }
    func forceClose() {
        permitsClose = true
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "utermContent", contentWorld: .page)
        window?.close()
    }
    func windowWillClose(_ notification: Notification) { closed?() }
}
