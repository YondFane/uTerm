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
    static func run(workspace: WorkspaceModel, open: () -> NativeSettingsWindow, report: inout [String: Any]) async throws {
        guard workspace.ready, let bridge = workspace.bridge, let path = WorkspaceModel.argument("--settings-smoke-report") else { throw BridgeFailure(code: "SETTINGS_QA_CONTEXT", message: "Missing isolated settings context") }
        let root = try WorkspaceModel.dataRoot()
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
            guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command, .shift], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: current.window.windowNumber, context: nil, characters: "K", charactersIgnoringModifiers: "k", isARepeat: false, keyCode: 40), current.window.performKeyEquivalent(with: event) else { throw BridgeFailure(code: "SETTINGS_QA_KEY", message: "Native shortcut event was not captured") }
            guard model.shortcuts["palette"] == "Mod+Shift+KeyK" else { throw BridgeFailure(code: "SETTINGS_QA_CHORD", message: "Native shortcut did not preserve its semantic chord") }
            try await save(model)
            guard model.error.isEmpty else { throw BridgeFailure(code: "SETTINGS_QA_SHORTCUT_SAVE", message: "Captured shortcut could not be saved") }
            report["nativeShortcutCaptureAndSave"] = true
            current.window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            try await TerminalSmoke.wait("Focus settings before opening its command palette") { current.window.isKeyWindow }
            report["paletteOriginWindow"] = current.window.windowNumber
            guard let unshifted = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: current.window.windowNumber, context: nil, characters: "k", charactersIgnoringModifiers: "k", isARepeat: false, keyCode: 40), NSApp.mainMenu?.performKeyEquivalent(with: unshifted) == false else { throw BridgeFailure(code: "SETTINGS_QA_SHIFT", message: "A shifted shortcut accepted the unshifted event") }
            guard let paletteMenu = NSApp.mainMenu?.items.compactMap(\.submenu).flatMap(\.items).first(where: { $0.representedObject as? String == "palette" }), paletteMenu.keyEquivalent == "K", paletteMenu.keyEquivalentModifierMask == [.command, .shift], let paletteEvent = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command, .shift], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: current.window.windowNumber, context: nil, characters: "K", charactersIgnoringModifiers: "k", isARepeat: false, keyCode: 40), NSApp.mainMenu?.performKeyEquivalent(with: paletteEvent) == true else { throw BridgeFailure(code: "SETTINGS_QA_MENU_BINDING", message: "Saved semantic shortcut did not update the system menu") }
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
                current.window.setContentSize(NSSize(width: width, height: 640))
                try await Task.sleep(for: .milliseconds(200))
                try await TerminalSmoke.capture(window: current.window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name))
                captures.append(name)
            }
            report["captures"] = captures
            await other.close()
        } catch { await other.close(); throw error }
        report["manualAcceptance"] = "waived by user"
        report["nativeSettingsFeatureAcceptanceComplete"] = false
        report["remaining"] = ["Automatic update effects remain tracked in #45; preference/file/search/inspector/swap/zoom and GitHub have separate reports; actual OS login approval uses the authorized simulation boundary"]
        current.window.orderOut(nil)
    }

    private static func verifyFontPickers(settings: NativeSettingsWindow, evidence: URL, report: inout [String: Any]) async throws -> String {
        let model = settings.model
        guard let bridge = model.workspace.bridge else { throw BridgeFailure(code: "SETTINGS_QA_FONT", message: "Missing font preference bridge") }
        let before = try await bridge.snapshot()
        let custom = "QA literal \"中文\", monospace"
        var selected: [String: JSONValue] = [:]
        var capture = ""
        for (key, section) in [("interfaceFont", "appearance"), ("fontFamily", "terminal")] {
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
