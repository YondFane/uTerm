import AppKit
import CoreGraphics
import UTermBridge

@MainActor
enum SettingsSmoke {
    private static func key(_ window: NSWindow, code: UInt16, characters: String) throws {
        guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) else { throw BridgeFailure(code: "SETTINGS_QA_EVENT", message: "Could not construct native key input") }
        NSApp.sendEvent(event)
    }
    private static func save(_ model: NativeSettingsModel) async throws {
        try await TerminalSmoke.wait("Finish pending control saves before saving the retained draft") { !model.automaticSaving }
        for _ in 0..<3 {
            await model.save()
            if model.errorCode != "WRITER_BUSY" { return }
            try await Task.sleep(for: .milliseconds(100))
        }
    }
    private static func view(_ window: NSWindow, id: String) -> NSView? {
        var queue = window.contentView.map { [$0] } ?? []
        while !queue.isEmpty {
            let view = queue.removeFirst()
            if view.identifier?.rawValue == id { return view }
            queue += view.subviews
        }
        return nil
    }
    private static func checkSearch(_ settings: NativeSettingsWindow, snapshotFile: URL, report: inout [String: Any]) async throws {
        let model = settings.model, before = try Data(contentsOf: snapshotFile)
        let original = model.numbers["fontSize"]
        model.numbers["fontSize"] = original == "19" ? "18" : "19"
        let retained = model.numbers["fontSize"]
        try await TerminalSmoke.wait("Render native settings search") { (view(settings.window, id: "native-settings-search") as? NSSearchField)?.isEnabled == true }
        guard let field = view(settings.window, id: "native-settings-search") as? NSSearchField else { throw BridgeFailure(code: "SETTINGS_SEARCH", message: "Missing settings search field") }
        settings.window.makeKeyAndOrderFront(nil); settings.window.makeFirstResponder(field)
        guard let editor = field.currentEditor() as? NSTextView else { throw BridgeFailure(code: "SETTINGS_SEARCH", message: "Missing actual AppKit search editor") }
        editor.insertText("JDK", replacementRange: NSRange(location: 0, length: 0))
        try await TerminalSmoke.wait("Search filters categories through actual AppKit input") { model.query == "JDK" && view(settings.window, id: "native-settings-section-java") != nil && view(settings.window, id: "native-settings-section-appearance") == nil }
        guard model.section == "general", model.numbers["fontSize"] == retained, model.dirty else { throw BridgeFailure(code: "SETTINGS_SEARCH_DRAFT", message: "Filtering navigation changed the selected section or draft") }
        guard let java = view(settings.window, id: "native-settings-section-java") as? NSButton else { throw BridgeFailure(code: "SETTINGS_SEARCH", message: "Missing matching category") }
        java.performClick(nil)
        try await TerminalSmoke.wait("Matching category remains actionable") { model.section == "java" }
        let name = "native-settings-search-jdk.png"
        if let path = WorkspaceModel.argument("--settings-smoke-report") { try await TerminalSmoke.capture(window: settings.window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name)) }
        try await TerminalSmoke.wait("Search field is ready after category loading") { field.isEnabled && !model.javaComponents.pending && !model.javaComponents.mutating }
        settings.window.makeFirstResponder(field)
        try key(settings.window, code: 53, characters: "\u{1b}")
        try await TerminalSmoke.wait("Escape clears search while retaining the settings window") { model.query.isEmpty && settings.window.isVisible && view(settings.window, id: "native-settings-section-appearance") != nil }
        guard model.numbers["fontSize"] == retained, try Data(contentsOf: snapshotFile) == before else { throw BridgeFailure(code: "SETTINGS_SEARCH_DRAFT", message: "Settings search changed a draft or saved data") }
        model.numbers["fontSize"] = original; model.section = "general"; settings.window.makeFirstResponder(nil)
        report["nativeSettingsSearchProof"] = ["actualAppKitInput": true, "filteredNavigation": true, "matchingCategoryClickable": true, "draftRetained": true, "escapeClearsWithoutClosing": true, "savedBytesUnchanged": true, "capture": name]
    }
    static func run(workspace: WorkspaceModel, open: () -> NativeSettingsWindow, openAgents: () -> AgentSettingsWindow, report: inout [String: Any]) async throws {
        guard workspace.ready, let bridge = workspace.bridge, let path = WorkspaceModel.argument("--settings-smoke-report") else { throw BridgeFailure(code: "SETTINGS_QA_CONTEXT", message: "Missing isolated settings context") }
        let root = try WorkspaceModel.dataRoot()
        await workspace.patchSettings(["usageRemote": .bool(false)])
        guard workspace.settings["usageRemote"].bool == false else { throw BridgeFailure(code: "SETTINGS_QA_USAGE", message: "Could not isolate automatic usage reads") }
        guard !workspace.updates.available, workspace.updates.controller == nil else { throw BridgeFailure(code: "UPDATE_DEFAULT", message: "Unconfigured QA build unexpectedly initialized network updates") }
        report["unconfiguredNativeUpdatesHaveNoSDKControllerOrNetworkChecks"] = true
        let snapshotFile = root.appendingPathComponent("snapshot-v1.json")
        let before = try Data(contentsOf: snapshotFile)
        guard let menuItem = NSApp.mainMenu?.items.compactMap(\.submenu).flatMap(\.items).first(where: { $0.action.map(NSStringFromSelector) == "openFullSettings" }), let action = menuItem.action, NSApp.sendAction(action, to: menuItem.target, from: menuItem) else { throw BridgeFailure(code: "SETTINGS_QA_MENU", message: "All settings menu action is missing") }
        let current = open(), model = current.model
        try await TerminalSmoke.wait("Load complete settings catalog") { !model.values.isEmpty && !model.busy }
        guard model.error.isEmpty, try Data(contentsOf: snapshotFile) == before else { throw BridgeFailure(code: "SETTINGS_QA_OPEN", message: "Opening settings changed saved defaults") }
        report["nativeSettingsMenuAndReadonlyOpen"] = true
        for id in ["appearance", "terminal", "workspace", "keyboard", "agents", "usage", "control", "updates", "general"] {
            try await TerminalSmoke.wait("Render native settings navigation " + id) { (view(current.window, id: "native-settings-section-" + id) as? NSButton)?.isEnabled == true }
            guard let button = view(current.window, id: "native-settings-section-" + id) as? NSButton, button.isEnabled else { throw BridgeFailure(code: "SETTINGS_QA_SECTION", message: "Settings section is unavailable: " + id) }
            button.performClick(nil)
            try await TerminalSmoke.wait("Select settings section through its actual control") { model.section == id }
        }
        guard try Data(contentsOf: snapshotFile) == before, !model.dirty else { throw BridgeFailure(code: "SETTINGS_QA_SECTION", message: "Navigating settings changed saved data") }
        report["nativeSettingsSidebarNavigationPreservesSavedData"] = true
        try await checkSearch(current, snapshotFile: snapshotFile, report: &report)
        workspace.newWorkspace(owner: .settings)
        try await TerminalSmoke.wait("Attach workspace naming to the settings window") { current.window.attachedSheet != nil && workspace.nameDraftOwner == .settings }
        guard let nameSheet = current.window.attachedSheet else { throw BridgeFailure(code: "SETTINGS_QA_WORKSPACE", message: "Workspace naming sheet is missing") }
        try key(nameSheet, code: 53, characters: "\u{1b}")
        try await TerminalSmoke.wait("Cancel settings-owned workspace naming") { workspace.nameDraft == nil && current.window.attachedSheet == nil }
        guard !model.dirty, try Data(contentsOf: snapshotFile) == before else { throw BridgeFailure(code: "SETTINGS_QA_WORKSPACE", message: "Cancelling workspace naming changed saved data") }
        report["workspaceNamingOwnedBySettingsAndCancellationPreservesData"] = true
        model.section = "terminal"; model.numbers["fontSize"] = "999"
        try await save(model)
        guard !model.error.isEmpty, model.numbers["fontSize"] == "999", try Data(contentsOf: snapshotFile) == before else { throw BridgeFailure(code: "SETTINGS_QA_INVALID", message: "Invalid settings were written or their draft was discarded") }
        report["invalidNumericDraftRetainedWithoutWrite"] = true
        model.numbers["fontSize"] = "17"
        try await save(model)
        guard model.error.isEmpty, !model.dirty, workspace.settings["fontSize"].number == 17 else { throw BridgeFailure(code: "SETTINGS_QA_SAVE", message: "Native settings did not save") }
        try await verifyAutomaticSave(settings: current, root: root, evidence: URL(fileURLWithPath: path).deletingLastPathComponent(), report: &report)
        try await verifyIconColor(settings: current, evidence: URL(fileURLWithPath: path).deletingLastPathComponent(), report: &report)
        try await verifyLegacyExport(settings: current, root: root, evidence: URL(fileURLWithPath: path).deletingLastPathComponent(), report: &report)
        try await verifyDefaultAgent(settings: current, root: root, evidence: URL(fileURLWithPath: path).deletingLastPathComponent(), report: &report)
        try await verifyInlineAgents(settings: current, open: open, openAgents: openAgents, root: root, evidence: URL(fileURLWithPath: path).deletingLastPathComponent(), report: &report)
        let other = try await CoreBridge.open(root: root)
        do {
            model.numbers["fileFontSize"] = "19"
            var snapshot = try await other.snapshot()
            _ = try await other.call("settings.patch", params: .object(["expectedRevision": .string(snapshot.revision), "patch": .object(["usageRefreshInterval": .number(70)])]))
            try await save(model)
            snapshot = try await other.snapshot()
            guard model.error.isEmpty, snapshot.document.settings["fileFontSize"].number == 19, snapshot.document.settings["usageRefreshInterval"].number == 70 else { throw BridgeFailure(code: "SETTINGS_QA_REBASE", message: "Saving overwrote an unrelated external preference") }
            report["unrelatedExternalSettingsPreserved"] = true
            model.numbers["fontSize"] = "18"
            _ = try await other.call("settings.patch", params: .object(["expectedRevision": .string(snapshot.revision), "patch": .object(["fontSize": .number(20)])]))
            try await save(model)
            guard model.errorCode == "SETTINGS_CONFLICT", model.numbers["fontSize"] == "18", (try await other.snapshot()).document.settings["fontSize"].number == 20 else { throw BridgeFailure(code: "SETTINGS_QA_CONFLICT", message: "A stale field overwrote the other client") }
            report["sameFieldConflictRetainsDraftAndPeerValue"] = true
            current.window.performClose(nil)
            guard !current.window.isVisible, open() === current, model.numbers["fontSize"] == "18" else { throw BridgeFailure(code: "SETTINGS_QA_REOPEN", message: "Hidden settings draft was lost") }
            NSApp.terminate(nil)
            try await TerminalSmoke.wait("Present settings quit guard") { current.window.attachedSheet != nil }
            if let sheet = current.window.attachedSheet { current.window.endSheet(sheet, returnCode: .alertSecondButtonReturn) }
            try await TerminalSmoke.wait("Resume settings after cancelled application quit") { !model.frozen && current.window.attachedSheet == nil }
            guard model.dirty, model.numbers["fontSize"] == "18" else { throw BridgeFailure(code: "SETTINGS_QA_QUIT", message: "Cancelled quit discarded the settings draft") }
            report["hiddenWindowAndActualQuitCancellationRetainDraft"] = true
            await model.reload()
            guard model.error.isEmpty else { throw BridgeFailure(code: "SETTINGS_QA_RELOAD", message: "Could not reload current settings") }
            model.shortcuts["palette"] = "Mod+KeyC"
            try await save(model)
            guard model.errorCode == "SHORTCUT_RESERVED" else { throw BridgeFailure(code: "SETTINGS_QA_RESERVED", message: "Native settings accepted a reserved shortcut") }
            model.shortcuts["palette"] = "Mod+KeyT"
            try await save(model)
            guard model.errorCode == "SHORTCUT_CONFLICT" else { throw BridgeFailure(code: "SETTINGS_QA_DUPLICATE", message: "Native settings accepted a duplicate shortcut") }
            report["nativeReservedAndDuplicateShortcutErrors"] = true
            model.shortcuts["palette"] = nil; model.section = "keyboard"
            try await TerminalSmoke.wait("Render native shortcut capture") { view(current.window, id: "native-shortcut-palette") != nil }
            guard let capture = view(current.window, id: "native-shortcut-palette") as? NSButton else { throw BridgeFailure(code: "SETTINGS_QA_CAPTURE", message: "Shortcut capture control is missing") }
            capture.performClick(nil)
            // AppKit's charactersIgnoringModifiers retains Shift, as a real shifted letter event does.
            // AppKit 的 charactersIgnoringModifiers 保留 Shift，与真实带 Shift 的字母事件一致。
            guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command, .shift], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: current.window.windowNumber, context: nil, characters: "K", charactersIgnoringModifiers: "K", isARepeat: false, keyCode: 40), current.window.performKeyEquivalent(with: event) else { throw BridgeFailure(code: "SETTINGS_QA_KEY", message: "Native shortcut event was not captured") }
            guard model.shortcuts["palette"] == "Mod+Shift+KeyK" else { throw BridgeFailure(code: "SETTINGS_QA_CHORD", message: "Native shortcut did not preserve its semantic chord") }
            try await save(model)
            guard model.error.isEmpty else { throw BridgeFailure(code: "SETTINGS_QA_SHORTCUT_SAVE", message: "Captured shortcut could not be saved") }
            report["nativeShortcutCaptureAndSave"] = true
            current.window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            try await TerminalSmoke.wait("Focus settings before opening its command palette") { current.window.isKeyWindow }
            report["paletteOriginWindow"] = current.window.windowNumber
            guard let unshifted = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: current.window.windowNumber, context: nil, characters: "k", charactersIgnoringModifiers: "k", isARepeat: false, keyCode: 40), NSApp.mainMenu?.performKeyEquivalent(with: unshifted) == false else { throw BridgeFailure(code: "SETTINGS_QA_SHIFT", message: "A shifted shortcut accepted the unshifted event") }
            let paletteMenu = NSApp.mainMenu?.items.compactMap(\.submenu).flatMap(\.items).first(where: { $0.representedObject as? String == "palette" })
            report["paletteMenuBinding"] = ["key": paletteMenu?.keyEquivalent ?? "", "modifiers": paletteMenu?.keyEquivalentModifierMask.rawValue ?? 0, "enabled": paletteMenu?.isEnabled == true]
            guard paletteMenu?.keyEquivalent == "K", paletteMenu?.keyEquivalentModifierMask == [.command, .shift], let paletteEvent = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command, .shift], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: current.window.windowNumber, context: nil, characters: "K", charactersIgnoringModifiers: "K", isARepeat: false, keyCode: 40), NSApp.mainMenu?.performKeyEquivalent(with: paletteEvent) == true else { throw BridgeFailure(code: "SETTINGS_QA_MENU_BINDING", message: "Saved semantic shortcut did not update the system menu") }
            try await TerminalSmoke.wait("Open palette through the actual menu shortcut") { NSApp.keyWindow?.identifier?.rawValue == "native-command-palette" }
            guard let palette = NSApp.keyWindow else { throw BridgeFailure(code: "SETTINGS_QA_PALETTE", message: "Palette did not open") }
            palette.contentView?.layoutSubtreeIfNeeded()
            report["paletteWindow"] = ["frame": NSStringFromRect(palette.frame), "number": palette.windowNumber, "visible": palette.isVisible]
            try await TerminalSmoke.wait("Register the visible palette with WindowServer") {
                guard let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else { return false }
                return windows.contains { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == palette.windowNumber }
            }
            try await Task.sleep(for: .milliseconds(200))
            let paletteCapture = "native-settings-command-palette.png"
            try await TerminalSmoke.capture(window: palette, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(paletteCapture))
            report["nativePaletteWindowCaptured"] = true
            let previousResponder = current.window.firstResponder
            try key(palette, code: 53, characters: "\u{1b}")
            report["paletteAfterEscape"] = ["visible": palette.isVisible, "settingsKeyWindow": current.window.isKeyWindow, "keyWindow": NSApp.keyWindow?.windowNumber ?? -1]
            try await TerminalSmoke.wait("Restore settings focus after Escape") { !palette.isVisible && current.window.isKeyWindow }
            guard current.window.firstResponder === previousResponder else { throw BridgeFailure(code: "SETTINGS_QA_FOCUS", message: "Palette cancellation did not restore the previous responder") }
            report["nativePaletteEscapeRestoredResponder"] = true
            guard NSApp.mainMenu?.performKeyEquivalent(with: paletteEvent) == true else { throw BridgeFailure(code: "SETTINGS_QA_REOPEN_PALETTE", message: "Palette shortcut could not reopen") }
            try await TerminalSmoke.wait("Reopen palette") { palette.isKeyWindow }
            try key(palette, code: 125, characters: String(UnicodeScalar(NSDownArrowFunctionKey)!))
            try key(palette, code: 126, characters: String(UnicodeScalar(NSUpArrowFunctionKey)!))
            try key(palette, code: 125, characters: String(UnicodeScalar(NSDownArrowFunctionKey)!))
            guard let table = view(palette, id: "native-command-list") as? NSTableView, table.selectedRow == 1, let editor = palette.firstResponder as? NSTextView else { throw BridgeFailure(code: "SETTINGS_QA_PALETTE_ARROWS", message: "Native arrow keys did not select the settings command") }
            editor.insertText("settings", replacementRange: NSRange(location: NSNotFound, length: 0))
            try await TerminalSmoke.wait("Filter commands through native text input") { table.numberOfRows == 1 && table.selectedRow == 0 }
            try key(palette, code: 36, characters: "\r")
            try await TerminalSmoke.wait("Execute selected settings command with Return") { !palette.isVisible && current.window.isKeyWindow }
            report["nativeDynamicMenuPaletteKeyboardAndFocusReturn"] = true
            let beforeImport = try Data(contentsOf: snapshotFile), draftBeforeImport = model.values
            await model.importTheme(source: "background=invalid-private-color", name: "QA")
            guard !model.error.isEmpty, model.values == draftBeforeImport, try Data(contentsOf: snapshotFile) == beforeImport else { throw BridgeFailure(code: "SETTINGS_QA_THEME_ERROR", message: "Invalid theme changed settings or the draft") }
            await model.importTheme(source: "background=#162334\nforeground=#E1F0FF\ncursor-color=#FFD166\nselection-background=#354C66\npalette=1=#EF476F", name: "QA 中文")
            guard model.error.isEmpty, model.dirty, try Data(contentsOf: snapshotFile) == beforeImport else { throw BridgeFailure(code: "SETTINGS_QA_THEME_DRAFT", message: "Theme import did not remain a draft") }
            let source = "background=#162334\nforeground=#E1F0FF\npalette=1=#EF476F"
            for (file, name) in [("QA Theme.ghostty", "QA Theme.ghostty"), ("QA Theme.CONF", "QA Theme")] {
                let url = root.appendingPathComponent(file)
                try Data(source.utf8).write(to: url)
                await model.importThemeFile(url)
                guard model.error.isEmpty, model.values["customThemes"]?.array.last?["name"].string == name else { throw BridgeFailure(code: "SETTINGS_QA_THEME_FILENAME", message: "Native theme file name differs from the existing importer") }
            }
            let beforeRejectedFile = model.values
            for (file, bytes) in [("QA Invalid.conf", Data([0xff, 0xfe])), ("QA Oversize.conf", Data(repeating: 65, count: 32001))] {
                let url = root.appendingPathComponent(file); try bytes.write(to: url)
                await model.importThemeFile(url)
                guard !model.error.isEmpty, model.values == beforeRejectedFile, try Data(contentsOf: snapshotFile) == beforeImport else { throw BridgeFailure(code: "SETTINGS_QA_THEME_FILE_REJECT", message: "Rejected theme file changed the draft or store") }
            }
            report["nativeThemeFileNamesAndBoundedReads"] = true
            let fontCapture = try await verifyFontPickers(settings: current, evidence: URL(fileURLWithPath: path).deletingLastPathComponent(), report: &report)
            model.values["appearance"] = .string("dark"); model.values["fontFamily"] = .string("Menlo, monospace")
            model.values["cursorStyle"] = .string("bar"); model.values["cursorBlink"] = .bool(false); model.values["copyOnSelect"] = .bool(true)
            model.values["interfaceTheme"] = .string("ocean")
            model.numbers["fontSize"] = "18"; model.numbers["lineHeight"] = "1.3"; model.numbers["scrollback"] = "4000"; model.numbers["opacity"] = "0.85"
            try await save(model)
            guard model.error.isEmpty else { throw BridgeFailure(code: "SETTINGS_QA_THEME_SAVE", message: "Theme and terminal preferences could not be saved") }
            let project = root.deletingLastPathComponent()
            guard await workspace.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("Settings QA"), "directory": .string(project.path), "workspaceId": .string(workspace.groupID)]) else { throw BridgeFailure(code: "SETTINGS_QA_PROJECT", message: workspace.error) }
            await workspace.newTerminal()
            try await TerminalSmoke.wait("Apply preferences to a real terminal") { workspace.selectedTerminal?.generation != nil && (workspace.selectedTerminal?.qaRenderedFrames ?? 0) > 0 }
            guard let terminal = workspace.selectedTerminal, terminal.error.isEmpty, terminal.view.font.pointSize == 18, terminal.view.font.fontName.contains("Menlo"), terminal.view.lineSpacing == 1.3, terminal.view.backgroundOpacity == 0.85, terminal.view.copyOnSelect, terminal.view.getTerminal().options.scrollback == 4000, String(describing: terminal.view.getTerminal().options.cursorStyle) == "steadyBar", let color = terminal.view.nativeBackgroundColor.usingColorSpace(.sRGB), abs(color.redComponent - 22.0 / 255) < 0.001, let terminalWindow = terminal.view.window else { throw BridgeFailure(code: "SETTINGS_QA_EFFECTS", message: "Saved preferences did not reach the actual terminal") }
            terminal.enqueue(Data("printf '\\033[31mSETTINGS_%s\\033[0m\\n' '中文'\r".utf8))
            try await TerminalSmoke.wait("Read themed terminal output") { terminal.text.contains("SETTINGS_中文") }
            let terminalCapture = "native-settings-themed-terminal.png"
            terminalWindow.makeKeyAndOrderFront(nil)
            try await Task.sleep(for: .milliseconds(200))
            try await TerminalSmoke.capture(window: terminalWindow, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(terminalCapture))
            report["nativeThemeImportDraftFailureAndTerminalEffects"] = true
            await workspace.closeSession()
            guard workspace.state?.sessions.isEmpty == true else { throw BridgeFailure(code: "SETTINGS_QA_CLOSE", message: "Settings QA session was not closed") }
            _ = try await bridge.call("host.shutdownIdle")
            let resetBefore = try Data(contentsOf: snapshotFile)
            model.resetDraft()
            guard model.dirty, try Data(contentsOf: snapshotFile) == resetBefore else { throw BridgeFailure(code: "SETTINGS_QA_RESET_DRAFT", message: "Reset draft was written without saving") }
            try await save(model)
            guard model.error.isEmpty, !model.dirty, model.values["fontSize"] == model.catalog["defaults"]["fontSize"], model.values["agentNotifications"] == .bool(false) else { throw BridgeFailure(code: "SETTINGS_QA_RESET", message: "Reset did not restore shared defaults and notification opt-out") }
            report["explicitResetUsesSharedDefaults"] = true
            let beforeLogin = try Data(contentsOf: snapshotFile)
            guard model.login.simulated else { throw BridgeFailure(code: "SETTINGS_QA_LOGIN_GUARD", message: "QA must not register a real login item") }
            model.login.qaRequireApproval = true; await model.login.setEnabled(true)
            guard model.login.requiresApproval, !model.login.enabled else { throw BridgeFailure(code: "SETTINGS_QA_LOGIN_APPROVAL", message: "Login approval was not retained") }
            await model.login.setEnabled(true)
            guard model.login.enabled, !model.login.requiresApproval else { throw BridgeFailure(code: "SETTINGS_QA_LOGIN_ENABLE", message: "Login opt-in failed") }
            model.login.qaFailNextRequest = true; await model.login.setEnabled(false)
            guard model.login.enabled, !model.login.error.isEmpty else { throw BridgeFailure(code: "SETTINGS_QA_LOGIN_FAILURE", message: "Failed login request lost its state or error") }
            await model.login.setEnabled(false)
            guard !model.login.enabled, model.login.error.isEmpty, try Data(contentsOf: snapshotFile) == beforeLogin, !model.dirty else { throw BridgeFailure(code: "SETTINGS_QA_LOGIN_DISABLE", message: "Login cleanup changed shared preferences") }
            report["simulatedLoginItemOptInApprovalFailureAndDisable"] = true
            report["actualOSLoginRegistrationExecuted"] = false
            var captures: [String] = [paletteCapture, terminalCapture, fontCapture]
            captures.append(try await verifyGlobalMaven(settings: current, evidence: URL(fileURLWithPath: path).deletingLastPathComponent(), report: &report))
            captures.append(try await verifyDatabaseComponents(settings: current, evidence: URL(fileURLWithPath: path).deletingLastPathComponent(), report: &report))
            captures.append(try await verifyJavaComponents(settings: current, evidence: URL(fileURLWithPath: path).deletingLastPathComponent(), report: &report))
            current.window.makeKeyAndOrderFront(nil)
            for (language, appearance, width, name) in [("en", "dark", 900.0, "native-settings-full-dark-en.png"), ("zh-Hans", "light", 660.0, "native-settings-full-light-zh-narrow.png")] {
                model.values["language"] = .string(language); model.values["appearance"] = .string(appearance); model.section = "appearance"
                try await save(model)
                guard model.error.isEmpty else { throw BridgeFailure(code: "SETTINGS_QA_APPEARANCE", message: "Could not save language and appearance") }
                current.window.setContentSize(NSSize(width: CGFloat(width), height: 640))
                try await Task.sleep(for: .milliseconds(200))
                try await TerminalSmoke.capture(window: current.window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name))
                captures.append(name)
            }
            report["captures"] = captures
            await other.close()
        } catch { await other.close(); throw error }
        guard let parent = current.window.parent, !current.window.styleMask.contains(.titled) else { throw BridgeFailure(code: "SETTINGS_QA_OVERLAY", message: "Settings is not attached over the actual workspace") }
        try await TerminalSmoke.wait("Render the actual overlay close control") { (view(current.window, id: "native-settings-close") as? NSButton)?.isEnabled == true }
        guard let close = view(current.window, id: "native-settings-close") as? NSButton else { throw BridgeFailure(code: "SETTINGS_QA_OVERLAY", message: "Missing settings close control") }
        let parentSize = parent.contentView?.bounds.size ?? NSSize(width: 1100, height: 720)
        _ = try await TerminalSmoke.sizeCaptureWindow(parent, width: 640, height: 420)
        current.alignToParent()
        try await TerminalSmoke.wait("Settings overlay fits the minimum actual workspace window") { abs((current.window.contentView?.bounds.height ?? 0) - 420) < 1 && current.model.presentationCardFrame.height > 0 && current.model.presentationCardFrame.maxY <= 420 }
        let overlayCapture = "native-settings-workspace-overlay.png"
        try await TerminalSmoke.capture(window: current.window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(overlayCapture))
        close.performClick(nil)
        try await TerminalSmoke.wait("Actual close control restores the underlying workspace") { !current.window.isVisible && !workspace.settingsPresented && parent.isVisible && parent.isKeyWindow }
        parent.setContentSize(parentSize)
        guard open() === current else { throw BridgeFailure(code: "SETTINGS_QA_OVERLAY", message: "Reopening settings replaced its retained model") }
        try await TerminalSmoke.wait("Reopening attaches the same settings window to the workspace") { current.window.isVisible && current.window.parent === parent && workspace.settingsPresented }
        report["nativeSettingsOverlayProof"] = ["realWorkspaceChildWindow": true, "actualCloseButton": true, "workspaceFocusRestored": true, "sameCachedWindowReopened": true, "minimumWindow640x420": true, "capture": overlayCapture]
        report["manualAcceptance"] = "waived by user"
        report["nativeSettingsFeatureAcceptanceComplete"] = false
        report["remaining"] = ["Automatic update effects remain tracked in #45; preference/file/search/inspector/swap/zoom and GitHub have separate reports; actual OS login approval uses the authorized simulation boundary"]
        current.window.performClose(nil)
    }

    private static func verifyLegacyExport(settings: NativeSettingsWindow, root: URL, evidence: URL, report: inout [String: Any]) async throws {
        let model = settings.model
        guard let bridge = model.workspace.bridge else { throw BridgeFailure(code: "SETTINGS_QA_EXPORT", message: "Missing actual Core bridge") }
        let before = try await bridge.snapshot(), file = root.appendingPathComponent("snapshot-v1.json")
        let bytes = try Data(contentsOf: file), original = model.numbers["fontSize"]
        model.numbers["fontSize"] = "999"; model.section = "general"
        try await TerminalSmoke.wait("Render actual compatibility export entry") { (view(settings.window, id: "native-settings-legacy-export") as? NSButton)?.isEnabled == true }
        guard let button = view(settings.window, id: "native-settings-legacy-export") as? NSButton else { throw BridgeFailure(code: "SETTINGS_QA_EXPORT", message: "Missing export control") }
        _ = button.scrollToVisible(button.bounds)
        guard button.bounds.width > 100, button.bounds.width < 320, abs(button.bounds.height - 28) < 1 else { throw BridgeFailure(code: "SETTINGS_QA_EXPORT", message: "The export action stretched instead of retaining its compact target") }
        button.performClick(nil)
        try await TerminalSmoke.wait("Actual export entry opens its native save sheet") { settings.window.attachedSheet is NSSavePanel && model.busy }
        guard let panel = settings.window.attachedSheet as? NSSavePanel else { throw BridgeFailure(code: "SETTINGS_QA_EXPORT", message: "The actual export sheet is missing") }
        settings.window.performClose(nil)
        guard settings.window.isVisible else { throw BridgeFailure(code: "SETTINGS_QA_EXPORT", message: "Closing bypassed the pending export guard") }
        if settings.window.attachedSheet === panel { panel.cancel(nil) }
        try await TerminalSmoke.wait("Cancelling export restores settings without saving") { settings.window.attachedSheet == nil && !model.busy && settings.window.isVisible }
        guard model.numbers["fontSize"] == "999", try Data(contentsOf: file) == bytes else { throw BridgeFailure(code: "SETTINGS_QA_EXPORT", message: "Cancelled export changed saved data or discarded a draft") }
        let name = "native-settings-legacy-export.json", destination = evidence.appendingPathComponent(name)
        guard await model.exportLegacy(to: destination) else { throw BridgeFailure(code: "SETTINGS_QA_EXPORT", message: model.error) }
        let exportedBytes = try Data(contentsOf: destination), exported = try JSONDecoder().decode(JSONValue.self, from: exportedBytes)
        guard let source = exported["values"]["uterm.desktop.settings.v1"].string,
              try JSONDecoder().decode(JSONValue.self, from: Data(source.utf8)) == before.document.settings,
              exported["revision"].string == before.revision, model.numbers["fontSize"] == "999",
              try Data(contentsOf: file) == bytes else { throw BridgeFailure(code: "SETTINGS_QA_EXPORT", message: "Export changed the store or included an invalid settings draft") }
        guard !(await model.exportLegacy(to: root)), model.errorCode == "LEGACY_EXPORT_FAILED",
              model.numbers["fontSize"] == "999", try Data(contentsOf: file) == bytes,
              try Data(contentsOf: destination) == exportedBytes else { throw BridgeFailure(code: "SETTINGS_QA_EXPORT", message: "Failed export changed data, the previous export or its draft") }
        let capture = "native-settings-legacy-export-error.png"
        try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(capture))
        model.numbers["fontSize"] = original; await model.reload()
        guard model.error.isEmpty, !model.dirty else { throw BridgeFailure(code: "SETTINGS_QA_EXPORT", message: "Explicit reload did not recover export feedback") }
        report["nativeLegacyExportProof"] = ["actualSavePanelCancellation": true, "busyCloseGuard": true, "committedDataExported": true, "storeUnchanged": true, "draftRetained": true, "failedWriteRetainsPreviousExport": true, "capture": capture, "exportFile": name]
    }

    private static func verifyInlineAgents(settings: NativeSettingsWindow, open: () -> NativeSettingsWindow, openAgents: () -> AgentSettingsWindow, root: URL, evidence: URL, report: inout [String: Any]) async throws {
        let model = settings.model, agents = model.agentSettings
        let previousRemote = model.values["usageRemote"] ?? .bool(true)
        model.values["usageRemote"] = .bool(false)
        try await save(model)
        guard model.error.isEmpty else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Could not select isolated local usage") }
        let snapshotFile = root.appendingPathComponent("snapshot-v1.json")
        let before = try Data(contentsOf: snapshotFile)
        guard let bridge = model.workspace.bridge else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Missing isolated Core bridge") }
        let commandsBefore = try await bridge.call("agent.catalog")["definitions"]
        model.section = "agents"
        try await TerminalSmoke.wait("Load inline Agent commands in the settings workspace") { agents.catalog != .null && !agents.busy && view(settings.window, id: "native-agent-field-program") != nil }
        let program = agents.program, commandAgent = agents.selected
        func editProgram(_ text: String) throws {
            guard let field = view(settings.window, id: "native-agent-field-program") as? NSTextField else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Inline Agent command field is missing") }
            _ = field.scrollToVisible(field.bounds)
            settings.window.makeKeyAndOrderFront(nil); settings.window.makeFirstResponder(field)
            guard let editor = field.currentEditor() as? NSTextView else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Inline Agent field editor is missing") }
            editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
            settings.window.makeFirstResponder(nil)
        }
        let draft = "/tmp/uterm-qa-retained-command"
        try editProgram(draft)
        guard agents.program == draft, agents.dirty, settings.window.parent?.isVisible == true else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Actual inline Agent editing did not retain a draft in the workspace") }
        let commandsCapture = "native-settings-inline-agent-command.png"
        try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(commandsCapture))
        guard let usage = view(settings.window, id: "native-settings-section-usage") as? NSButton else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Actual Usage category is missing") }
        let reads = agents.qaUsageReads
        usage.performClick(nil)
        try await TerminalSmoke.wait("Read local usage inside the same settings overlay") { model.section == "usage" && agents.inlineVisible && agents.qaUsageReads > reads && agents.usage(for: agents.usageSelected) != .null && !agents.busy }
        let firstUsageAgent = agents.usageSelected, firstUsage = agents.usage(for: agents.usageSelected)
        guard let tabs = view(settings.window, id: "native-agent-usage-tabs") as? NSSegmentedControl else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Actual Usage Agent tabs are missing") }
        let nextAgent = firstUsageAgent == "kimi" ? "grok" : "kimi"
        let nextReads = agents.qaUsageReadsByAgent[nextAgent] ?? 0
        tabs.selectedSegment = AgentSettingsModel.usageAgents.firstIndex(of: nextAgent)!
        guard let action = tabs.action, NSApp.sendAction(action, to: tabs.target, from: tabs) else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Actual usage tab selection was not delivered") }
        try await TerminalSmoke.wait("Usage Agent tabs refresh independently of an unsaved command") { agents.usageSelected == nextAgent && (agents.qaUsageReadsByAgent[nextAgent] ?? 0) > nextReads && agents.usage(for: nextAgent) != .null && !agents.busy }
        guard agents.selected == commandAgent, agents.program == draft, agents.dirty, agents.usage(for: firstUsageAgent) == firstUsage else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Changing usage Agent discarded a command or another Agent's result") }
        guard !agents.qaUsageLastRemote, !agents.qaUsageLastKeychain, agents.program == draft else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Inline usage lost the command draft or requested account access") }
        let usageCapture = "native-settings-inline-agent-usage.png"
        try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(usageCapture))
        settings.window.performClose(nil)
        try await TerminalSmoke.wait("Closing settings stops inline usage polling") { !settings.window.isVisible && !agents.inlineVisible && !agents.busy }
        let standalone = openAgents()
        try await TerminalSmoke.wait("The menu Agent window uses the same retained command model") { standalone.model === agents && !agents.busy }
        guard agents.program == draft, agents.dirty else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "The existing menu window replaced the inline Agent draft") }
        standalone.window.performClose(nil)
        try await TerminalSmoke.wait("Hide the existing Agent window after its reads finish") { !standalone.window.isVisible && !agents.visible && !agents.busy }
        model.section = "agents"
        guard open() === settings else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Opening settings replaced its cached window") }
        try await TerminalSmoke.wait("Reopen the actual inline Agent editor") { (view(settings.window, id: "native-agent-field-program") as? NSTextField)?.stringValue == draft && !agents.busy }
        NSApp.terminate(nil)
        try await TerminalSmoke.wait("Quit protects the shared Agent draft even when its separate window is hidden") { settings.window.attachedSheet != nil }
        if let sheet = settings.window.attachedSheet { settings.window.endSheet(sheet, returnCode: .alertSecondButtonReturn) }
        try await TerminalSmoke.wait("Cancelled quit resumes inline settings and Agent operations") { !model.frozen && !agents.frozen && settings.window.attachedSheet == nil }
        guard agents.program == draft, agents.dirty, try Data(contentsOf: snapshotFile) == before, try await bridge.call("agent.catalog")["definitions"] == commandsBefore else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Navigation, window hiding or cancelled quit changed the saved Agent command or discarded the draft") }
        try editProgram(program)
        guard !agents.dirty else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Could not restore the isolated command draft") }
        model.values["usageRemote"] = previousRemote
        try await save(model)
        guard model.error.isEmpty else { throw BridgeFailure(code: "SETTINGS_AGENT_QA", message: "Could not restore the saved usage preference") }
        report["nativeInlineAgentSettingsProof"] = ["actualFieldEditor": true, "actualCategorySelection": true, "sameWorkspaceOverlay": true, "sameCachedModelAcrossMenuWindow": true, "inlineLocalUsage": true, "independentUsageAgentTabs": true, "perAgentResultsRetained": true, "automaticKeychainAllowed": agents.qaUsageLastKeychain, "hiddenPollingStopped": true, "cancelledQuitRetainsDraft": true, "savedDataUnchanged": true, "preferencesRestored": true, "captures": [commandsCapture, usageCapture]] as [String: Any]
        model.section = "general"
    }

    private static func verifyDefaultAgent(settings: NativeSettingsWindow, root: URL, evidence: URL, report: inout [String: Any]) async throws {
        let model = settings.model
        guard let bridge = model.workspace.bridge else { throw BridgeFailure(code: "SETTINGS_QA_AGENT", message: "Missing actual Core bridge") }
        let before = try await bridge.snapshot(), definitions = try await bridge.call("agent.catalog")["definitions"]
        let ids = ["qa-settings-a", "qa-settings-b"]
        let fixtures: [JSONValue] = ids.map { .object(["id": .string($0), "name": .string("Settings fixture " + $0), "program": .string("/usr/bin/true"), "arguments": .array([])]) }
        _ = try await bridge.call("agent.definitions.save", params: .object(["definitions": .array(definitions.array + fixtures)]))
        _ = try await bridge.call("settings.patch", params: .object(["expectedRevision": .string(before.revision), "patch": .object(["enabledAgents": .array(ids.map(JSONValue.string))])]))
        await model.workspace.reload(); await model.reload(); model.section = "workspace"
        let file = root.appendingPathComponent("snapshot-v1.json"), readonly = try Data(contentsOf: file)
        try await TerminalSmoke.wait("Render enabled available Agents in the actual picker") { (view(settings.window, id: "native-settings-default-agent") as? NSPopUpButton)?.isEnabled == true }
        guard let picker = view(settings.window, id: "native-settings-default-agent") as? NSPopUpButton,
              picker.itemArray.compactMap({ $0.representedObject as? String }) == ids,
              picker.selectedItem?.representedObject as? String == ids[0], !model.dirty,
              picker.itemArray.allSatisfy({ $0.title.hasPrefix("Settings fixture ") }),
              try Data(contentsOf: file) == readonly else { throw BridgeFailure(code: "SETTINGS_QA_AGENT", message: "Agent filtering, names or read-only fallback differs from shared behavior") }
        picker.selectItem(at: 1)
        guard let action = picker.action, NSApp.sendAction(action, to: picker.target, from: picker) else { throw BridgeFailure(code: "SETTINGS_QA_AGENT", message: "Actual Agent selection was not delivered") }
        try await TerminalSmoke.wait("Save actual default Agent selection") { !model.automaticSaving && !model.busy }
        let selected = try await bridge.snapshot()
        guard model.error.isEmpty, selected.document.settings["defaultAgent"].string == ids[1] else { throw BridgeFailure(code: "SETTINGS_QA_AGENT", message: "Actual Agent selection was not persisted") }
        _ = try await bridge.call("settings.patch", params: .object(["expectedRevision": .string(selected.revision), "patch": .object(["enabledAgents": .array([])])]))
        await model.workspace.reload(); await model.reload()
        let disabledBytes = try Data(contentsOf: file)
        try await TerminalSmoke.wait("Disable the picker when no available Agent is enabled") { !picker.isEnabled && picker.selectedItem?.representedObject as? String == "" }
        guard !model.dirty, try Data(contentsOf: file) == disabledBytes, (try await bridge.snapshot()).document.settings["defaultAgent"].string == ids[1] else { throw BridgeFailure(code: "SETTINGS_QA_AGENT", message: "Empty Agent rendering implicitly rewrote preferences") }
        _ = picker.scrollToVisible(picker.bounds)
        let capture = "native-settings-default-agent-disabled.png"
        try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(capture))
        let current = try await bridge.snapshot()
        _ = try await bridge.call("settings.patch", params: .object(["expectedRevision": .string(current.revision), "patch": .object(["enabledAgents": before.document.settings["enabledAgents"], "defaultAgent": before.document.settings["defaultAgent"]])]))
        _ = try await bridge.call("agent.definitions.save", params: .object(["definitions": definitions]))
        await model.workspace.reload(); await model.reload()
        report["nativeDefaultAgentPickerProof"] = ["actualCoreCatalog": true, "enabledAvailableOnly": true, "customNames": true, "displayFallbackDoesNotWrite": true, "actualPickerAutosaved": true, "disabledEmptyDoesNotWrite": true, "simulatedAgentPrograms": "/usr/bin/true; no real Agent account or login", "capture": capture]
    }

    private static func editField(_ settings: NativeSettingsWindow, key: String, text: String, enter: Bool = false) async throws {
        let id = "native-settings-field-" + key
        try await TerminalSmoke.wait("Render editable native settings field " + key) { (view(settings.window, id: id) as? NSTextField)?.isEnabled == true }
        guard let field = view(settings.window, id: id) as? NSTextField else { throw BridgeFailure(code: "SETTINGS_QA_FIELD", message: "Settings field is missing") }
        settings.window.makeKeyAndOrderFront(nil); settings.window.makeFirstResponder(field)
        guard let editor = field.currentEditor() as? NSTextView else { throw BridgeFailure(code: "SETTINGS_QA_FIELD", message: "Actual AppKit field editor is missing") }
        editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
        guard field.stringValue == text else { throw BridgeFailure(code: "SETTINGS_QA_FIELD", message: "AppKit did not deliver the input") }
        if enter { try Self.key(settings.window, code: 36, characters: "\r") } else { settings.window.makeFirstResponder(nil) }
        try await TerminalSmoke.wait("Complete native field commit") { !settings.model.automaticSaving && !settings.model.busy }
    }

    private static func verifyIconColor(settings: NativeSettingsWindow, evidence: URL, report: inout [String: Any]) async throws {
        let model = settings.model
        guard let bridge = model.workspace.bridge else { throw BridgeFailure(code: "ICON_COLOR_QA", message: "Missing settings bridge") }
        let before = try await bridge.snapshot()
        model.section = "appearance"
        try await TerminalSmoke.wait("Render actual native highlight mode") { (view(settings.window, id: "native-settings-icon-color-mode") as? NSPopUpButton)?.isEnabled == true }
        guard let mode = view(settings.window, id: "native-settings-icon-color-mode") as? NSPopUpButton else { throw BridgeFailure(code: "ICON_COLOR_QA", message: "Missing actual highlight mode control") }
        guard (try await bridge.snapshot()).document.settings == before.document.settings else { throw BridgeFailure(code: "ICON_COLOR_QA", message: "Rendering highlight controls wrote preferences") }
        var attempts: [[String: Any]] = []
        func check(_ value: String) async throws {
            guard case .object(var expected) = before.document.settings else { throw BridgeFailure(code: "ICON_COLOR_QA", message: "Missing preferences") }
            expected["activeIconColor"] = .string(value)
            guard model.error.isEmpty, (try await bridge.snapshot()).document.settings == .object(expected) else { throw BridgeFailure(code: "ICON_COLOR_QA", message: "Highlight selection did not save its field or changed another preference") }
        }
        func commit(_ control: NSControl) async throws {
            let previous = (try await bridge.snapshot()).document.settings["activeIconColor"]
            for attempt in 0..<3 {
                try await TerminalSmoke.wait("Actual highlight control is ready") { control.isEnabled }
                guard let action = control.action, NSApp.sendAction(action, to: control.target, from: control) else { throw BridgeFailure(code: "ICON_COLOR_QA", message: "Actual highlight control action was not delivered") }
                let draft = model.values["activeIconColor"]
                try await TerminalSmoke.wait("Complete highlight control save") { !model.automaticSaving && !model.busy }
                attempts.append(["control": control.identifier?.rawValue ?? "", "attempt": attempt + 1, "errorCode": model.errorCode])
                guard model.errorCode == "WRITER_BUSY", attempt < 2 else { return }
                guard model.values["activeIconColor"] == draft, (try await bridge.snapshot()).document.settings["activeIconColor"] == previous else { throw BridgeFailure(code: "ICON_COLOR_QA", message: "Contention lost the color draft or changed committed data") }
                // Retry by explicitly using the control, without replaying a failed write inside the app.
                // 通过明确操作控件重试，应用内部不重放失败写入。
                try await Task.sleep(for: .milliseconds(100))
            }
        }
        do {
            mode.selectItem(at: 1); try await commit(mode)
            let accent = NativePreferences.interfacePalette(model.workspace.settings, catalog: model.catalog)["accent"].string ?? "#62d98a"
            try await check(accent)
            try await TerminalSmoke.wait("Render actual color well and hex editor") { (view(settings.window, id: "native-settings-icon-color-well") as? NSColorWell)?.isEnabled == true }
            guard let well = view(settings.window, id: "native-settings-icon-color-well") as? NSColorWell else { throw BridgeFailure(code: "ICON_COLOR_QA", message: "Missing actual native color well") }
            well.color = NSColor(srgbRed: 18.0 / 255, green: 52.0 / 255, blue: 86.0 / 255, alpha: 1)
            try await commit(well); try await check("#123456")
            let selected = "native-settings-icon-color-custom.png"
            try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(selected))
            try await editField(settings, key: "activeIconColor", text: "#xyz")
            guard model.errorCode == "INVALID_SETTINGS", model.values["activeIconColor"] == .string("#xyz"), (try await bridge.snapshot()).document.settings["activeIconColor"] == .string("#123456") else { throw BridgeFailure(code: "ICON_COLOR_QA", message: "Invalid highlight input lost its draft or changed the saved color") }
            try await TerminalSmoke.wait("Invalid text keeps the committed swatch color") {
                guard let color = well.color.usingColorSpace(.sRGB) else { return false }
                return abs(color.redComponent - 18.0 / 255) < 0.001 && abs(color.greenComponent - 52.0 / 255) < 0.001 && abs(color.blueComponent - 86.0 / 255) < 0.001
            }
            let invalid = "native-settings-icon-color-invalid.png"
            try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(invalid))
            mode.selectItem(at: 0); try await commit(mode); try await check("")
            try await TerminalSmoke.wait("Follow theme removes custom controls") { view(settings.window, id: "native-settings-icon-color-well") == nil }
            if let original = before.document.settings["activeIconColor"].string, !original.isEmpty {
                mode.selectItem(at: 1); try await commit(mode)
                try await editField(settings, key: "activeIconColor", text: original, enter: true)
                try await check(original)
            }
            await model.reload()
            guard model.error.isEmpty, !model.dirty, (try await bridge.snapshot()).document.settings == before.document.settings else { throw BridgeFailure(code: "ICON_COLOR_QA", message: "Highlight QA did not restore preferences") }
            var proof: [String: Any] = ["actualModePicker": true, "renderDoesNotWrite": true, "customStartsWithThemeAccent": true,
                "actualColorWellAction": true, "fieldScopedPersistence": true, "invalidDraftAndSavedColorRetained": true,
                "followThemeRestored": true, "preferencesRestored": true]
            proof["captures"] = [selected, invalid]
            proof["input"] = "Actual AppKit control action; no physical system color-panel gesture claim"
            report["nativeIconColorProof"] = proof
            report["nativeIconColorAttempts"] = attempts
        } catch { report["nativeIconColorAttempts"] = attempts; throw error }
    }

    private static func verifyAutomaticSave(settings: NativeSettingsWindow, root: URL, evidence: URL, report: inout [String: Any]) async throws {
        let model = settings.model, peer = try await CoreBridge.open(root: root)
        do {
            let before = try await peer.snapshot()
            model.section = "general"
            try await editField(settings, key: "fileTabLimit", text: "0")
            guard model.errorCode == "INVALID_SETTINGS", model.numbers["fileTabLimit"] == "0", (try await peer.snapshot()).document.settings == before.document.settings else { throw BridgeFailure(code: "SETTINGS_QA_AUTO_INVALID", message: "Automatic save lost an invalid draft or wrote it") }
            let limit = before.document.settings["fileTabLimit"].number == 7 ? 8 : 7
            let scrollback = model.numbers["scrollback"], scrollbackDraft = model.numbers["scrollback"] == "4999" ? "4998" : "4999"
            model.numbers["scrollback"] = scrollbackDraft
            try await editField(settings, key: "fileTabLimit", text: String(limit), enter: true)
            let entered = try await peer.snapshot()
            guard model.error.isEmpty, entered.document.settings["fileTabLimit"].number == Double(limit),
                  entered.document.settings["scrollback"] == before.document.settings["scrollback"], model.numbers["scrollback"] == scrollbackDraft else { throw BridgeFailure(code: "SETTINGS_QA_AUTO_ENTER", message: "Return failed to save its field or saved an unrelated draft") }
            model.numbers["scrollback"] = scrollback
            let draft = before.document.settings["fontSize"].number == 18 ? "19" : "18"
            let peerSize = before.document.settings["fontSize"].number == 20 ? 21.0 : 20.0
            model.numbers["fontSize"] = draft
            let snapshot = try await peer.snapshot()
            _ = try await peer.call("settings.patch", params: .object(["expectedRevision": .string(snapshot.revision), "patch": .object(["fontSize": .number(peerSize)])]))
            model.section = "appearance"
            let id = "native-settings-font-interfaceFont"
            try await TerminalSmoke.wait("Render the actual font picker for scoped automatic save") { (view(settings.window, id: id) as? NSPopUpButton)?.isEnabled == true }
            guard let picker = view(settings.window, id: id) as? NSPopUpButton,
                  let option = picker.itemArray.first(where: { ($0.representedObject as? String).map { $0 != model.values["interfaceFont"]?.string } == true }),
                  let font = option.representedObject as? String else { throw BridgeFailure(code: "SETTINGS_QA_AUTO_PICKER", message: "Alternative font preset is missing") }
            var attempts: [[String: Any]] = []
            for attempt in 0..<3 {
                try await TerminalSmoke.wait("Font control is ready for explicit selection") { picker.isEnabled }
                guard let selected = picker.itemArray.first(where: { $0.representedObject as? String == font }) else { throw BridgeFailure(code: "SETTINGS_QA_AUTO_PICKER", message: "Selected font preset disappeared") }
                picker.select(selected)
                guard let action = picker.action, NSApp.sendAction(action, to: picker.target, from: picker) else { throw BridgeFailure(code: "SETTINGS_QA_AUTO_PICKER", message: "Actual font action was not delivered") }
                try await TerminalSmoke.wait("Complete scoped font automatic save") { !model.automaticSaving && !model.busy }
                let observed = try await peer.snapshot()
                attempts.append(["attempt": attempt + 1, "errorCode": model.errorCode, "error": model.error,
                    "expectedFont": font, "savedFont": observed.document.settings["interfaceFont"].string ?? "",
                    "expectedPeerSize": peerSize, "savedPeerSize": observed.document.settings["fontSize"].number ?? -1,
                    "expectedDraft": draft, "retainedDraft": model.numbers["fontSize"] ?? ""])
                report["nativeSettingsAutomaticSaveAttempts"] = attempts
                guard model.errorCode == "WRITER_BUSY", attempt < 2 else { break }
                guard !model.error.isEmpty, model.values["interfaceFont"] == .string(font),
                      observed.document.settings["interfaceFont"] == entered.document.settings["interfaceFont"],
                      observed.document.settings["fontSize"].number == peerSize, model.numbers["fontSize"] == draft else { throw BridgeFailure(code: "SETTINGS_QA_AUTO_BUSY", message: "Writer contention lost the draft, changed committed data or hid its error") }
                try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent("native-settings-autosave-busy.png"))
                // A failed mutation stays failed; QA explicitly selects the same control again, like a user retry.
                // 失败的变更保持失败；QA 像用户重试一样，明确再次选择同一控件。
                try await Task.sleep(for: .milliseconds(100))
            }
            let saved = try await peer.snapshot()
            guard model.error.isEmpty, saved.document.settings["interfaceFont"].string == font,
                  saved.document.settings["fontSize"].number == peerSize, model.numbers["fontSize"] == draft else { throw BridgeFailure(code: "SETTINGS_QA_AUTO_SCOPE", message: "Scoped font save did not satisfy its error, committed-value and retained-draft checks; see nativeSettingsAutomaticSaveAttempts") }
            try await save(model)
            guard model.errorCode == "SETTINGS_CONFLICT", model.numbers["fontSize"] == draft,
                  (try await peer.snapshot()).document.settings["fontSize"].number == peerSize else { throw BridgeFailure(code: "SETTINGS_QA_AUTO_CONFLICT", message: "Saving another field silently rebased the conflicting draft") }
            let capture = "native-settings-autosave-conflict.png"
            try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(capture))
            guard let theme = model.catalog["interfaceThemes"].array.first(where: { $0["id"].string != model.values["interfaceTheme"]?.string }), let themeID = theme["id"].string else { throw BridgeFailure(code: "SETTINGS_QA_THEME_CARD", message: "Alternative shared interface theme is missing") }
            let themeControl = "native-settings-theme-" + themeID
            try await TerminalSmoke.wait("Render actual theme preview controls") { (view(settings.window, id: themeControl) as? NSButton)?.isEnabled == true }
            guard let themeButton = view(settings.window, id: themeControl) as? NSButton else { throw BridgeFailure(code: "SETTINGS_QA_THEME_CARD", message: "Actual theme preview button is missing") }
            themeButton.performClick(nil)
            try await TerminalSmoke.wait("Save the clicked interface theme") { !model.automaticSaving && !model.busy }
            let themed = try await peer.snapshot()
            guard model.error.isEmpty, themed.document.settings["interfaceTheme"].string == themeID,
                  ["darkTheme", "lightTheme", "customThemes", "fontSize", "fontFamily"].allSatisfy({ themed.document.settings[$0] == saved.document.settings[$0] }) else { throw BridgeFailure(code: "SETTINGS_QA_THEME_CARD", message: "Theme selection changed terminal preferences or failed to save") }
            let oldSize = settings.window.contentView?.bounds.size ?? NSSize(width: 760, height: 620)
            var themeCaptures: [String] = []
            for width in [900, 640] {
                settings.window.setContentSize(NSSize(width: CGFloat(width), height: 640))
                try await Task.sleep(for: .milliseconds(200))
                let name = "native-settings-theme-cards-\(width).png"
                try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(name)); themeCaptures.append(name)
            }
            settings.window.setContentSize(oldSize)
            let current = try await peer.snapshot()
            _ = try await peer.call("settings.patch", params: .object(["expectedRevision": .string(current.revision), "patch": .object(["fileTabLimit": before.document.settings["fileTabLimit"], "fontSize": before.document.settings["fontSize"], "interfaceFont": before.document.settings["interfaceFont"], "interfaceTheme": before.document.settings["interfaceTheme"]])]))
            await model.workspace.reload(); await model.reload()
            guard model.error.isEmpty, !model.dirty else { throw BridgeFailure(code: "SETTINGS_QA_AUTO_RELOAD", message: "Explicit reload did not recover the saved preferences") }
            report["nativeSettingsAutomaticSaveProof"] = ["actualFieldEditorBlur": true, "actualFieldEditorEnter": true, "enterRetainsUnrelatedDraft": true, "invalidDraftRetainedWithoutWrite": true, "correctedFieldSavedAutomatically": true, "actualFontPicker": true, "scopedWrite": true, "otherDraftRetained": true, "peerWriteConflictRetained": true, "actualThemePreviewSelection": true, "terminalThemeUnchanged": true, "explicitReloadRecovery": true, "capture": capture, "themeCaptures": themeCaptures]
            await peer.close()
        } catch { await peer.close(); throw error }
    }

    private static func verifyFontPickers(settings: NativeSettingsWindow, evidence: URL, report: inout [String: Any]) async throws -> String {
        let model = settings.model
        guard let bridge = model.workspace.bridge else { throw BridgeFailure(code: "SETTINGS_QA_FONT", message: "Missing font preference bridge") }
        let custom = "QA literal \"中文\", monospace"
        var selected: [String: JSONValue] = [:]
        var capture = ""
        for (key, section) in [("interfaceFont", "appearance"), ("fontFamily", "appearance")] {
            let before = try await bridge.snapshot()
            model.values[key] = .string(custom); model.section = section
            let identifier = "native-settings-font-" + key
            try await TerminalSmoke.wait("Render native custom font selection") { (view(settings.window, id: identifier) as? NSPopUpButton)?.selectedItem?.representedObject as? String == custom }
            guard let picker = view(settings.window, id: identifier) as? NSPopUpButton,
                  let font = model.catalog["fonts"][key].array.dropFirst().first?["value"].string,
                  let option = picker.itemArray.first(where: { $0.representedObject as? String == font }) else { throw BridgeFailure(code: "SETTINGS_QA_FONT", message: "Shared font presets or custom selection are missing") }
            guard (try await bridge.snapshot()).document.settings == before.document.settings else { throw BridgeFailure(code: "SETTINGS_QA_FONT_DRAFT", message: "Rendering a custom font changed saved settings") }
            if key == "interfaceFont" {
                capture = "native-settings-custom-font.png"
                try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(capture))
            }
            picker.select(option)
            guard let action = picker.action, NSApp.sendAction(action, to: picker.target, from: picker), model.values[key] == .string(font) else { throw BridgeFailure(code: "SETTINGS_QA_FONT_ACTION", message: "Native font picker did not retain the shared preset value") }
            try await TerminalSmoke.wait("Persist the actual font selection automatically") { !model.automaticSaving && !model.busy }
            guard model.error.isEmpty, (try await bridge.snapshot()).document.settings[key].string == font else { throw BridgeFailure(code: "SETTINGS_QA_FONT_SAVE", message: "Selected font preset was not saved automatically") }
            selected[key] = .string(font)
        }
        try await save(model)
        let saved = try await bridge.snapshot()
        guard model.error.isEmpty, !model.dirty, selected.allSatisfy({ saved.document.settings[$0.key] == $0.value }) else { throw BridgeFailure(code: "SETTINGS_QA_FONT_SAVE", message: "Selected font values did not round trip through the shared core") }
        report["nativeFontPickersPreserveCustomDraftsAndSaveSharedPresets"] = true
        return capture
    }

    private static func verifyJavaComponents(settings: NativeSettingsWindow, evidence: URL, report: inout [String: Any]) async throws -> String {
        try await TerminalSmoke.wait("Render Java development settings navigation") { (view(settings.window, id: "native-settings-section-java") as? NSButton)?.isEnabled == true }
        guard let navigation = view(settings.window, id: "native-settings-section-java") as? NSButton,
              let home = ProcessInfo.processInfo.environment["JAVA_HOME"], let bridge = settings.model.workspace.sshBridge else {
            throw BridgeFailure(code: "SETTINGS_QA_JAVA", message: "Missing Java settings, isolated bridge or CI JDK")
        }
        navigation.performClick(nil)
        let java = settings.model.javaComponents
        try await TerminalSmoke.wait("Load actual Java component catalog and JDK list") { !java.loading && java.catalog != .null }
        guard java.error.isEmpty, java.catalog["items"].array.compactMap({ $0["id"].string }).sorted() == ["jdk-11", "jdk-17", "jdk-21", "jdk-8", "maven"],
              !java.working else { throw BridgeFailure(code: "SETTINGS_QA_JAVA", message: "Java settings did not load all managed tools without starting a download") }
        let before = try await bridge.snapshot()
        java.adding = true; java.home = "/missing JDK 中文 & %"
        try await TerminalSmoke.wait("Render actual JDK registration button") { (view(settings.window, id: "native-java-register") as? NSButton)?.isEnabled == true }
        guard let add = view(settings.window, id: "native-java-register") as? NSButton else { throw BridgeFailure(code: "SETTINGS_QA_JAVA", message: "JDK register control missing") }
        add.performClick(nil)
        try await TerminalSmoke.wait("Retain invalid JDK path and show visible failure") { !java.mutating && !java.error.isEmpty }
        guard java.home == "/missing JDK 中文 & %", java.adding else { throw BridgeFailure(code: "SETTINGS_QA_JAVA", message: "Invalid JDK path was lost") }
        java.home = home
        try await TerminalSmoke.wait("Re-enable the actual JDK registration control after rejected input") { (view(settings.window, id: "native-java-register") as? NSButton)?.isEnabled == true }
        guard let retry = view(settings.window, id: "native-java-register") as? NSButton else { throw BridgeFailure(code: "SETTINGS_QA_JAVA", message: "Updated JDK register control missing") }
        retry.performClick(nil)
        do {
            try await TerminalSmoke.wait("Register real local full JDK through actual AppKit button") { !java.mutating && java.error.isEmpty && !java.adding }
        } catch {
            report["javaRegistrationDiagnostics"] = ["error": java.error, "adding": java.adding, "mutating": java.mutating, "blocked": java.blocked, "home": java.home, "liveButtonEnabled": (view(settings.window, id: "native-java-register") as? NSButton)?.isEnabled ?? false] as [String: Any]
            throw error
        }
        guard let registered = java.jdks.first(where: { $0["registered"].bool == true }), let canonical = registered["home"].string,
              registered["available"].bool == true else { throw BridgeFailure(code: "SETTINGS_QA_JAVA", message: "Real local JDK record is missing") }
        await java.register(canonical, remove: true)
        let after = try await bridge.snapshot()
        guard java.error.isEmpty, !java.jdks.contains(where: { $0["home"].string == canonical && $0["registered"].bool == true }),
              FileManager.default.fileExists(atPath: URL(fileURLWithPath: canonical).appendingPathComponent("bin/javac").path),
              after.document.workspace == before.document.workspace, after.document.settings == before.document.settings else { throw BridgeFailure(code: "SETTINGS_QA_JAVA", message: "JDK record removal changed files or workspace/settings state") }
        let name = "native-settings-java-components.png"
        try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(name))
        report["nativeJavaCatalogDetectionRegistrationFailureRetentionAndRecordRemoval"] = true
        return name
    }

    private static func verifyDatabaseComponents(settings: NativeSettingsWindow, evidence: URL, report: inout [String: Any]) async throws -> String {
        let components = settings.model.databaseComponents
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent().appendingPathComponent("database-components-v1")
        let existed = FileManager.default.fileExists(atPath: root.path)
        try await TerminalSmoke.wait("Enable database components navigation") { (view(settings.window, id: "native-settings-section-database") as? NSButton)?.isEnabled == true }
        guard let button = view(settings.window, id: "native-settings-section-database") as? NSButton, button.isEnabled else { throw BridgeFailure(code: "SETTINGS_QA_COMPONENTS", message: "Database components navigation is missing") }
        button.performClick(nil)
        try await TerminalSmoke.wait("Read database components without downloading") { !components.loading && components.status != .null }
        let ids = Set(components.status["items"].array.compactMap { $0["id"].string })
        guard components.error.isEmpty, !components.working, !components.connected,
              ids == Set(["mysql", "postgresql", "oracle", "mongodb", "mongodb-core", "mongodb-bson", "runtime"]),
              FileManager.default.fileExists(atPath: root.path) == existed else {
            throw BridgeFailure(code: "SETTINGS_QA_COMPONENTS", message: "Component navigation changed data or did not load the catalog")
        }
        let capture = "native-settings-database-components.png"
        try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(capture))
        report["nativeDatabaseComponentsReadonlyCatalogWithoutDownloads"] = true
        return capture
    }

    private static func verifyGlobalMaven(settings: NativeSettingsWindow, evidence: URL, report: inout [String: Any]) async throws -> String {
        let maven = settings.model.maven
        settings.window.makeKeyAndOrderFront(nil)
        try await TerminalSmoke.wait("Render the Maven settings navigation button") { (view(settings.window, id: "native-settings-section-maven") as? NSButton)?.isEnabled == true }
        guard let navigation = view(settings.window, id: "native-settings-section-maven") as? NSButton else { throw BridgeFailure(code: "SETTINGS_QA_MAVEN", message: "Maven settings navigation is missing") }
        navigation.performClick(nil)
        try await TerminalSmoke.wait("Load standalone global Maven configuration") { !maven.busy && !maven.values.isEmpty }
        guard maven.error.isEmpty, !maven.dirty else { throw BridgeFailure(code: "SETTINGS_QA_MAVEN", message: "Global Maven settings could not be read") }
        let root = try WorkspaceModel.dataRoot(), peer = try await CoreBridge.open(root: root)
        do {
            let directory = root.deletingLastPathComponent().path
            var configuration = try await peer.call("java.configuration", params: .object(["directory": .string(directory)]))
            guard case .object(var project) = configuration["project"] else { throw BridgeFailure(code: "SETTINGS_QA_MAVEN", message: "Missing project configuration fixture") }
            project["main_class"] = .string("qa.KeepProjectDraft")
            _ = try await peer.call("java.saveConfiguration", params: .object([
                "directory": .string(directory), "revision": configuration["revision"], "project": .object(project), "global": .null
            ]))
            await maven.reload(discard: true)
            let literal = root.deletingLastPathComponent().appendingPathComponent("Maven 中文 & paths").path
            maven.values["home"] = .string(literal)
            try await TerminalSmoke.wait("Enable the actual Maven save button") { (view(settings.window, id: "native-maven-settings-save") as? NSButton)?.isEnabled == true }
            guard let save = view(settings.window, id: "native-maven-settings-save") as? NSButton else { throw BridgeFailure(code: "SETTINGS_QA_MAVEN", message: "Maven save button is missing") }
            save.performClick(nil)
            try await TerminalSmoke.wait("Save global Maven through the actual button") { !maven.busy && !maven.dirty && maven.error.isEmpty }
            configuration = try await peer.call("java.configuration", params: .object(["directory": .string(directory)]))
            guard configuration["global"]["home"].string == literal, configuration["project"] == .object(project) else { throw BridgeFailure(code: "SETTINGS_QA_MAVEN", message: "Global save changed project configuration or literal paths") }
            maven.values["home"] = .string(literal + " local draft")
            guard case .object(var peerGlobal) = configuration["global"] else { throw BridgeFailure(code: "SETTINGS_QA_MAVEN", message: "Missing global configuration") }
            peerGlobal["repository"] = .string(literal + " peer repository")
            _ = try await peer.call("java.saveConfiguration", params: .object([
                "directory": .null, "revision": configuration["revision"], "project": .null, "global": .object(peerGlobal)
            ]))
            try await TerminalSmoke.wait("Enable stale global Maven save") { save.isEnabled }
            save.performClick(nil)
            try await TerminalSmoke.wait("Reject stale global Maven through the actual button") { !maven.busy && maven.errorCode == "JAVA_CONFIG_CONFLICT" }
            configuration = try await peer.call("java.configuration", params: .object(["directory": .string(directory)]))
            guard maven.dirty, maven.values["home"]?.string == literal + " local draft", configuration["global"] == .object(peerGlobal), configuration["project"] == .object(project) else { throw BridgeFailure(code: "SETTINGS_QA_MAVEN", message: "Conflict lost a Maven draft or peer/project settings") }
            settings.window.performClose(nil)
            guard !settings.window.isVisible, maven.dirty else { throw BridgeFailure(code: "SETTINGS_QA_MAVEN", message: "Hiding settings lost the Maven draft") }
            settings.window.makeKeyAndOrderFront(nil)
            let capture = "native-settings-maven-conflict.png"
            try await TerminalSmoke.capture(window: settings.window, path: evidence.appendingPathComponent(capture))
            report["mavenConflictScreenshot"] = capture
            await maven.reload(discard: true)
            guard !maven.dirty, maven.error.isEmpty, maven.values == peerGlobal else { throw BridgeFailure(code: "SETTINGS_QA_MAVEN", message: "Explicit Maven reload did not read the peer settings") }
            report["nativeGlobalMavenActualSaveConflictDraftAndProjectPreservation"] = true
            await peer.close()
            return capture
        } catch { await peer.close(); throw error }
    }
}
