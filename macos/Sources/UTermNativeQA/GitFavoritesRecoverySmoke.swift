import AppKit
import CryptoKit
import UTermBridge

@MainActor
enum GitFavoritesRecoverySmoke {
    private static func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    private static func control<T: NSView>(_ parent: NSWindow, _ suffix: String, as type: T.Type) throws -> T {
        guard let view = parent.attachedSheet?.contentView,
              let control = descendants(view).first(where: { $0.identifier?.rawValue == "git-favorite-recovery-" + suffix }) as? T else {
            throw BridgeFailure(code: "FAVORITE_RECOVERY_CONTROL", message: "Missing actual favorite recovery sheet control: " + suffix)
        }
        return control
    }
    private static func present(_ parent: NSWindow) async throws {
        guard let item = NSApp.mainMenu?.items.compactMap(\.submenu).flatMap(\.items).first(where: { $0.action.map(NSStringFromSelector) == "recoverGitFavorites" }),
              let action = item.action, NSApp.sendAction(action, to: item.target, from: item) else {
            throw BridgeFailure(code: "FAVORITE_RECOVERY_MENU", message: "Missing actual File recovery action")
        }
        try await TerminalSmoke.wait("Open actual favorite recovery sheet") { parent.attachedSheet?.isVisible == true }
    }
    private static func select(_ revision: String, source: Bool = false, parent: NSWindow) async throws {
        let choices = try control(parent, "choice", as: NSPopUpButton.self)
        guard let title = choices.itemTitles.first(where: { $0.contains(String(revision.prefix(12))) }) else {
            throw BridgeFailure(code: "FAVORITE_RECOVERY_CHOICE", message: "Expected recovery copy missing")
        }
        choices.selectItem(withTitle: title)
        guard let action = choices.action else { throw BridgeFailure(code: "FAVORITE_RECOVERY_SELECT", message: "Missing selection action") }
        NSApp.sendAction(action, to: choices.target, from: choices)
        try await TerminalSmoke.wait("Read and verify actual favorite preview") {
            (try? control(parent, "button-2", as: NSButton.self).isEnabled) == true
        }
        guard try control(parent, "button-1", as: NSButton.self).isEnabled == !source else {
            throw BridgeFailure(code: "FAVORITE_RECOVERY_READY", message: "Only verified snapshots may restore")
        }
    }
    private static func press(_ index: Int, parent: NSWindow) throws {
        let button = try control(parent, "button-\(index)", as: NSButton.self)
        guard button.isEnabled else { throw BridgeFailure(code: "FAVORITE_RECOVERY_DISABLED", message: "Recovery action disabled") }
        button.performClick(nil)
    }
    private static func capture(_ parent: NSWindow, path: String, name: String, captures: inout [String]) async throws {
        guard let sheet = parent.attachedSheet else { throw BridgeFailure(code: "FAVORITE_RECOVERY_CAPTURE", message: "Recovery sheet missing") }
        try await Task.sleep(for: .milliseconds(200))
        try await TerminalSmoke.capture(window: sheet, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name))
        captures.append(name)
    }
    static func run(model: WorkspaceModel, parent: NSWindow, content: ContentWindow, source: String,
                    sourceRevision: String, reportPath: String, captures: inout [String], report: inout [String: Any]) async throws {
        guard let bridge = model.bridge else { throw BridgeFailure(code: "FAVORITE_RECOVERY_BRIDGE", message: "Missing shared bridge") }
        let root = try WorkspaceModel.dataRoot(), file = root.appendingPathComponent("git-favorites-v1.json")
        let original = try Data(contentsOf: file)
        let catalog = try await bridge.gitFavoriteRecoveryCatalog()
        guard let revision = catalog.currentRevision, catalog.backups.contains(revision) else {
            throw BridgeFailure(code: "FAVORITE_RECOVERY_SNAPSHOT", message: "Current favorite snapshot has no verified recovery copy")
        }
        let clipboard = NSPasteboard.general.string(forType: .string)
        defer {
            NSPasteboard.general.clearContents()
            if let clipboard { NSPasteboard.general.setString(clipboard, forType: .string) }
        }
        try await present(parent)
        try await select(revision, parent: parent)
        let cancel = try control(parent, "button-0", as: NSButton.self)
        let restore = try control(parent, "button-1", as: NSButton.self)
        guard parent.attachedSheet?.defaultButtonCell === cancel.cell, restore.keyEquivalent.isEmpty else {
            throw BridgeFailure(code: "FAVORITE_RECOVERY_DEFAULT", message: "Destructive recovery must not be the default action")
        }
        try await capture(parent, path: reportPath, name: "native-git-favorite-recovery-preview.png", captures: &captures)
        try press(0, parent: parent)
        try await TerminalSmoke.wait("Cancel favorite recovery") { !model.gitFavoritesRecoveryPresented && parent.attachedSheet == nil }
        guard try Data(contentsOf: file) == original else { throw BridgeFailure(code: "FAVORITE_RECOVERY_CANCEL", message: "Cancel changed original bytes") }
        report["favoriteRecoveryCancelRetainedBytes"] = true

        try await present(parent)
        try await select(sourceRevision, source: true, parent: parent)
        try await capture(parent, path: reportPath, name: "native-git-favorite-recovery-source.png", captures: &captures)
        try press(2, parent: parent)
        try await TerminalSmoke.wait("Copy exact favorite source") { !model.gitFavoritesRecoveryPresented && parent.attachedSheet == nil }
        guard NSPasteboard.general.string(forType: .string).map({ Data($0.utf8) == Data(source.utf8) }) == true,
              try Data(contentsOf: file) == original else { throw BridgeFailure(code: "FAVORITE_RECOVERY_COPY", message: "Full source copy lost bytes or modified favorites") }
        report["favoriteRecoveryCopiedExactSourceWithoutRestore"] = true

        let damaged = Data("{damaged native favorite recovery".utf8)
        try damaged.write(to: file)
        try await ContentSmoke.wait(content, "[...document.querySelectorAll('button')].some(b=>b.textContent==='Recover Git favorites…')", allowAlert: true)
        try await EditorSmoke.click(content, title: "Recover Git favorites…")
        try await TerminalSmoke.wait("Open recovery through scoped Git content action") { parent.attachedSheet?.isVisible == true }
        report["favoriteRecoveryOpenedFromScopedGitError"] = true
        try await select(revision, parent: parent)
        try await capture(parent, path: reportPath, name: "native-git-favorite-recovery-damaged.png", captures: &captures)
        let changed = Data("{newer external favorite damage must survive".utf8)
        try changed.write(to: file)
        try press(1, parent: parent)
        try await TerminalSmoke.wait("Reject stale favorite restore") { !model.gitFavoritesRecoveryPresented && !model.error.isEmpty }
        guard model.error.contains("Favorites changed after preview"), try Data(contentsOf: file) == changed else {
            throw BridgeFailure(code: "FAVORITE_RECOVERY_STALE", message: "Stale restore replaced newer bytes or hid the error")
        }
        report["favoriteRecoveryStaleSelectionRetainedBytes"] = true

        try await present(parent)
        try await select(revision, parent: parent)
        try press(1, parent: parent)
        try await TerminalSmoke.wait("Restore favorite snapshot and notify Git content") { !model.gitFavoritesRecoveryPresented && parent.attachedSheet == nil }
        let digest = SHA256.hash(data: changed).map { String(format: "%02x", $0) }.joined()
        guard model.error.isEmpty, try Data(contentsOf: file) == original,
              try Data(contentsOf: root.appendingPathComponent("git-favorites-\(digest).damaged")) == changed else {
            throw BridgeFailure(code: "FAVORITE_RECOVERY_RESTORE", message: "Restore failed to retain snapshot or damaged bytes")
        }
        report["favoriteRecoveryRestoredAndRetainedDamage"] = true
        try await ContentSmoke.wait(content, "document.querySelector('[data-node=\"refs/heads/main\"]')?.textContent.includes('★') === true")

        await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
        let frame = parent.frame
        parent.setContentSize(NSSize(width: 640, height: 520))
        defer { parent.setFrame(frame, display: true) }
        try FileManager.default.removeItem(at: file)
        try await present(parent)
        try await select(revision, parent: parent)
        try await capture(parent, path: reportPath, name: "native-git-favorite-recovery-missing-zh-light.png", captures: &captures)
        guard !FileManager.default.fileExists(atPath: file.path) else { throw BridgeFailure(code: "FAVORITE_RECOVERY_MISSING", message: "Readonly preview recreated absent snapshot") }
        try press(1, parent: parent)
        try await TerminalSmoke.wait("Explicitly restore missing favorite snapshot") { !model.gitFavoritesRecoveryPresented && parent.attachedSheet == nil }
        guard model.error.isEmpty, try Data(contentsOf: file) == original else { throw BridgeFailure(code: "FAVORITE_RECOVERY_MISSING", message: "Explicit missing restore did not retain original favorite bytes") }
        report["favoriteRecoveryMissingPreviewReadonlyAndExplicitRestore"] = true
        report["favoriteRecoveryUIScenarios"] = ["controls": "actual NSMenu / NSAlert / NSPopUpButton / NSButton / NSPasteboard", "languages": ["en", "zh-Hans"], "appearances": ["dark", "light"], "manualAcceptance": false] as [String: Any]
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
    }
}
