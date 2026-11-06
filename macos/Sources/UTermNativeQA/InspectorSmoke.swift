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
    static func run(model: WorkspaceModel, window: NSWindow, lookup: @escaping (URL, String) -> ContentWindow?, report: inout [String: Any]) async throws {
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
        try await TerminalSmoke.wait("Render shared file list") { model.inspectorVisible && !tools.busy && tools.rows.contains { $0["path"].string == "nested" } }
        guard !tools.rows.contains(where: { $0["path"].string == ".hidden.txt" }), let escape = tools.rows.firstIndex(where: { $0["path"].string == "escape.txt" && $0["symlink"].bool == true }) else { throw BridgeFailure(code: "INSPECTOR_SCOPE", message: "Hidden filter or symlink marker failed") }
        await tools.activate(escape)
        guard !tools.error.isEmpty, lookup(root, "escape.txt") == nil else { throw BridgeFailure(code: "INSPECTOR_SCOPE", message: "Outside-root link opened in an editor") }
        tools.hidden = true; try await Task.sleep(for: .milliseconds(50)); await tools.reload()
        guard tools.rows.contains(where: { $0["path"].string == ".hidden.txt" }) else { throw BridgeFailure(code: "INSPECTOR_HIDDEN", message: "Hidden filter failed") }
        tools.hidden = false; try await Task.sleep(for: .milliseconds(50)); await tools.reload()
        guard let row = tools.rows.firstIndex(where: { $0["path"].string == "nested" }) else { throw BridgeFailure(code: "INSPECTOR_FOLDER", message: "Nested folder missing") }
        await tools.activate(row)
        guard tools.path == "nested", tools.rows.count == 1 else { throw BridgeFailure(code: "INSPECTOR_FOLDER", message: "Folder navigation failed") }
        await tools.up()
        guard tools.path.isEmpty else { throw BridgeFailure(code: "INSPECTOR_UP", message: "Up did not return to root") }
        report["nativeFilesHiddenNavigationAndSymlinkBoundary"] = true
        var captures: [String] = []
        func capture(_ name: String) async throws { try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name)) }
        try await capture("native-inspector-files-dark-en.png"); captures.append("native-inspector-files-dark-en.png")
        try command("search")
        try await Task.sleep(for: .milliseconds(150))
        tools.query = "MATCH_中文"; await tools.reload()
        guard tools.rows.count == 1, tools.rows[0]["path"].string == "nested/notes-中文.txt", tools.rows[0]["line"].number == 2 else { throw BridgeFailure(code: "INSPECTOR_SEARCH", message: "Shared content search did not return the Unicode line") }
        try await TerminalSmoke.wait("Create native search result table") { view(window, id: "native-inspector-rows") is NSTableView }
        guard let table = view(window, id: "native-inspector-rows") as? NSTableView else { throw BridgeFailure(code: "INSPECTOR_TABLE", message: "No native table") }
        table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
        guard window.makeFirstResponder(table), model.inspectorOwnsFocus,
              let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36) else { throw BridgeFailure(code: "INSPECTOR_FOCUS", message: "Result table did not own keyboard focus") }
        NSApp.sendEvent(event)
        try await TerminalSmoke.wait("Open search result through Return") { lookup(root, "nested/notes-中文.txt") != nil }
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
        try await capture("native-inspector-search-dark-en.png"); captures.append("native-inspector-search-dark-en.png")
        let cancelled = Task { @MainActor in await tools.reload() }; cancelled.cancel(); await cancelled.value
        tools.query = "NO_SUCH_MATCH"; await tools.reload()
        guard tools.rows.isEmpty, !tools.busy else { throw BridgeFailure(code: "INSPECTOR_CANCEL", message: "Cancelled search replaced newer results") }
        try command("quick"); try await Task.sleep(for: .milliseconds(100))
        tools.query = "notes-中文"; await tools.reload()
        guard tools.mode == .quick, tools.rows.count == 1 else { throw BridgeFailure(code: "INSPECTOR_QUICK", message: "Filename quick open failed") }
        report["cancelledSearchAndFilenameQuickOpen"] = true
        await model.split("horizontal")
        try await TerminalSmoke.wait("Start second inspector fixture PTY") { model.terminals.count == 2 && model.selectedTerminal?.generation != nil && model.selectedTerminal?.error.isEmpty == true }
        guard let second = model.selectedTerminal, second.id != first.id else { throw BridgeFailure(code: "INSPECTOR_SPLIT", message: "No split peer") }
        try await TerminalSmoke.wait("Show two terminal views") { first.view.window === window && second.view.window === window }
        let layout = model.state?.layout, ids = Set(model.terminals.keys), firstView = ObjectIdentifier(first.view), secondView = ObjectIdentifier(second.view)
        try command("swapPanes")
        try await TerminalSmoke.wait("Persist left tools preference") { !model.busy && model.settings["inspectorPosition"].string == "left" }
        try await TerminalSmoke.wait("Reattach native inspector after swapping") { view(window, id: "native-inspector-container") != nil }
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
        try await capture("native-inspector-zoom-dark-en.png"); captures.append("native-inspector-zoom-dark-en.png")
        try command("zoom")
        try await TerminalSmoke.wait("Restore original split views") { !model.paneZoomed && first.view.window === window && second.view.window === window }
        guard model.state?.layout == layout, Set(model.terminals.keys) == ids, ObjectIdentifier(first.view) == firstView, ObjectIdentifier(second.view) == secondView else { throw BridgeFailure(code: "INSPECTOR_IDENTITY", message: "Swap or zoom replaced a session, view or shared layout") }
        report["paneSwapAndZoomRetainLayoutViewsAndOutput"] = true
        guard let focusTable = view(window, id: "native-inspector-rows") as? NSTableView, window.makeFirstResponder(focusTable), model.inspectorOwnsFocus else { throw BridgeFailure(code: "INSPECTOR_CLOSE_FOCUS", message: "Tools did not regain focus") }
        try command("close")
        try await TerminalSmoke.wait("Close tools and return focus to terminal") { !model.inspectorVisible && window.firstResponder === second.view }
        guard Set(model.terminals.keys) == ids else { throw BridgeFailure(code: "INSPECTOR_CLOSE", message: "Close tools terminated a PTY") }
        report["closeFocusedToolsRetainsPTYAndReturnsFocus"] = true
        model.sidebarVisible = false
        await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
        try command("files")
        try await TerminalSmoke.wait("Restore tools without project sidebar") { model.inspectorVisible && !tools.busy && !tools.rows.isEmpty }
        window.setContentSize(NSSize(width: 680, height: 600))
        try await Task.sleep(for: .milliseconds(200))
        guard let container = view(window, id: "native-inspector-container"), container.frame.width >= 210 else { throw BridgeFailure(code: "INSPECTOR_NARROW", message: "Inspector disappeared with hidden sidebar") }
        try await capture("native-inspector-files-light-zh-narrow.png"); captures.append("native-inspector-files-light-zh-narrow.png")
        report["leftToolsRemainVisibleWithoutSidebar"] = true
        report["captures"] = captures
        report["inputMethod"] = "Actual NSMenu/NSTableView Return; native WK editor DOM insertText; not manual IME acceptance"
        report["manualAcceptance"] = "waived by user"
        for id in Array(model.terminals.keys) { await model.selectSession(id); await model.closeSession() }
        let status = try await bridge.call("host.status")
        guard status["sessions"].array.isEmpty else { throw BridgeFailure(code: "INSPECTOR_CLEANUP", message: "Fixture host sessions remain") }
        _ = try await bridge.call("host.shutdownIdle")
        report["explicitFixtureCloseAndIdleHostShutdown"] = true
    }
}
