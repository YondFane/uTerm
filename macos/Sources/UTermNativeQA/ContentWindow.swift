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
    let documentDirectory: String
    let path: String
    let editable: Bool
    let gitMode: Bool
    let gitProjectID: String?
    let workbenchHost: (any WorkbenchHost)?
    private let bridge: CoreBridge
    private let stateBridge: CoreBridge
    private let ownsBridge: Bool
    private var gitMutationInProgress = false
    private var documentID = UUID().uuidString
    private var tasks: [String: Task<Void, Never>] = [:]
    private var permitsClose = false
    private let quitGate = ContentQuitGate()
    private var quitToken: String?
    private var preparedDocument: String?
    var isPreparedForQuit: Bool { permitsClose || (workbenchHost?.prepared ?? (preparedDocument == documentID && (gitMode ? !gitMutationInProgress : quitToken != nil))) }
    private(set) var navigationError = ""
    private var focusLine = 0
    func focusFileLine(_ line: Int) {
        guard editable, !gitMode, workbenchHost == nil, line > 0 else { return }
        focusLine = line
        deliver("file-focus-line", payload: .number(Double(line)))
    }
    var closed: (() -> Void)?
    var mutateGit: ((String, JSONValue, CoreBridge) async throws -> JSONValue)?
    var openRepositoryFile: ((String) async throws -> Void)?
    var recoverGitFavorites: (() throws -> Void)?
    private let entry = URL(string: "uterm-content://bundle/native-content.html")!

    init(bridge: CoreBridge, directory: URL, path: String, editable: Bool = false, gitMode: Bool = false, gitProjectID: String? = nil, stateBridge: CoreBridge? = nil, ownsBridge: Bool = false, workbenchHost: (any WorkbenchHost)? = nil) throws {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("content") else {
            throw BridgeFailure(code: "RESOURCE_MANIFEST", message: "Bundled content is missing")
        }
        let resources = try ContentResources(root: root)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(ContentSchemeHandler(resources: resources), forURLScheme: ContentResources.scheme)
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700), configuration: configuration)
        self.bridge = bridge
        self.stateBridge = stateBridge ?? bridge
        self.ownsBridge = ownsBridge
        let fileRoot = try ContentFileRoot(directory: directory)
        self.directory = fileRoot.resolvedDirectory
        documentDirectory = !gitMode && workbenchHost == nil ? fileRoot.protocolDirectory : fileRoot.resolvedDirectory.path
        self.path = path
        self.editable = editable
        self.gitMode = gitMode
        self.gitProjectID = gitProjectID
        self.workbenchHost = workbenchHost
        let window = NSWindow(contentRect: webView.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = workbenchHost.map { nativeWorkbenchTitle($0.kind) } ?? (gitMode ? "Git — " + self.directory.lastPathComponent : path)
        window.tabbingMode = editable && !gitMode ? .preferred : .disallowed
        window.tabbingIdentifier = "uterm-file:" + self.directory.path
        window.minSize = NSSize(width: gitMode ? 640 : 540, height: gitMode ? 420 : 360)
        window.contentView = webView
        super.init(window: window)
        window.delegate = self
        (workbenchHost as? GitHubHost)?.window = window
        webView.navigationDelegate = self
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "utermContent")
        workbenchHost?.emit = { [weak self] kind, payload in self?.deliver(kind, payload: payload) }
        workbenchHost?.startEvents()
        prepareDocument()
        webView.load(URLRequest(url: entry))
        window.center()
    }
    required init?(coder: NSCoder) { return nil }

    func reveal() {
        guard let window else { return }
        window.tabGroup?.selectedWindow = window
        showWindow(nil)
        window.makeKeyAndOrderFront(nil)
    }

    private func prepareDocument() {
        quitGate.invalidate()
        quitToken = nil
        preparedDocument = nil
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        documentID = UUID().uuidString
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        // Bootstrap errors must use the cached application language before shared settings can be read.
        // 共享设置尚不能读取时，启动错误页必须使用缓存的应用语言。
        let preference = ["en", "zh-Hans", "system"].contains(NativeLocale.preference) ? NativeLocale.preference : "system"
        let language = (try? JSONEncoder().encode(preference)).map { String(decoding: $0, as: UTF8.self) } ?? "\"system\""
        controller.addUserScript(WKUserScript(source: "Object.defineProperties(window,{utermContentDocument:{value:'\(documentID)',writable:false,configurable:false},utermContentLanguage:{value:\(language),writable:false,configurable:false}});", injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
                value["error"] = ["code": (error as? BridgeFailure)?.code ?? (error is CancellationError ? "CANCELLED" : "HOST_ERROR"), "message": (error as? BridgeFailure)?.message ?? error.localizedDescription]
            } else { value["result"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(result ?? .null), options: [.fragmentsAllowed]) }
            handler(value, nil)
        } catch { handler(nil, error.localizedDescription) }
    }
    private func execute(_ request: ContentMessage) async throws -> JSONValue {
        let params = request.params ?? [:]
        if let workbenchHost, !["content_context", "content_copy_text", "open_external", "content_font_adjust", "content_settings_patch"].contains(request.method ?? "") {
            return try await workbenchHost.execute(request.method ?? "", params: params)
        }
        if request.method == "git_favorites_recovery_open" {
            guard gitMode, let recoverGitFavorites else { throw BridgeFailure(code: "METHOD_DENIED", message: "This window cannot open favorite recovery") }
            guard params.count == 1, params["directory"] == .string(directory.path) else { throw BridgeFailure(code: "ROOT_DENIED", message: "Favorite recovery cannot select another repository") }
            try recoverGitFavorites()
            return .null
        }
        if let method = Self.gitFavoriteMethods[request.method ?? ""] {
            guard gitMode else { throw BridgeFailure(code: "METHOD_DENIED", message: "This content window cannot access Git favorites") }
            guard params["directory"] == .string(directory.path) else { throw BridgeFailure(code: "ROOT_DENIED", message: "Git favorites cannot select another repository") }
            guard request.method != "git_favorites_import" || params.count == 1 else { throw BridgeFailure(code: "METHOD_DENIED", message: "Native Git content cannot import old WebView sources") }
            return try await bridge.call(method, params: .object(params))
        }
        if let method = Self.gitMethods[request.method ?? ""] {
            guard gitMode else { throw BridgeFailure(code: "METHOD_DENIED", message: "This content window cannot access Git") }
            guard params["directory"] == .string(directory.path) else { throw BridgeFailure(code: "ROOT_DENIED", message: "Git cannot select another repository") }
            if Self.gitWrites.contains(request.method ?? "") {
                guard !gitMutationInProgress, let mutateGit else { throw BridgeFailure(code: "GIT_BUSY", message: localized("Finish the current repository operation first.", "请先完成当前仓库操作。")) }
                gitMutationInProgress = true
                window?.standardWindowButton(.closeButton)?.isEnabled = false
                defer { gitMutationInProgress = false; window?.standardWindowButton(.closeButton)?.isEnabled = true }
                return try await mutateGit(method, .object(params), bridge)
            }
            return try await bridge.call(method, params: .object(params))
        }
        switch request.method {
        case "content_context":
            let state = try await stateBridge.snapshot()
            return .object(["directory": .string(documentDirectory), "path": .string(path), "line": .number(Double(focusLine)), "settings": state.document.settings, "editable": .bool(editable), "kind": .string(workbenchHost?.kind ?? (gitMode ? "git" : "file"))])
        case "content_copy_text":
            guard params.count == 1, let text = params["text"]?.string else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Missing clipboard text") }
            NSPasteboard.general.clearContents()
            guard NSPasteboard.general.setString(text, forType: .string) else { throw BridgeFailure(code: "COPY_FAILED", message: localized("Could not copy the text.", "无法复制文本。")) }
            return .null
        case "content_open_file":
            guard gitMode, params.count == 1, let path = params["path"]?.string, let openRepositoryFile else { throw BridgeFailure(code: "METHOD_DENIED", message: "This window cannot open repository files") }
            _ = try await bridge.call("files.read", params: .object(["directory": .string(directory.path), "path": .string(path)]))
            try Task.checkCancellation()
            try await openRepositoryFile(path)
            return .null
        case "file_read", "files_list", "files_search":
            guard params["directory"] == .string(documentDirectory) else { throw BridgeFailure(code: "ROOT_DENIED", message: "Content cannot select a different project root") }
            let methods = ["file_read": "files.read", "files_list": "files.list", "files_search": "files.search"]
            return try await bridge.call(methods[request.method!]!, params: .object(params))
        case "editor_drafts_list", "editor_drafts_document":
            guard params["directory"] == .string(documentDirectory) else { throw BridgeFailure(code: "ROOT_DENIED", message: "Draft cannot select another project root") }
            let method = request.method == "editor_drafts_list" ? "editor.drafts.list" : "editor.drafts.document"
            return try await bridge.call(method, params: .object(params))
        case "editor_drafts_put", "editor_drafts_remove":
            guard editable else { throw BridgeFailure(code: "READ_ONLY", message: localized("This window opens files read-only.", "此窗口以只读方式打开文件。")) }
            let draft: JSONValue = request.method == "editor_drafts_put" ? (params["draft"] ?? .null) : .object(params)
            guard draft["directory"] == .string(documentDirectory), draft["path"] == .string(path) else {
                throw BridgeFailure(code: "ROOT_DENIED", message: "Draft cannot select another file or project root")
            }
            let method = request.method == "editor_drafts_put" ? "editor.drafts.putDocument" : "editor.drafts.removeDocument"
            return try await bridge.call(method, params: .object(params))
        case "editor_drafts_import":
            throw BridgeFailure(code: "READ_ONLY", message: localized("This window opens files read-only.", "此窗口以只读方式打开文件。"))
        case "file_save":
            guard editable else { throw BridgeFailure(code: "READ_ONLY", message: localized("This window opens files read-only.", "此窗口以只读方式打开文件。")) }
            guard params["directory"] == .string(documentDirectory), params["path"] == .string(path) else {
                throw BridgeFailure(code: "ROOT_DENIED", message: "Editor cannot save another file or project root")
            }
            return try await bridge.call("files.save", params: .object(params))
        case "file_copy", "file_mutate":
            throw BridgeFailure(code: "READ_ONLY", message: localized("This window opens files read-only.", "此窗口以只读方式打开文件。"))
        case "editor_guard":
            guard params["active"] == .bool(false) || (editable && params["active"] == .bool(true)) else { throw BridgeFailure(code: "READ_ONLY", message: "Native preview cannot enable editing") }
            return .null
        case "editor_prepare_result":
            guard let token = params["token"]?.string, let value = params["ready"], case .bool(let ready) = value else {
                throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Missing content quit result")
            }
            try quitGate.respond(token: token, ready: ready)
            return .null
        case "editor_exit":
            guard !gitMutationInProgress else { throw BridgeFailure(code: "GIT_BUSY", message: localized("Finish the current repository operation first.", "请先完成当前仓库操作。")) }
            forceClose(); return .null
        case "open_external":
            guard let text = params["url"]?.string, let url = URL(string: text), ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, NSWorkspace.shared.open(url) else {
                throw BridgeFailure(code: "URL_DENIED", message: "Could not open external web address")
            }
            return .null
        case "content_font_adjust", "content_settings_patch":
            let snapshot = try await stateBridge.snapshot()
            var values = params
            values["expectedRevision"] = .string(snapshot.revision)
            let method = request.method == "content_font_adjust" ? "settings.font.adjust" : "settings.patch"
            let saved = try await stateBridge.call(method, params: .object(values))
            return saved["document"]["settings"]
        default: throw BridgeFailure(code: "METHOD_DENIED", message: "Content method is not allowed")
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if permitsClose { return true }
        if workbenchHost != nil { sender.orderOut(nil); return false }
        if gitMode {
            if !gitMutationInProgress { forceClose() }
            return false
        }
        if quitToken != nil { return false }
        let event: [String: Any] = ["version": 1, "document": documentID, "kind": "editor-close-request", "payload": NSNull()]
        if let bytes = try? JSONSerialization.data(withJSONObject: event), let json = String(data: bytes, encoding: .utf8) {
            webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('uterm-content-event',{detail:\(json)}));")
        }
        if editable { return false }
        // This window only previews files; it must also close when its Web content fails.
        // 此窗口只预览文件；Web 内容失效时也必须能关闭。
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard let self, !self.permitsClose, self.quitToken == nil, self.window?.isVisible == true else { return }
            self.forceClose()
        }
        return false
    }
    func forceClose() {
        workbenchHost?.stopEvents()
        quitGate.invalidate()
        quitToken = nil
        preparedDocument = nil
        permitsClose = true
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "utermContent", contentWorld: .page)
        window?.close()
    }
    private func event(_ kind: String, token: String) throws {
        let value: [String: Any] = ["version": 1, "document": documentID, "kind": kind, "payload": token]
        let json = String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8)!
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('uterm-content-event',{detail:\(json)}));") { [weak self] _, error in
            if let self, error != nil, self.quitToken == token { self.quitGate.invalidate() }
        }
    }
    private func deliver(_ kind: String, payload: JSONValue) {
        let value: JSONValue = .object(["version": .number(1), "document": .string(documentID), "kind": .string(kind), "payload": payload])
        guard !permitsClose, let bytes = try? JSONEncoder().encode(value), let json = String(data: bytes, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('uterm-content-event',{detail:\(json)}));")
    }
    func prepareForQuit(timeout: Duration = .seconds(20)) async throws -> Bool {
        if permitsClose { return true }
        if let workbenchHost { return try await workbenchHost.prepareForQuit() }
        if gitMode {
            if gitMutationInProgress { return false }
            preparedDocument = documentID
            return true
        }
        guard quitToken == nil else { throw BridgeFailure(code: "QUIT_BUSY", message: "Content is already preparing to quit") }
        let sourceDocument = documentID
        do {
            let ready = try await quitGate.prepare(timeout: timeout) { token in
                quitToken = token
                try event("editor-prepare-quit", token: token)
            }
            guard sourceDocument == documentID, quitToken != nil else {
                throw BridgeFailure(code: "CONTENT_CHANGED", message: "Content changed before quit preparation completed")
            }
            if ready { preparedDocument = sourceDocument }
            else { resumeAfterQuit() }
            return ready
        } catch { resumeAfterQuit(); throw error }
    }
    func resumeAfterQuit() {
        if let workbenchHost { Task { await workbenchHost.resumeAfterQuit() }; return }
        if gitMode { preparedDocument = nil; return }
        guard let token = quitToken else { return }
        quitToken = nil
        preparedDocument = nil
        quitGate.invalidate()
        try? event("editor-resume", token: token)
    }
    func refreshAfterRepositoryMutation() {
        guard !permitsClose, !gitMode else { return }
        try? event("editor-repository-refresh", token: UUID().uuidString)
    }
    func windowWillClose(_ notification: Notification) {
        quitGate.invalidate()
        closed?()
        if ownsBridge { let worker = bridge; Task { await worker.close() } }
    }
    func favoritesDidRestore() {
        guard gitMode else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('uterm:git-favorites-restored'))") { _, _ in }
    }
    private static let gitMethods: [String: String] = [
        "git_branch": "git.branch", "git_branches": "git.branches", "git_switch_branch": "git.switchBranch",
        "git_rollback_file": "git.rollbackFile", "git_remote_branches": "git.remoteBranches", "git_switch_remote_branch": "git.switchRemoteBranch",
        "git_branch_action": "git.branchAction", "git_file_status": "git.fileStatus", "git_snapshot": "git.snapshot",
        "git_diff": "git.diff", "git_history": "git.history", "git_files": "git.files", "git_references": "git.references",
        "git_reference_action": "git.referenceAction", "git_working_comparison": "git.workingComparison",
        "project_worktrees": "git.worktrees.list", "create_worktree": "git.worktrees.create",
        "worktree_suggestion": "git.worktrees.suggestion"
    ]
    private static let gitFavoriteMethods: [String: String] = [
        "git_favorites_read": "git.favorites.read", "git_favorites_import": "git.favorites.import", "git_favorites_write": "git.favorites.write"
    ]
    private static let gitWrites: Set<String> = ["git_switch_branch", "git_rollback_file", "git_switch_remote_branch", "git_branch_action", "git_reference_action", "create_worktree"]
}
