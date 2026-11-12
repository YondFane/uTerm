import AppKit
import UTermBridge

@MainActor
enum EditorRecoverySmoke {
    private static func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    private static func control<T: NSView>(_ parent: NSWindow, _ identifier: String, as type: T.Type) throws -> T {
        guard let view = parent.attachedSheet?.contentView,
              let control = descendants(view).first(where: { $0.identifier?.rawValue == identifier }) as? T else {
            throw BridgeFailure(code: "RECOVERY_CONTROL", message: "Missing real recovery sheet control: " + identifier)
        }
        return control
    }
    private static func present(_ action: String, parent: NSWindow) async throws {
        guard let item = NSApp.mainMenu?.items.compactMap(\.submenu).flatMap(\.items).first(where: { $0.action.map(NSStringFromSelector) == action }),
              let selector = item.action, NSApp.sendAction(selector, to: item.target, from: item) else {
            throw BridgeFailure(code: "RECOVERY_MENU", message: "Missing real native recovery menu action")
        }
        try await TerminalSmoke.wait("Show real recovery sheet") { parent.attachedSheet?.isVisible == true }
    }
    private static func press(_ index: Int, parent: NSWindow) throws {
        let button = try control(parent, "editor-recovery-button-\(index)", as: NSButton.self)
        guard button.isEnabled else { throw BridgeFailure(code: "RECOVERY_DISABLED", message: "Recovery action was disabled") }
        button.performClick(nil)
    }
    private static func select(_ revision: String, parent: NSWindow) async throws {
        let choices = try control(parent, "editor-recovery-choice", as: NSPopUpButton.self)
        guard choices.itemTitles.contains(revision) else { throw BridgeFailure(code: "RECOVERY_COPY", message: "Expected recovery copy missing") }
        choices.selectItem(withTitle: revision)
        guard let action = choices.action else { throw BridgeFailure(code: "RECOVERY_SELECT", message: "Recovery selection action missing") }
        NSApp.sendAction(action, to: choices.target, from: choices)
        try await TerminalSmoke.wait("Load verified recovery preview") {
            (try? control(parent, "editor-recovery-button-0", as: NSButton.self).isEnabled) == true
        }
    }
    private static func capture(_ parent: NSWindow, _ reportPath: String, _ name: String, captures: inout [String]) async throws {
        guard let sheet = parent.attachedSheet else { throw BridgeFailure(code: "RECOVERY_CAPTURE", message: "Recovery sheet missing before capture") }
        try await Task.sleep(for: .milliseconds(200))
        try await TerminalSmoke.capture(window: sheet, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name))
        captures.append(name)
    }

    static func run(model: WorkspaceModel, parent: NSWindow, root: URL, path: String, text: String,
                    lookup: @escaping (URL, String) -> ContentWindow?, reportPath: String, captures: inout [String], report: inout [String: Any]) async throws {
        guard let bridge = model.bridge else { throw BridgeFailure(code: "RECOVERY_BRIDGE", message: "Core bridge missing") }
        let before = try await bridge.call("editor.drafts.read")
        let clipboard = NSPasteboard.general.string(forType: .string)
        defer {
            NSPasteboard.general.clearContents()
            if let clipboard { NSPasteboard.general.setString(clipboard, forType: .string) }
        }
        try await present("recoverEditorDrafts", parent: parent)
        try await capture(parent, reportPath, "native-editor-recovery-picker.png", captures: &captures)
        try press(2, parent: parent)
        try await TerminalSmoke.wait("Copy recovery text and dismiss") { !model.editorRecoveryPresented && parent.attachedSheet == nil }
        let afterCopy = try await bridge.call("editor.drafts.read")
        guard NSPasteboard.general.string(forType: .string).map({ Data($0.utf8) == Data(text.utf8) }) == true, before == afterCopy else {
            throw BridgeFailure(code: "RECOVERY_COPY", message: "Copy changed recovery data or lost exact text bytes")
        }
        report["recoveryCopyPreservedExactTextAndStore"] = true
        await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
        try await present("recoverEditorDrafts", parent: parent)
        try await capture(parent, reportPath, "native-editor-recovery-zh-light.png", captures: &captures)
        try press(1, parent: parent)
        try await TerminalSmoke.wait("Cancel recovery without writes") { !model.editorRecoveryPresented && parent.attachedSheet == nil }
        guard try await bridge.call("editor.drafts.read") == before else { throw BridgeFailure(code: "RECOVERY_CANCEL", message: "Cancel changed recovery data") }
        report["recoveryCancelPreservedStore"] = true
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        try await present("recoverEditorDrafts", parent: parent)
        try press(0, parent: parent)
        try await TerminalSmoke.wait("Open missing-source recovery in its actual workspace tab") {
            guard !model.editorRecoveryPresented, parent.attachedSheet == nil, let opened = lookup(root, path) else { return false }
            return opened.presentationWindow === parent && model.documents.active(in: model.inspectorContextKey)?.content === opened
        }
        guard let opened = lookup(root, path), let openedWindow = opened.presentationWindow,
              openedWindow === parent else { throw BridgeFailure(code: "RECOVERY_OPEN", message: "Recovered file is missing from the actual workspace") }
        defer { opened.forceClose() }
        try await ContentSmoke.wait(opened, "document.querySelector('.cm-content[contenteditable=false]')?.textContent.includes('MISSING_SOURCE_RECOVERY') === true", allowAlert: true)
        let image = "native-editor-recovery-opened.png"
        try await TerminalSmoke.capture(window: openedWindow, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(image))
        captures.append(image)
        report["recoveryOpenedInMainWorkspace"] = true
        try await present("recoverEditorDrafts", parent: parent)
        try press(0, parent: parent)
        try await TerminalSmoke.wait("Focus the existing recovered workspace document") { !model.editorRecoveryPresented && parent.attachedSheet == nil && opened.presentationWindow === parent }
        guard lookup(root, path) === opened, let document = model.documents.active(in: model.inspectorContextKey),
              document.content === opened, let content = parent.contentView,
              let close = descendants(content).first(where: { $0.identifier?.rawValue == "native-file-close-" + document.id.uuidString }) as? NSButton,
              close.isEnabled else { throw BridgeFailure(code: "RECOVERY_DUPLICATE", message: "Recovery did not retain the same document and its actual tab close control") }
        report["recoveryMenuOpenedAndReusedReadonlyWindow"] = true
        close.performClick(nil)
        try await TerminalSmoke.wait("Close the actual recovered tab before snapshot restore") { lookup(root, path) == nil && !model.documents.documents.contains { $0.content === opened } }
        guard try await bridge.call("editor.drafts.read") == before else { throw BridgeFailure(code: "RECOVERY_CLOSE", message: "Closing the readonly recovery tab changed its retained draft") }
        report["recoveryActualTabClosePreservedDraft"] = true

        _ = try await bridge.call("editor.drafts.putDocument", params: .object([
            "expectedDraftRevision": .null, "draft": .object([
                "directory": .string(root.path), "path": .string("recovery-marker.txt"), "kind": .string("text"),
                "text": .string("later snapshot"), "saved": .string(""), "version": .string(String(repeating: "a", count: 64)),
                "bom": .bool(false), "line_ending": .string("\n")
            ])
        ]))
        let storeRoot = try WorkspaceModel.dataRoot()
        let store = storeRoot.appendingPathComponent("editor-drafts-v1.json")
        let corrupt = Data("{damaged native QA draft copy".utf8)
        try corrupt.write(to: store)
        try await present("restoreEditorRecovery", parent: parent)
        try await select(before["revision"].string!, parent: parent)
        try await capture(parent, reportPath, "native-editor-recovery-copy.png", captures: &captures)
        let changed = Data("{newer external damage must survive stale recovery".utf8)
        try changed.write(to: store)
        try press(0, parent: parent)
        try await TerminalSmoke.wait("Refuse stale recovery selection") { !model.editorRecoveryPresented && model.error.contains("CONFLICT") }
        guard try Data(contentsOf: store) == changed else { throw BridgeFailure(code: "RECOVERY_STALE", message: "Stale recovery overwrote external data") }
        report["recoveryStaleSelectionPreservedNewerBytes"] = true

        let damagedCatalog = try await bridge.editorRecoveryCatalog()
        guard let damagedRevision = damagedCatalog.currentRevision else { throw BridgeFailure(code: "RECOVERY_DAMAGE", message: "Damaged snapshot disappeared") }
        try await present("restoreEditorRecovery", parent: parent)
        try await select(before["revision"].string!, parent: parent)
        try press(0, parent: parent)
        try await TerminalSmoke.wait("Restore selected copy and dismiss") { !model.editorRecoveryPresented && parent.attachedSheet == nil }
        let restored = try await bridge.call("editor.drafts.read")
        guard restored == before, try Data(contentsOf: storeRoot.appendingPathComponent("editor-drafts-\(damagedRevision).damaged")) == changed else {
            throw BridgeFailure(code: "RECOVERY_RESTORE", message: "Restore did not retain selected data and damaged bytes")
        }
        report["recoveryRestoreRetainedDamagedBytes"] = true
        try FileManager.default.removeItem(at: store)
        try await present("restoreEditorRecovery", parent: parent)
        try await select(before["revision"].string!, parent: parent)
        try await capture(parent, reportPath, "native-editor-recovery-missing-store.png", captures: &captures)
        guard !FileManager.default.fileExists(atPath: store.path) else { throw BridgeFailure(code: "RECOVERY_PREVIEW", message: "Preview recreated missing store") }
        try press(0, parent: parent)
        try await TerminalSmoke.wait("Explicitly restore absent snapshot") { !model.editorRecoveryPresented && parent.attachedSheet == nil }
        guard try await bridge.call("editor.drafts.read") == before else { throw BridgeFailure(code: "RECOVERY_MISSING", message: "Missing restore did not recover selected draft") }
        report["recoveryMissingPreviewReadonlyAndExplicitRestore"] = true
        report["recoveryUIScenario"] = ["language": "en", "appearance": "dark", "controls": "actual NSMenu / NSAlert / NSPopUpButton / NSButton", "manualAcceptance": false] as [String: Any]
        report["recoveryAlternateScene"] = ["language": "zh-Hans", "appearance": "light", "capture": "native-editor-recovery-zh-light.png"]
    }
}
