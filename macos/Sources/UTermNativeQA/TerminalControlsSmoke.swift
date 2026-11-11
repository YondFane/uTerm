import AppKit
import UTermBridge

@MainActor
enum TerminalControlsSmoke {
    private static func button(_ window: NSWindow, id: String) -> NSButton? {
        window.contentView.flatMap { TerminalSmoke.descendants($0).first(where: { $0.identifier?.rawValue == id }) as? NSButton }
    }
    private static func click(_ window: NSWindow, id: String) async throws {
        try await TerminalSmoke.wait("Enable actual terminal control " + id) { button(window, id: id)?.isEnabled == true }
        guard let control = button(window, id: id) else { throw BridgeFailure(code: "TERMINAL_CONTROLS", message: "Missing actual terminal control") }
        control.performClick(nil)
    }
    static func run(model: WorkspaceModel, window: NSWindow, root: URL, phase: String, report: inout [String: Any], captures: inout [String]) async throws {
        guard let bridge = model.bridge, let session = model.selectedTerminal else { throw BridgeFailure(code: "TERMINAL_CONTROLS", message: "Missing selected terminal") }
        let id = session.id, generation = session.generation, view = ObjectIdentifier(session.view)
        defer {
            report["terminalSearchDiagnostics"] = ["index": session.search.index, "total": session.search.total, "visible": session.search.visible, "matchCase": session.search.matchCase, "terminalColumns": session.view.getTerminal().cols, "terminalRows": session.view.getTerminal().rows]
            report["terminalRestartDiagnostics"] = ["generation": session.generation ?? "", "exited": session.exited, "error": session.error, "owned": session.inputControl?.owned == true, "acceptsInput": session.acceptsInput, "renderedFrames": session.qaRenderedFrames]
        }
        let size = model.settings["fontSize"].number ?? 17
        func control(_ name: String) -> String { "native-terminal-" + name + "-" + id }
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark"), "fontSize": .number(17)])
        try await click(window, id: control("font-smaller"))
        try await TerminalSmoke.wait("Apply actual smaller font button") { model.settings["fontSize"].number == 16 && session.view.font.pointSize == 16 && !model.busy }
        try await click(window, id: control("font-larger"))
        try await TerminalSmoke.wait("Apply actual larger font button") { model.settings["fontSize"].number == 17 && session.view.font.pointSize == 17 && !model.busy }
        for (bound, name) in [(10.0, "font-smaller"), (32.0, "font-larger")] {
            await model.patchSettings(["fontSize": .number(bound)])
            try await Task.sleep(for: .milliseconds(50))
            try await TerminalSmoke.wait("Disable actual font control at shared bound") { button(window, id: control(name))?.isEnabled == false && session.view.font.pointSize == CGFloat(bound) && !model.busy }
        }
        await model.patchSettings(["fontSize": .number(17)])
        session.enqueue(Data("printf 'UTERM_FIND_%s_%s\\n' '中文' 'a' '中文' 'b'\r".utf8))
        try await TerminalSmoke.wait("Render two real Unicode search matches") { session.text.contains("UTERM_FIND_中文_a") && session.text.contains("UTERM_FIND_中文_b") }
        let inputBefore = session.qaUserInputBytes
        try await click(window, id: control("search"))
        try await TerminalSmoke.wait("Attach actual native terminal search field") { window.contentView.map { TerminalSmoke.descendants($0).contains { $0.identifier?.rawValue == "native-terminal-query-" + id } } == true }
        guard let rootView = window.contentView,
              let field = TerminalSmoke.descendants(rootView).first(where: { $0.identifier?.rawValue == "native-terminal-query-" + id }) as? NSTextField,
              window.makeFirstResponder(field), let editor = window.firstResponder as? NSTextView else { throw BridgeFailure(code: "TERMINAL_SEARCH", message: "Actual search field cannot receive native input") }
        editor.setSelectedRange(NSRange(location: 0, length: editor.string.utf16.count))
        editor.insertText("uterm_find_中文" as NSString, replacementRange: NSRange(location: NSNotFound, length: 0))
        try await TerminalSmoke.wait("Find case-insensitive Unicode output through native text input") { session.search.total == 2 && session.search.index > 0 }
        let first = session.search.index
        try await click(window, id: control("next"))
        try await TerminalSmoke.wait("Select the next actual terminal match") { session.search.index != first && session.search.total == 2 }
        try await click(window, id: control("previous"))
        try await TerminalSmoke.wait("Select the previous actual terminal match") { session.search.index == first && session.search.total == 2 }
        try await click(window, id: control("match-case"))
        try await TerminalSmoke.wait("Apply actual case-sensitive toggle") { session.search.matchCase && session.search.total == 0 }
        try await click(window, id: control("match-case"))
        try await TerminalSmoke.wait("Restore case-insensitive matches") { !session.search.matchCase && session.search.total == 2 }
        let screenshot = "personal-\(phase)-terminal-search.png"
        try await TerminalSmoke.capture(window: window, path: root.appendingPathComponent(screenshot))
        captures.append(screenshot)
        report["captures"] = captures
        try await click(window, id: control("close-search"))
        try await TerminalSmoke.wait("Close search and restore terminal focus") { !session.search.visible && window.firstResponder === session.view }
        try TerminalSmoke.postKey(window: window, code: 3, characters: "f", modifiers: .command)
        try await TerminalSmoke.wait("Open the shared search UI through the actual shortcut") { session.search.visible }
        try await TerminalSmoke.wait("Focus the actual terminal search editor") { window.firstResponder is NSTextView }
        try TerminalSmoke.postKey(window: window, code: 53, characters: "\u{1b}")
        try await TerminalSmoke.wait("Escape from actual search returns terminal focus") { !session.search.visible && window.firstResponder === session.view }
        try TerminalSmoke.postKey(window: window, code: 3, characters: "F", modifiers: [.command, .shift])
        try await TerminalSmoke.wait("Shifted find routes to project content search") { model.inspector.mode == .search && model.inspectorVisible }
        guard !session.search.visible else { throw BridgeFailure(code: "TERMINAL_SEARCH_CHORD", message: "Shifted find opened the terminal search") }
        model.showInspector(.files)
        window.makeFirstResponder(session.view)
        guard session.qaUserInputBytes == inputBefore, model.selectedID == id, session.generation == generation, ObjectIdentifier(session.view) == view else {
            throw BridgeFailure(code: "TERMINAL_CONTROLS_IDENTITY", message: "Search reached the PTY or controls replaced terminal identity")
        }
        let beforeRestart = (try await bridge.snapshot()).document.workspace
        session.enqueue(Data("exit\r".utf8))
        try await TerminalSmoke.wait("Observe an exited real local shell") { session.exited }
        try await click(window, id: control("restart"))
        try await TerminalSmoke.wait("Restart through actual button with a new process generation and writable input") { session.generation != nil && session.generation != generation && session.acceptsInput && session.inputControl?.owned == true }
        session.enqueue(Data("printf 'RESTARTED_%s\\n' '中文'\r".utf8))
        try await TerminalSmoke.wait("Render output from the actual restarted shell") { session.text.contains("RESTARTED_中文") }
        guard model.selectedID == id, model.terminals[id] === session, ObjectIdentifier(session.view) == view,
              (try await bridge.snapshot()).document.workspace == beforeRestart else { throw BridgeFailure(code: "TERMINAL_RESTART", message: "Explicit restart changed the descriptor, layout or view") }
        await model.patchSettings(["fontSize": .number(size)])
        guard model.settings["fontSize"].number == size, session.view.font.pointSize == CGFloat(size), model.error.isEmpty else { throw BridgeFailure(code: "TERMINAL_FONT_RESTORE", message: "Font controls did not restore the saved size") }
        var proof: [String: Any] = [:]
        for key in ["passed", "actualFontButtonsAppliedAndRestored", "fontBoundsDisabled", "unicodeCaseCountsAndNavigation", "keyboardOpenAndEscape", "keyboardShiftFindRoutesProjectSearch", "searchInputDidNotReachPTY", "terminalIdentityAndGenerationRetained", "explicitRestartRetainedDescriptorAndView"] { proof[key] = true }
        proof["generationBeforeRestart"] = generation ?? ""
        proof["restartedGeneration"] = session.generation ?? ""
        proof["sessionID"] = id
        proof["searchInputBytesBefore"] = inputBefore
        proof["searchInputBytesAfter"] = session.qaUserInputBytes
        proof["screenshot"] = screenshot; proof["sourceHeadSHA"] = report["sourceHeadSHA"] ?? ""; proof["testedMergeSHA"] = report["testedMergeSHA"] ?? ""
        proof["platform"] = "macOS"; proof["architecture"] = report["architecture"] ?? ""; proof["system"] = ProcessInfo.processInfo.operatingSystemVersionString
        proof["width"] = Int(window.contentView?.bounds.width ?? 0); proof["height"] = Int(window.contentView?.bounds.height ?? 0)
        proof["input"] = "Actual AppKit font/search buttons and NSTextField editor input in a real window; no physical keyboard/IME claim"
        report["nativeTerminalControls"] = proof
    }
}
