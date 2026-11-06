import AppKit
import UTermBridge

@MainActor
enum SettingsSmoke {
    private static func save(_ model: NativeSettingsModel) async throws {
        for _ in 0..<3 {
            await model.save()
            if model.errorCode != "WRITER_BUSY" { return }
            try await Task.sleep(for: .milliseconds(100))
        }
    }
    private static func button(_ window: NSWindow, id: String) -> NSButton? {
        var queue = window.contentView.map { [$0] } ?? []
        while !queue.isEmpty {
            let view = queue.removeFirst()
            if let button = view as? NSButton, button.identifier?.rawValue == id { return button }
            queue += view.subviews
        }
        return nil
    }
    static func run(workspace: WorkspaceModel, open: () -> NativeSettingsWindow, report: inout [String: Any]) async throws {
        guard workspace.ready, let bridge = workspace.bridge, let path = WorkspaceModel.argument("--settings-smoke-report") else { throw BridgeFailure(code: "SETTINGS_QA_CONTEXT", message: "Missing isolated settings context") }
        let root = try WorkspaceModel.dataRoot()
        let snapshotFile = root.appendingPathComponent("snapshot-v1.json")
        let before = try Data(contentsOf: snapshotFile)
        guard let menuItem = NSApp.mainMenu?.items.compactMap(\.submenu).flatMap(\.items).first(where: { $0.action.map(NSStringFromSelector) == "openFullSettings" }), let action = menuItem.action, NSApp.sendAction(action, to: menuItem.target, from: menuItem) else { throw BridgeFailure(code: "SETTINGS_QA_MENU", message: "All settings menu action is missing") }
        let current = open(), model = current.model
        try await TerminalSmoke.wait("Load complete settings catalog") { !model.values.isEmpty && !model.busy }
        guard model.error.isEmpty, try Data(contentsOf: snapshotFile) == before else { throw BridgeFailure(code: "SETTINGS_QA_OPEN", message: "Opening settings changed saved defaults") }
        report["nativeSettingsMenuAndReadonlyOpen"] = true
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
            try await TerminalSmoke.wait("Render native shortcut capture") { button(current.window, id: "native-shortcut-palette") != nil }
            guard let capture = button(current.window, id: "native-shortcut-palette") else { throw BridgeFailure(code: "SETTINGS_QA_CAPTURE", message: "Shortcut capture control is missing") }
            capture.performClick(nil)
            guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command, .shift], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: current.window.windowNumber, context: nil, characters: "K", charactersIgnoringModifiers: "k", isARepeat: false, keyCode: 40), current.window.performKeyEquivalent(with: event) else { throw BridgeFailure(code: "SETTINGS_QA_KEY", message: "Native shortcut event was not captured") }
            guard model.shortcuts["palette"] == "Mod+Shift+KeyK" else { throw BridgeFailure(code: "SETTINGS_QA_CHORD", message: "Native shortcut did not preserve its semantic chord") }
            try await save(model)
            guard model.error.isEmpty else { throw BridgeFailure(code: "SETTINGS_QA_SHORTCUT_SAVE", message: "Captured shortcut could not be saved") }
            report["nativeShortcutCaptureAndSave"] = true
            let beforeImport = try Data(contentsOf: snapshotFile), draftBeforeImport = model.values
            await model.importTheme(source: "background=invalid-private-color", name: "QA")
            guard !model.error.isEmpty, model.values == draftBeforeImport, try Data(contentsOf: snapshotFile) == beforeImport else { throw BridgeFailure(code: "SETTINGS_QA_THEME_ERROR", message: "Invalid theme changed settings or the draft") }
            await model.importTheme(source: "background=#162334\nforeground=#E1F0FF\ncursor-color=#FFD166\nselection-background=#354C66\npalette=1=#EF476F", name: "QA 中文")
            guard model.error.isEmpty, model.dirty, try Data(contentsOf: snapshotFile) == beforeImport else { throw BridgeFailure(code: "SETTINGS_QA_THEME_DRAFT", message: "Theme import did not remain a draft") }
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
            var captures: [String] = [terminalCapture]
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
        report["remaining"] = ["Remaining preference effects, command/menu integration and login startup are tracked in #41"]
        current.window.orderOut(nil)
    }
}
