import AppKit
import UTermBridge

@MainActor
enum InspectorSmoke {
    private static func command(_ id: String) throws {
        guard let item = NSApp.mainMenu?.items.compactMap(\.submenu).flatMap(\.items).first(where: { $0.representedObject as? String == id }),
              let action = item.action, NSApp.sendAction(action, to: item.target, from: item) else { throw BridgeFailure(code: "INSPECTOR_MENU", message: "Missing command: " + id) }
    }
    private static func view(_ window: NSWindow, id: String) -> NSView? {
        var queue = window.contentView.map { [$0] } ?? []
        while !queue.isEmpty { let next = queue.removeFirst(); if next.identifier?.rawValue == id { return next }; queue += next.subviews }
        return nil
    }
    static func run(model: WorkspaceModel, window: NSWindow, lookup: @escaping (URL, String) -> ContentWindow?, quickLookup: @escaping () -> ContentWindow?, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.bridge, let reportPath = WorkspaceModel.argument("--inspector-smoke-report") else { throw BridgeFailure(code: "INSPECTOR_CONTEXT", message: "Missing isolated inspector context") }
        let root = try WorkspaceModel.dataRoot().appendingPathComponent("inspector-project")
        let nested = root.appendingPathComponent("nested")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try Data("FIRST\nMATCH_中文 é\nLAST\n".utf8).write(to: nested.appendingPathComponent("notes-中文.txt"))
        try Data("HIDDEN_ONLY\n".utf8).write(to: root.appendingPathComponent(".hidden.txt"))
        let outside = root.deletingLastPathComponent().appendingPathComponent("outside-private.txt")
        try Data("MATCH_PRIVATE_DO_NOT_SHOW\n".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape.txt"), withDestinationURL: outside)
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark"), "inspectorPosition": .string("right")])
        guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("Inspector QA"), "directory": .string(root.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "INSPECTOR_PROJECT", message: model.error) }
        await model.newTerminal()
        try await TerminalSmoke.wait("Start inspector fixture PTY and consume its initial frame") { model.selectedTerminal?.generation != nil && model.selectedTerminal?.error.isEmpty == true && model.selectedTerminal?.inputControl?.owned == true && (model.selectedTerminal?.qaRenderedFrames ?? 0) > 0 }
        guard let first = model.selectedTerminal else { throw BridgeFailure(code: "INSPECTOR_PTY", message: "No terminal") }
        first.enqueue(Data("printf 'INSPECTOR_%s\\n' READY\r".utf8))
        try await TerminalSmoke.wait("Render inspector fixture output") { first.text.contains("INSPECTOR_READY") }
        window.setContentSize(NSSize(width: 1100, height: 680)); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        try await TerminalSmoke.wait("Focus main workspace") { window.isKeyWindow }
        try command("files")
        let tools = model.inspector
        try await TerminalSmoke.wait("Mount shared file tools in the actual inspector") { model.inspectorVisible && tools.content?.webView.window === window }
        guard let files = tools.content else { throw BridgeFailure(code: "INSPECTOR_FILES", message: "Shared file tools are missing") }
        defer {
            report["toolsAttachmentDiagnostics"] = ["keyWindowIsMain": window.isKeyWindow, "filesWindowIsMain": files.webView.window === window, "currentDocumentRetained": tools.content === files, "mode": tools.mode.rawValue, "hierarchy": files.webView.superview.map { String(describing: $0) } ?? "detached"]
        }
        try await ContentSmoke.wait(files, "document.querySelector('.file-row[data-path=\"nested\"]') !== null && document.querySelector('.file-row[data-path=\".hidden.txt\"]') !== null")
        guard try await ContentSmoke.request(files, method: "content_open_file", params: ["path": "escape.txt", "line": 0]) == "FILE_ERROR", lookup(root, "escape.txt") == nil else { throw BridgeFailure(code: "INSPECTOR_SCOPE", message: "Outside-root link opened in an editor") }
        guard try await EditorSmoke.evaluate(files, script: "document.querySelector('.file-row[data-path=\"nested\"]').click();return true;", arguments: [:]) else { throw BridgeFailure(code: "INSPECTOR_FOLDER", message: "Folder control did not activate") }
        try await ContentSmoke.wait(files, "document.querySelector('.file-row[data-path=\"nested/notes-中文.txt\"]') !== null && document.querySelector('.file-row[data-path=\"nested\"]').getAttribute('aria-expanded') === 'true'")
        _ = try await files.webView.evaluateJavaScript("document.querySelector('.file-row[data-path=\"nested\"]').click()")
        try await ContentSmoke.wait(files, "document.querySelector('.file-row[data-path=\"nested/notes-中文.txt\"]') === null")
        let wrongRoot = try await ContentSmoke.request(files, method: "file_mutate", params: ["directory": root.deletingLastPathComponent().path, "path": "", "action": "file", "name": "must-not-exist.txt"])
        let unknown = try await ContentSmoke.request(files, method: "host.close", params: [:])
        guard wrongRoot == "ROOT_DENIED", unknown != "SUCCESS", !FileManager.default.fileExists(atPath: root.deletingLastPathComponent().appendingPathComponent("must-not-exist.txt").path) else { throw BridgeFailure(code: "INSPECTOR_SCOPE", message: "File tool root or method boundary failed") }
        report["nativeFilesHiddenNavigationAndSymlinkBoundary"] = true
        report["sharedFilesRootAndMethodBoundaries"] = true
        try await FileToolsSmoke.run(files, root: root, report: &report)
        var captures: [String] = []
        func capture(_ name: String) async throws { try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name)) }
        try await capture("native-inspector-files-dark-en.png"); captures.append("native-inspector-files-dark-en.png"); report["captures"] = captures
        try command("search")
        try await ContentSmoke.wait(files, "document.querySelector('.file-query') !== null")
        func query(_ text: String) async throws {
            window.makeKeyAndOrderFront(nil)
            guard window.makeFirstResponder(files.webView), try await EditorSmoke.evaluate(files, script: """
                const field=document.querySelector('.file-query');if(!field) return false;
                field.focus();field.select();return document.execCommand('insertText',false,text);
                """, arguments: ["text": text]) else { throw BridgeFailure(code: "INSPECTOR_QUERY", message: "Shared query did not accept actual WebKit input") }
        }
        try await query("MATCH_中文")
        try await ContentSmoke.wait(files, "document.querySelectorAll('.file-hit').length === 1 && document.querySelector('.file-hit').textContent.includes('nested/notes-中文.txt:2')")
        try await TerminalSmoke.wait("Focus the actual project search") { model.inspectorOwnsFocus }
        let queryResponder = window.firstResponder, queryFrames = first.qaRenderedFrames
        first.enqueue(Data("printf 'F_%s\\n' OK\r".utf8))
        try await TerminalSmoke.wait("Render background PTY output while project search has focus") { first.qaRenderedFrames > queryFrames && first.text.contains("F_OK") }
        guard window.firstResponder === queryResponder else { throw BridgeFailure(code: "INSPECTOR_QUERY_FOCUS", message: "Background PTY output stole project-search focus") }
        try await ContentSmoke.wait(files, "document.activeElement === document.querySelector('.file-query') && document.querySelector('.file-query').value === 'MATCH_中文'")
        report["nativeInspectorQueryFocusSurvivesPTYOutput"] = true
        try TerminalSmoke.postKey(window: window, code: 36, characters: "\r")
        try await TerminalSmoke.wait("Open the shared search result through actual Return") { lookup(root, "nested/notes-中文.txt") != nil }
        guard let content = lookup(root, "nested/notes-中文.txt") else { throw BridgeFailure(code: "INSPECTOR_OPEN", message: "Search result did not open") }
        try await ContentSmoke.wait(content, "document.querySelector('.editor-status')?.textContent.includes('Line 2') === true")
        report["nativeSearchReturnOpenedExactLine"] = true
        // Navigating within an existing editor must retain its unsaved document.
        // 在现有编辑器内跳转时必须保留尚未保存的文档。
        try await EditorSmoke.replace(content, text: "UNSAVED_INSPECTOR\nMATCH_中文 é\nEND\n")
        content.focusFileLine(2)
        try await ContentSmoke.wait(content, "document.querySelector('.cm-content')?.textContent.includes('UNSAVED_INSPECTOR') === true && document.querySelector('.editor-status')?.textContent.includes('Line 2') === true")
        report["searchJumpRetainsExistingEditorText"] = true
        try await EditorSmoke.click(content, title: "Save")
        try await ContentSmoke.wait(content, "document.querySelector('.editor-save-state')?.textContent.trim() === 'Saved'")
        content.window?.performClose(nil)
        try await TerminalSmoke.wait("Close clean search result editor") { content.window?.isVisible == false }
        window.makeKeyAndOrderFront(nil)
        try await TerminalSmoke.wait("Return to project search") { window.isKeyWindow }
        try await capture("native-inspector-search-dark-en.png"); captures.append("native-inspector-search-dark-en.png"); report["captures"] = captures
        try await query("MATCH_中文")
        try await query("NO_SUCH_MATCH")
        try await ContentSmoke.wait(files, "document.querySelector('.file-query').value === 'NO_SUCH_MATCH' && document.querySelectorAll('.file-hit').length === 0 && !document.querySelector('.file-results').textContent.includes('Searching')")
        try command("quick")
        try await ContentSmoke.wait(files, "document.querySelector('.file-query')?.getAttribute('aria-label') === 'Search file paths'")
        try await query("notes-中文")
        try await ContentSmoke.wait(files, "document.querySelectorAll('.file-hit').length === 1 && document.querySelector('.file-hit').title === 'nested/notes-中文.txt'")
        guard tools.mode == .quick else { throw BridgeFailure(code: "INSPECTOR_QUICK", message: "Shared quick-open tab did not update native command state") }
        report["cancelledSearchAndFilenameQuickOpen"] = true
        await model.split("horizontal")
        try await TerminalSmoke.wait("Start second inspector fixture PTY") { model.terminals.count == 2 && model.selectedTerminal?.generation != nil && model.selectedTerminal?.error.isEmpty == true }
        guard let second = model.selectedTerminal, second.id != first.id else { throw BridgeFailure(code: "INSPECTOR_SPLIT", message: "No split peer") }
        try await TerminalSmoke.wait("Show two terminal views") { first.view.window === window && second.view.window === window }
        let layout = model.state?.layout, ids = Set(model.terminals.keys), firstView = ObjectIdentifier(first.view), secondView = ObjectIdentifier(second.view)
        try command("swapPanes")
        try await TerminalSmoke.wait("Persist left tools preference") { !model.busy && model.settings["inspectorPosition"].string == "left" }
        try await TerminalSmoke.wait("Retain the actual WebKit file tools after swapping") { tools.content === files && files.webView.window === window && files.webView.visibleRect.width > 0 && files.webView.visibleRect.height > 0 }
        try command("zoom")
        try await TerminalSmoke.wait("Zoom selected terminal only") { model.paneZoomed && second.view.window === window && first.view.window == nil }
        let renderedBefore = first.qaRenderedFrames, acknowledgedBefore = first.qaAcknowledgedFrames
        func hiddenDiagnostics() -> [String: Any] { ["id": first.id, "generation": first.generation ?? "", "columns": first.view.getTerminal().cols, "rows": first.view.getTerminal().rows, "ownedInput": first.inputControl?.owned == true, "error": first.error, "renderedFrames": first.qaRenderedFrames, "acknowledgedFrames": first.qaAcknowledgedFrames, "text": String(first.text.suffix(3000))] }
        report["hiddenZoomBefore"] = hiddenDiagnostics()
        // Keep the marker within a narrow pane; soft wrapping must not hide a successful output/ack check.
        // 标记须适合窄窗格，避免软换行掩盖已成功的输出与确认检查。
        first.enqueue(Data("printf '\\033[32mZ中%s\\033[0m\\n' OK\r".utf8))
        do {
            try await TerminalSmoke.wait("Continue hidden terminal output and acknowledgements while zoomed") { first.text.contains("Z中OK") && first.qaRenderedFrames > renderedBefore && first.qaAcknowledgedFrames > acknowledgedBefore }
        } catch { report["hiddenZoomAfter"] = hiddenDiagnostics(); throw error }
        report["hiddenZoomAfter"] = hiddenDiagnostics()
        try await capture("native-inspector-zoom-dark-en.png"); captures.append("native-inspector-zoom-dark-en.png"); report["captures"] = captures
        try command("zoom")
        try await TerminalSmoke.wait("Restore original split views") { !model.paneZoomed && first.view.window === window && second.view.window === window }
        try await TerminalSmoke.wait("Keep the actual file tools attached after restoring split views") { tools.content === files && files.webView.window === window && files.webView.visibleRect.width > 0 && files.webView.visibleRect.height > 0 }
        guard model.state?.layout == layout, Set(model.terminals.keys) == ids, ObjectIdentifier(first.view) == firstView, ObjectIdentifier(second.view) == secondView else { throw BridgeFailure(code: "INSPECTOR_IDENTITY", message: "Swap or zoom replaced a session, view or shared layout") }
        report["paneSwapAndZoomRetainLayoutViewsAndOutput"] = true
        guard window.makeFirstResponder(files.webView) else { throw BridgeFailure(code: "INSPECTOR_CLOSE_FOCUS", message: "Shared tools cannot regain focus") }
        _ = try await files.webView.evaluateJavaScript("document.querySelector('.file-query')?.focus()")
        do { try await TerminalSmoke.wait("Return focus to the actual shared tools") { model.inspectorOwnsFocus } }
        catch {
            report["toolsFocusDiagnostics"] = ["keyWindowIsMain": window.isKeyWindow, "responder": String(describing: window.firstResponder), "filesWindowIsMain": files.webView.window === window, "currentDocumentRetained": tools.content === files, "mode": tools.mode.rawValue, "hierarchy": files.webView.superview.map { String(describing: $0) } ?? "detached"]
            throw error
        }
        try command("close")
        try await TerminalSmoke.wait("Close tools and return focus to terminal") { !model.inspectorVisible && window.firstResponder === second.view }
        guard Set(model.terminals.keys) == ids else { throw BridgeFailure(code: "INSPECTOR_CLOSE", message: "Close tools terminated a PTY") }
        report["closeFocusedToolsRetainsPTYAndReturnsFocus"] = true
        model.sidebarVisible = false
        await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
        try command("files")
        try await TerminalSmoke.wait("Restore tools without project sidebar") { model.inspectorVisible && tools.content?.webView.window === window }
        try await ContentSmoke.wait(files, "document.querySelector('.file-panel')?.getAttribute('aria-label') === '文件面板' && document.querySelector('.file-row[data-path=\"nested\"]') !== null")
        window.setContentSize(NSSize(width: 680, height: 600))
        try await Task.sleep(for: .milliseconds(200))
        guard let container = view(window, id: "native-inspector-container"), container.frame.width >= 210 else { throw BridgeFailure(code: "INSPECTOR_NARROW", message: "Inspector disappeared with hidden sidebar") }
        try await capture("native-inspector-files-light-zh-narrow.png"); captures.append("native-inspector-files-light-zh-narrow.png"); report["captures"] = captures
        report["leftToolsRemainVisibleWithoutSidebar"] = true
        report["captures"] = captures
        report["inputMethod"] = "Actual NSMenu, AppKit Return, shared WK file controls and DOM insertText; not manual IME acceptance"
        report["manualAcceptance"] = "waived by user"
        guard let oldHost = files.workbenchHost as? FilesHost else { throw BridgeFailure(code: "INSPECTOR_HOST", message: "Shared file host is missing") }
        let deniedClipboard = try await ContentSmoke.request(files, method: "files_clipboard", params: ["value": ["directory": root.deletingLastPathComponent().path, "path": "outside-private.txt"]])
        guard deniedClipboard == "ROOT_DENIED" else { throw BridgeFailure(code: "INSPECTOR_CLIPBOARD", message: "Clipboard accepted an unselected source root") }
        try await FileToolsSmoke.menu(files, path: ".hidden.txt", title: "复制")
        try await TerminalSmoke.wait("Retain the copied source in native memory") { oldHost.context?()["clipboard"]["path"].string == ".hidden.txt" }
        let other = root.deletingLastPathComponent().appendingPathComponent("other-file-project")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("Other files"), "directory": .string(other.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "INSPECTOR_PROJECT", message: model.error) }
        do {
            _ = try await oldHost.execute("file_mutate", params: ["directory": .string(root.path), "path": .string(""), "action": .string("file"), "name": .string("stale-must-not-exist.txt")])
            throw BridgeFailure(code: "INSPECTOR_STALE_ACCEPTED", message: "Old file tools accepted a write after switching projects")
        } catch let error as BridgeFailure {
            guard ["CONFLICT", "ROOT_DENIED", "FILES_QUITTING"].contains(error.code), !FileManager.default.fileExists(atPath: root.appendingPathComponent("stale-must-not-exist.txt").path) else { throw error }
        }
        report["sharedFilesStaleProjectRejected"] = true
        try await TerminalSmoke.wait("Mount new project file tools after replacing the old WebKit document") { model.inspector.content !== files && model.inspector.content?.webView.window === window }
        guard let destination = model.inspector.content else { throw BridgeFailure(code: "INSPECTOR_CLIPBOARD", message: "Destination file tools are missing") }
        try await ContentSmoke.wait(destination, "document.querySelector('.file-results') !== null")
        _ = try await destination.webView.evaluateJavaScript("document.querySelector('.file-results').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:120}))")
        try await ContentSmoke.wait(destination, "[...document.querySelectorAll('[role=menuitem]')].some(button=>button.textContent.trim()==='粘贴'&&!button.disabled)")
        try await EditorSmoke.click(destination, title: "粘贴")
        try await TerminalSmoke.wait("Paste the retained source into the new project") { (try? Data(contentsOf: other.appendingPathComponent(".hidden.txt"))) == Data("HIDDEN_ONLY\n".utf8) }
        report["sharedFilesAcrossProjectsRetainCopiedSource"] = true
        try await capture("native-inspector-copy-across-projects-light-zh.png")
        captures.append("native-inspector-copy-across-projects-light-zh.png"); report["captures"] = captures
        try await QuickSSHSmoke.run(model: model, window: window, lookup: quickLookup, report: &report)
        for id in Array(model.terminals.keys) { await model.selectSession(id); await model.closeSession() }
        let status = try await bridge.call("host.status")
        guard status["sessions"].array.isEmpty else { throw BridgeFailure(code: "INSPECTOR_CLEANUP", message: "Fixture host sessions remain") }
        _ = try await bridge.call("host.shutdownIdle")
        report["explicitFixtureCloseAndIdleHostShutdown"] = true
    }
}
