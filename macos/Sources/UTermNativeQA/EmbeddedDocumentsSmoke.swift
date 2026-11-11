import AppKit
import UTermBridge

@MainActor
enum EmbeddedDocumentsSmoke {
    private static func click(_ window: NSWindow, id: String, focus: Bool = false) throws {
        guard let root = window.contentView, let button = TerminalSmoke.descendants(root).first(where: { $0.identifier?.rawValue == id }) as? NSButton, button.isEnabled else { throw BridgeFailure(code: "EMBEDDED_CONTROL", message: "Missing actual workspace tab button: " + id) }
        if focus { window.makeFirstResponder(button) } else { button.performClick(nil) }
    }
    static func run(model: WorkspaceModel, window: NSWindow, root: URL, phase: String,
                    open: (URL, String) async throws -> ContentWindow,
                    report: inout [String: Any], captures: inout [String]) async throws {
        guard let bridge = model.bridge, let session = model.selectedTerminal else { throw BridgeFailure(code: "EMBEDDED_START", message: "Missing shared core or terminal") }
        let generation = session.generation
        let terminalView = ObjectIdentifier(session.view)
        let scope = model.inspectorContextKey
        let names = ["embedded-first-中文.txt", "embedded-second-中文.txt"]
        let original = "ORIGINAL 中文\n"
        let edited = "EMBEDDED_DRAFT 中文 é 😀\n"
        for name in names { try Data(original.utf8).write(to: root.appendingPathComponent(name)) }
        defer { for name in names { try? FileManager.default.removeItem(at: root.appendingPathComponent(name)) } }
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        let disk = try await bridge.call("files.read", params: .object(["directory": .string(root.path), "path": .string(names[0])]))
        let recovered: JSONValue = .object(["directory": .string(root.path), "path": .string(names[0]), "kind": .string("text"), "text": .string("RECOVERED_TAB_SEED\n"), "saved": disk["text"], "version": disk["version"], "line_ending": disk["line_ending"], "bom": disk["bom"]])
        _ = try await bridge.call("editor.drafts.putDocument", params: .object(["expectedDraftRevision": .null, "draft": recovered]))
        let first = try await open(root, names[0])
        defer { first.forceClose() }
        try await TerminalSmoke.wait("Attach first actual editor to workspace") { first.webView.window === window && first.window?.isVisible == false }
        try await ContentSmoke.wait(first, "document.querySelector('.cm-content[contenteditable=true]')?.textContent.includes('RECOVERED_TAB_SEED') === true")
        try await EditorSmoke.replace(first, text: edited)
        try await TerminalSmoke.wait("Report the actual embedded dirty state") { first.editorDirty }
        let savedSettings = (try await bridge.snapshot()).document.settings
        let originalFileFont = savedSettings["fileFontSize"].number ?? 14
        let fontDelta: Double = originalFileFont < 32 ? 1 : -1
        try TerminalSmoke.postKey(window: window, code: fontDelta > 0 ? 24 : 27, characters: fontDelta > 0 ? "=" : "-", modifiers: .command)
        try await ContentSmoke.wait(first, "parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--file-font-size')) === \(originalFileFont + fontDelta)")
        guard (try await bridge.snapshot()).document.settings["fontSize"] == savedSettings["fontSize"], session.generation == generation else { throw BridgeFailure(code: "EMBEDDED_FONT", message: "File font shortcut changed the background terminal") }
        try TerminalSmoke.postKey(window: window, code: fontDelta > 0 ? 27 : 24, characters: fontDelta > 0 ? "-" : "=", modifiers: .command)
        try await ContentSmoke.wait(first, "parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--file-font-size')) === \(originalFileFont)")
        try TerminalSmoke.postKey(window: window, code: 3, characters: "f", modifiers: .command)
        try await ContentSmoke.wait(first, "document.querySelector('.cm-search') !== null")
        guard !session.search.visible, first.webView.window === window else { throw BridgeFailure(code: "EMBEDDED_FIND", message: "File find shortcut revealed the background terminal") }
        try TerminalSmoke.postKey(window: window, code: 53, characters: "\u{1b}")
        try await ContentSmoke.wait(first, "document.querySelector('.cm-search') === null")
        var stored = try await bridge.call("editor.drafts.document", params: .object(["directory": .string(root.path), "path": .string(names[0])]))
        let deadline = Date().addingTimeInterval(10)
        while stored["draft"]["text"].string != edited && Date() < deadline {
            try await Task.sleep(for: .milliseconds(50))
            stored = try await bridge.call("editor.drafts.document", params: .object(["directory": .string(root.path), "path": .string(names[0])]))
        }
        guard stored["draft"]["text"].string == edited else { throw BridgeFailure(code: "EMBEDDED_DRAFT", message: "Embedded file did not retain exact durable Unicode text") }
        let firstView = ObjectIdentifier(first.webView)
        let second = try await open(root, names[1])
        defer { second.forceClose() }
        try await TerminalSmoke.wait("Switch embedded files without opening another window") { second.webView.window === window && first.webView.window == nil && second.window?.isVisible == false }
        try await ContentSmoke.wait(second, "document.querySelector('.cm-content[contenteditable=true]') !== null")
        let secondView = ObjectIdentifier(second.webView)
        guard model.documents.visible(in: scope).map(\.content.path) == names,
              first.presentEmbedded != nil, second.presentEmbedded != nil else { throw BridgeFailure(code: "EMBEDDED_ORDER", message: "Workspace file order differs from opening order") }
        guard let firstID = model.documents.visible(in: scope).first?.id else { throw BridgeFailure(code: "EMBEDDED_TAB", message: "Missing first workspace tab") }
        try click(window, id: "native-file-select-" + firstID.uuidString)
        try await TerminalSmoke.wait("Return to the retained editor instance") { first.webView.window === window && second.webView.window == nil }
        try await ContentSmoke.wait(first, "document.querySelector('.cm-content')?.textContent.includes('EMBEDDED_DRAFT') === true")
        let reused = try await open(root, names[0])
        let originalBytesKept = try String(contentsOf: root.appendingPathComponent(names[0]), encoding: .utf8) == original
        guard reused === first, ObjectIdentifier(first.webView) == firstView, ObjectIdentifier(second.webView) == secondView,
              model.documents.visible(in: scope).count == 2, originalBytesKept else {
            let diagnostics: [String: Any] = ["reusedController": reused === first, "firstViewRetained": ObjectIdentifier(first.webView) == firstView, "secondViewRetained": ObjectIdentifier(second.webView) == secondView, "documentCount": model.documents.visible(in: scope).count, "originalBytesKept": originalBytesKept, "dirty": first.editorDirty]
            report["embeddedReuseDiagnostics"] = diagnostics
            throw BridgeFailure(code: "EMBEDDED_REUSE", message: "Reopening replaced an editor, reordered tabs or saved a recovered unsaved draft")
        }
        try await Task.sleep(for: .milliseconds(100))
        try click(window, id: "native-file-select-" + firstID.uuidString, focus: true)
        try TerminalSmoke.postKey(window: window, code: 124, characters: "\u{f703}")
        try await TerminalSmoke.wait("Arrow right activates the next actual file tab") { second.webView.window === window }
        try click(window, id: "native-workspace-terminal-tab")
        try await TerminalSmoke.wait("Return from files to the existing terminal") { model.documents.active(in: scope) == nil && session.view.window === window && first.webView.window == nil }
        guard session.generation == generation, ObjectIdentifier(session.view) == terminalView else { throw BridgeFailure(code: "EMBEDDED_TERMINAL", message: "File switching restarted the terminal") }
        first.reveal()
        try await TerminalSmoke.wait("Restore the edited file") { first.webView.window === window }
        let external = "EXTERNAL_WRITER 中文\n"
        try Data(external.utf8).write(to: root.appendingPathComponent(names[0]))
        try click(window, id: "native-file-close-" + firstID.uuidString)
        try await ContentSmoke.wait(first, "document.querySelector('dialog[open]') !== null", allowAlert: true)
        try await EditorSmoke.click(first, title: "Keep editing")
        guard first.editorDirty, model.documents.visible(in: scope).count == 2,
              try String(contentsOf: root.appendingPathComponent(names[0]), encoding: .utf8) == external else {
            throw BridgeFailure(code: "EMBEDDED_CONFLICT", message: "Cancelled close lost a file tab or overwrote the external writer")
        }
        let screenshot = "personal-\(phase)-embedded-files.png"
        try await TerminalSmoke.capture(window: window, path: root.deletingLastPathComponent().appendingPathComponent(screenshot))
        captures.append(screenshot)
        try click(window, id: "native-file-close-" + firstID.uuidString)
        try await ContentSmoke.wait(first, "document.querySelector('dialog[open]') !== null", allowAlert: true)
        try await EditorSmoke.click(first, title: "Discard changes and continue")
        try await TerminalSmoke.wait("Close exactly the reviewed embedded file") { model.documents.visible(in: scope).count == 1 && second.webView.window === window }
        guard model.documents.visible(in: scope).first?.content === second,
              try String(contentsOf: root.appendingPathComponent(names[0]), encoding: .utf8) == external,
              (try await bridge.call("editor.drafts.document", params: .object(["directory": .string(root.path), "path": .string(names[0])]))) == .null else {
            throw BridgeFailure(code: "EMBEDDED_CLOSE", message: "Closing one embedded editor changed its sibling or external bytes")
        }
        var proof: [String: Any] = [:]
        for key in ["passed", "tabControlsActivated", "arrowNavigationActivated", "sameMainWindow", "orderedAndReused", "exactUnsavedDraftRetained", "cancelCloseRetainedTabs", "discardPreservedSiblingAndExternalWriter", "terminalViewAndGenerationRetained", "fontShortcutsTargetEditor", "findShortcutRetainsEditorAndTerminal"] { proof[key] = true }
        proof["screenshot"] = screenshot
        proof["sourceHeadSHA"] = report["sourceHeadSHA"] ?? ""
        proof["testedMergeSHA"] = report["testedMergeSHA"] ?? ""
        proof["platform"] = "macOS"
        proof["architecture"] = report["architecture"] ?? ""
        proof["system"] = ProcessInfo.processInfo.operatingSystemVersionString
        proof["width"] = Int(window.contentView?.bounds.width ?? 0)
        proof["height"] = Int(window.contentView?.bounds.height ?? 0)
        proof["input"] = "Real AppKit workspace and WK CodeMirror DOM input; no physical keyboard/IME claim"
        report["embeddedWorkspaceFiles"] = proof
    }
}
