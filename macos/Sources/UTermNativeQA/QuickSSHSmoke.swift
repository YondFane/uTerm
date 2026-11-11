import AppKit
import UTermBridge

@MainActor
enum QuickSSHSmoke {
    private static func table(_ window: NSWindow) -> NSTableView? {
        window.contentView.flatMap { TerminalSmoke.descendants($0).first { $0.identifier?.rawValue == "native-sidebar" } as? NSTableView }
    }
    private static func control(_ window: NSWindow, id: String) -> NSView? {
        if let table = table(window) {
            for row in 0..<table.numberOfRows { _ = table.view(atColumn: 0, row: row, makeIfNecessary: true) }
        }
        return window.contentView.flatMap { TerminalSmoke.descendants($0).first { $0.identifier?.rawValue == id } }
    }
    private static func connections(_ model: WorkspaceModel) -> [JSONValue] {
        model.groups.flatMap { (group: JSONValue) -> [JSONValue] in group["sshConnections"].array }
    }
    private static func createdTemporary(_ model: WorkspaceModel) -> Bool {
        connections(model).contains(where: { profile in
            guard profile["temporary"].bool == true, profile["sessions"].array.count == 1 else { return false }
            return profile["host"].string == "127.0.0.1" && profile["port"].number == 1
        })
    }
    private static func address(_ content: ContentWindow, _ text: String) async throws {
        guard let window = content.window, window.makeFirstResponder(content.webView), try await EditorSmoke.evaluate(content, script: """
            const input=document.querySelector('.ssh-quick-dialog input');if(!input)return false;
            input.focus();input.select();return document.execCommand('insertText',false,text);
            """, arguments: ["text": text]) else { throw BridgeFailure(code: "QUICK_SSH_INPUT", message: "Quick SSH input did not accept actual WebKit typing") }
    }
    static func run(model: WorkspaceModel, window: NSWindow, lookup: @escaping () -> ContentWindow?, report: inout [String: Any]) async throws {
        guard let bridge = model.bridge, let path = WorkspaceModel.argument("--inspector-smoke-report") else { throw BridgeFailure(code: "QUICK_SSH_CONTEXT", message: "Missing isolated quick SSH context") }
        let workspaceID = model.groupID, firstID = UUID().uuidString, secondID = UUID().uuidString
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        model.sidebarSection = "all"; model.sidebarVisible = true; model.sidebarQuery = ""
        window.setContentSize(NSSize(width: 1100, height: 720)); window.makeKeyAndOrderFront(nil)
        for (id, name) in [(firstID, "Alpha production"), (secondID, "Beta staging")] {
            let target: JSONValue = .object(["connection_id": .string(id), "workspace_id": .string(workspaceID), "name": .string(name), "host": .string("127.0.0.1"), "os": .string("posix"), "root": .string("/root-only-needle"), "mode": .string("alias"), "authentication": .string("config")])
            guard await model.mutate("ssh.profile.save", ["connection": target]) else { throw BridgeFailure(code: "QUICK_SSH_PROFILE", message: model.error) }
        }
        try await TerminalSmoke.wait("Mount actual SSH search within All") { control(window, id: "native-sidebar-filter") is NSSearchField }
        guard let search = control(window, id: "native-sidebar-filter") as? NSSearchField, window.makeFirstResponder(search), let editor = window.firstResponder as? NSTextView else { throw BridgeFailure(code: "QUICK_SSH_SEARCH", message: "SSH search cannot receive native input") }
        editor.selectAll(nil); editor.insertText("ALPHA" as NSString, replacementRange: NSRange(location: NSNotFound, length: 0))
        try await TerminalSmoke.wait("Filter actual SSH host rows and retain the focused editor") {
            model.sidebarQuery == "ALPHA" && control(window, id: "native-sidebar-row-q:" + firstID) != nil && control(window, id: "native-sidebar-row-q:" + secondID) == nil && search.currentEditor() === window.firstResponder
        }
        let selected = model.selectedID, generations = model.terminals.mapValues { $0.generation }
        let root = URL(fileURLWithPath: path).deletingLastPathComponent()
        func capture(_ name: String, window: NSWindow) async throws {
            try await TerminalSmoke.capture(window: window, path: root.appendingPathComponent(name))
            report["captures"] = (report["captures"] as? [String] ?? []) + [name]
        }
        try await capture("native-ssh-host-filter-en-dark.png", window: window)
        model.sidebarSection = "ssh"
        try await TerminalSmoke.wait("Retain host query across categories") { control(window, id: "native-sidebar-filter") != nil && model.sidebarQuery == "ALPHA" }
        model.sidebarQuery = "root-only-needle"
        try await TerminalSmoke.wait("Exclude file roots from host search") { control(window, id: "native-sidebar-row-q:" + firstID) == nil && control(window, id: "native-sidebar-row-q:" + secondID) == nil }
        model.sidebarQuery = ""; model.sidebarSection = "all"
        try await TerminalSmoke.wait("Restore hosts after clearing the query") { control(window, id: "native-sidebar-row-q:" + firstID) != nil && control(window, id: "native-sidebar-row-q:" + secondID) != nil }
        guard model.selectedID == selected, model.terminals.mapValues({ $0.generation }) == generations else { throw BridgeFailure(code: "QUICK_SSH_SEARCH", message: "Host filtering changed terminal identity") }
        report["nativeSSHSearchAllAndCategoryRetainFocusAndSessions"] = true
        func open() async throws -> ContentWindow {
            guard let button = control(window, id: "native-ssh-quick") as? NSButton, button.isEnabled else { throw BridgeFailure(code: "QUICK_SSH_BUTTON", message: "Missing actual Quick SSH button") }
            button.performClick(nil)
            try await TerminalSmoke.wait("Open shared Quick SSH through the actual sidebar button") { lookup()?.window?.isVisible == true }
            guard let content = lookup() else { throw BridgeFailure(code: "QUICK_SSH_WINDOW", message: "Quick SSH window is missing") }
            try await ContentSmoke.wait(content, "document.querySelector('.ssh-quick-dialog[open] input') !== null")
            return content
        }
        var quick = try await open()
        let before = try await bridge.snapshot()
        try await address(quick, "ssh://dev:private@example.com")
        _ = try await quick.webView.evaluateJavaScript("document.querySelector('form').requestSubmit()")
        try await ContentSmoke.wait(quick, "document.querySelector('[role=alert]') !== null", allowAlert: true)
        guard (try await bridge.snapshot()).revision == before.revision else { throw BridgeFailure(code: "QUICK_SSH_INVALID", message: "Invalid quick input changed shared state") }
        if let current = quick.window { try await capture("native-quick-ssh-invalid-en-dark.png", window: current) }
        try await EditorSmoke.click(quick, title: "Cancel")
        try await TerminalSmoke.wait("Cancel Quick SSH without saving") { lookup() == nil && !model.quickSSHPresented }
        guard (try await bridge.snapshot()).revision == before.revision else { throw BridgeFailure(code: "QUICK_SSH_CANCEL", message: "Cancellation changed shared state") }
        quick = try await open()
        let other = UUID().uuidString
        guard await model.mutate("workspace.create", ["id": .string(other), "name": .string("Other quick workspace"), "select": .bool(true)]) else { throw BridgeFailure(code: "QUICK_SSH_CONFLICT", message: model.error) }
        let switched = try await bridge.snapshot()
        try await address(quick, "dev@[::1]:2222")
        _ = try await quick.webView.evaluateJavaScript("document.querySelector('form').requestSubmit()")
        try await ContentSmoke.wait(quick, "document.querySelector('[role=alert]') !== null && !document.querySelector('input').disabled", allowAlert: true)
        guard (try await bridge.snapshot()).revision == switched.revision else { throw BridgeFailure(code: "QUICK_SSH_CONFLICT", message: "Stale quick dialog wrote into another workspace") }
        try await EditorSmoke.click(quick, title: "Cancel")
        try await TerminalSmoke.wait("Close rejected stale quick dialog") { lookup() == nil }
        guard await model.mutate("workspace.switch", ["id": .string(workspaceID)]) else { throw BridgeFailure(code: "QUICK_SSH_RESTORE", message: model.error) }
        report["nativeQuickSSHInvalidCancelAndStaleWorkspacePreserveState"] = true
        quick = try await open()
        try await address(quick, "ssh://127.0.0.1:1")
        _ = try await quick.webView.evaluateJavaScript("document.querySelector('form').requestSubmit()")
        try await TerminalSmoke.wait("Commit the temporary connection and close the shared form") {
            guard lookup() == nil, model.selectedID != nil else { return false }
            return createdTemporary(model)
        }
        guard let profile = connections(model).first(where: { $0["temporary"].bool == true }), let id = profile["id"].string, let session = profile["sessions"].array.first?["id"].string else { throw BridgeFailure(code: "QUICK_SSH_CREATED", message: "Temporary connection or first session is missing") }
        await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
        window.makeKeyAndOrderFront(nil)
        try await capture("native-quick-ssh-temporary-light-zh.png", window: window)
        guard let sidebar = table(window), let coordinator = sidebar.delegate as? NativeSidebar.Coordinator else { throw BridgeFailure(code: "QUICK_SSH_KEEP", message: "Missing actual sidebar menu") }
        var row: Int?
        for index in 0..<sidebar.numberOfRows where sidebar.view(atColumn: 0, row: index, makeIfNecessary: true)?.identifier?.rawValue == "native-sidebar-row-q:" + id { row = index }
        guard let row else { throw BridgeFailure(code: "QUICK_SSH_KEEP", message: "Missing temporary host row") }
        let menu = NSMenu(); coordinator.populate(menu, row: row)
        guard let keep = menu.items.first(where: { $0.title == "保存为常用连接" }), let action = keep.action, keep.isEnabled, NSApp.sendAction(action, to: keep.target, from: keep) else { throw BridgeFailure(code: "QUICK_SSH_KEEP", message: "Actual keep-connection menu action is missing") }
        try await TerminalSmoke.wait("Keep the existing connection without replacing its session") {
            connections(model).contains(where: { profile in
                guard profile["id"].string == id, profile["temporary"].bool == false else { return false }
                return profile["sessions"].array.first?["id"].string == session
            })
        }
        await model.closeSession(id: session)
        guard connections(model).contains(where: { $0["id"].string == id }) else { throw BridgeFailure(code: "QUICK_SSH_KEEP", message: "Closing the final session removed a saved connection") }
        quick = try await open()
        try await address(quick, "ssh://127.0.0.1:1")
        _ = try await quick.webView.evaluateJavaScript("document.querySelector('form').requestSubmit()")
        try await TerminalSmoke.wait("Create another temporary connection for actual close cleanup") { lookup() == nil && createdTemporary(model) }
        guard let temporary = connections(model).first(where: { $0["temporary"].bool == true }), let temporaryID = temporary["id"].string, let temporarySession = temporary["sessions"].array.first?["id"].string else { throw BridgeFailure(code: "QUICK_SSH_PRUNE", message: "Missing temporary cleanup fixture") }
        await model.closeSession(id: temporarySession)
        guard !connections(model).contains(where: { $0["id"].string == temporaryID }) else { throw BridgeFailure(code: "QUICK_SSH_PRUNE", message: "Closing the final session retained an idle temporary connection") }
        report["nativeQuickSSHActualFinalSessionPrunesTemporary"] = true
        for id in [firstID, secondID, id] { guard await model.mutate("ssh.profile.remove", ["id": .string(id)]) else { throw BridgeFailure(code: "QUICK_SSH_CLEANUP", message: model.error) } }
        report["nativeQuickSSHActualCreateAndKeepRetainSession"] = true
        report["quickSSHScenario"] = "Real WebKit form and AppKit search/menu; loopback port 1 exercises failure without external credentials; no authenticated remote login acceptance"
    }
}
