import AppKit
import Foundation
import ImageIO
import UTermBridge

@MainActor
enum TerminalSmoke {
    static func wait(_ label: String, until condition: @escaping @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(12)
        while !condition() {
            guard Date() < deadline else { throw BridgeFailure(code: "SMOKE_TIMEOUT", message: label) }
            try await Task.sleep(for: .milliseconds(25))
        }
    }

    static func run(model: WorkspaceModel, window: NSWindow?, reconnect: Bool, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.bridge, let window else { throw BridgeFailure(code: "SMOKE_STARTUP", message: model.error) }
        if reconnect {
            guard model.state?.sessions.count == 2 else { throw BridgeFailure(code: "SMOKE_REPLAY", message: "Persisted split sessions were not restored") }
            try await wait("Reattach both retained processes") { model.terminals.count == 2 && model.terminals.values.allSatisfy { $0.generation != nil && $0.error.isEmpty } }
            try await wait("Replay retained Unicode output") { model.terminals.values.contains { $0.text.contains("UTERM_中文 é") } }
            try await wait("Display both restored native terminal views") {
                model.terminals.values.allSatisfy { $0.view.window === window && $0.view.visibleRect.width > 0 && $0.view.visibleRect.height > 0 }
            }
            report["restoredTerminalViewsVisible"] = true
            report["replayed"] = true
            report["sessions"] = model.terminals.values.map { ["id": $0.id, "generation": $0.generation ?? ""] }
            let ids = model.state?.sessions.map(\.sessionID) ?? []
            for id in ids { await model.selectSession(id); await model.closeSession() }
            let status = try await bridge.call("host.status")
            guard !(status["sessions"].array.contains { $0["running"].bool == true }), model.state?.sessions.isEmpty == true else { throw BridgeFailure(code: "SMOKE_CLOSE", message: "Explicit close did not release both sessions") }
            report["explicitCloseStoppedProcesses"] = true
            _ = try await bridge.call("host.shutdownIdle")
            report["idleHostShutdown"] = true
            return
        }

        let project = try WorkspaceModel.dataRoot().deletingLastPathComponent()
        guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("Terminal QA"), "directory": .string(project.path), "workspaceId": .string(model.groupID)]) else {
            throw BridgeFailure(code: "SMOKE_PROJECT", message: model.error)
        }
        await model.newTerminal()
        try await wait("Create the first real PTY") { model.selectedTerminal?.generation != nil && model.selectedTerminal?.error.isEmpty == true && (model.selectedTerminal?.qaRenderedFrames ?? 0) > 0 }
        guard let first = model.selectedTerminal else { throw BridgeFailure(code: "SMOKE_SESSION", message: "No first terminal") }
        let firstID = first.id
        let firstView = ObjectIdentifier(first.view)
        first.enqueue(Data("printf '\\033[31mUTERM_%s é\\033[0m\\n' '中文'\r".utf8))
        try await wait("Parse ANSI and Unicode from the PTY") { first.text.contains("UTERM_中文 é") }
        first.enqueue(Data("printf '\\033[?1049hALT_SCREEN\\033[?1049l\\033[?2004h\\033[?1000h\\nTUI_%s\\n' READY\r".utf8))
        try await wait("Return from alternate screen") { first.text.contains("TUI_READY") }
        report["unicodeAndAnsiParsed"] = true
        report["alternateScreenReturned"] = true
        let vimCapture = try await verifyVim(window: window, terminal: first, project: project, report: &report)
        let loadCapture = try await verifySlowConsumer(model: model, window: window, terminal: first, report: &report)

        await model.split("horizontal")
        try await wait("Create a real split peer") { model.state?.sessions.count == 2 && model.selectedTerminal?.generation != nil && model.selectedTerminal?.error.isEmpty == true && (model.selectedTerminal?.qaRenderedFrames ?? 0) > 0 }
        guard let second = model.selectedTerminal, second.id != firstID else { throw BridgeFailure(code: "SMOKE_SPLIT", message: "A split peer was not created") }
        let secondView = ObjectIdentifier(second.view)
        try await wait("Display both native terminal views") { first.view.window === window && second.view.window === window && first.view.bounds.width > 0 && second.view.bounds.width > 0 }
        second.enqueue(Data("printf 'SECOND_%s\\n' READY\r".utf8))
        try await wait("Read split peer output") { second.text.contains("SECOND_READY") }
        await model.selectSession(firstID)
        guard ObjectIdentifier(first.view) == firstView, ObjectIdentifier(second.view) == secondView else { throw BridgeFailure(code: "SMOKE_VIEW", message: "Terminal views were replaced") }
        report["splitSessionCount"] = model.state?.sessions.count ?? 0
        report["visibleTerminalViews"] = model.terminals.values.filter { $0.view.window === window && $0.view.bounds.width > 0 }.count

        try await verifySidebarKeyboard(model: model, window: window, first: firstID, second: second.id)
        report["sidebarKeyboardSelectionRetainedFocus"] = true
        let sessionCaptures = try await verifySessionMenus(model: model, window: window, first: first, second: second, report: &report)

        window.performClose(nil)
        guard !window.isVisible else { throw BridgeFailure(code: "SMOKE_HIDE", message: "Close did not hide the native window") }
        first.enqueue(Data("printf 'HIDDEN_%s\\n' READY\r".utf8))
        try await wait("Retain output while the window is hidden") { first.text.contains("HIDDEN_READY") }
        window.makeKeyAndOrderFront(nil)
        report["hideAndReopenRetainedOutput"] = window.isVisible

        var captures: [String] = [loadCapture, vimCapture] + sessionCaptures
        guard let settingsMenu = NSApp.mainMenu?.items.first?.submenu,
              let item = settingsMenu.items.first(where: { $0.action.map(NSStringFromSelector) == "settings" }),
              let action = item.action, NSApp.sendAction(action, to: item.target, from: item) else {
            throw BridgeFailure(code: "SMOKE_SETTINGS", message: "Native Settings menu action is missing")
        }
        try await wait("Present full Settings from its native menu") {
            model.settingsPresented && NSApp.windows.contains { $0.identifier?.rawValue == "native-full-settings" && $0.isVisible }
        }
        guard let sheet = NSApp.windows.first(where: { $0.identifier?.rawValue == "native-full-settings" && $0.isVisible }) else { throw BridgeFailure(code: "SMOKE_SETTINGS", message: "Full Settings window is missing") }
        try await Task.sleep(for: .milliseconds(150))
        if let reportPath = WorkspaceModel.argument("--terminal-smoke-report") {
            let name = "native-settings.png"
            try await capture(window: sheet, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name))
            captures.append(name)
        }
        report["settingsOpenedFromNativeMenu"] = true
        report["settingsScene"] = ["language": model.settings["language"].string ?? "system", "appearance": model.settings["appearance"].string ?? "system", "windowWidth": sheet.frame.width] as [String: Any]
        try postKey(window: sheet, code: 13, characters: "w", modifiers: .command)
        try await wait("Dismiss full Settings with Command-W") { !model.settingsPresented && !sheet.isVisible }
        report["settingsDismissedWithCommandW"] = true
        for language in ["en", "zh-Hans"] {
            for appearance in ["dark", "light"] {
                await model.patchSettings(["language": .string(language), "appearance": .string(appearance)])
                for width in [1100, 640] {
                    window.setContentSize(NSSize(width: width, height: 720))
                    try await Task.sleep(for: .milliseconds(150))
                    guard ObjectIdentifier(first.view) == firstView, ObjectIdentifier(second.view) == secondView else { throw BridgeFailure(code: "SMOKE_VIEW", message: "Layout changes replaced a terminal view") }
                    let name = "native-\(language)-\(appearance)-\(width).png"
                    if let reportPath = WorkspaceModel.argument("--terminal-smoke-report") {
                        let path = URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name)
                        try await capture(window: window, path: path)
                        captures.append(name)
                    }
                }
            }
        }
        model.sidebarVisible = false
        try await Task.sleep(for: .milliseconds(150))
        if let reportPath = WorkspaceModel.argument("--terminal-smoke-report") {
            let name = "native-sidebar-hidden.png"
            try await capture(window: window, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name))
            captures.append(name)
        }
        model.sidebarVisible = true
        window.toggleFullScreen(nil)
        try await wait("Enter actual full screen") { model.fullScreen }
        try await Task.sleep(for: .milliseconds(300))
        if let reportPath = WorkspaceModel.argument("--terminal-smoke-report") {
            let name = "native-fullscreen.png"
            try await capture(window: window, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name))
            captures.append(name)
        }
        window.toggleFullScreen(nil)
        try await wait("Exit actual full screen") { !model.fullScreen }
        report["fullScreenEnteredAndExited"] = true
        let lifecycleIdentities = model.terminals.values.map { $0.id + ":" + ($0.generation ?? "") }.sorted()
        let originalFrame = window.frame
        NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willSleepNotification, object: NSWorkspace.shared)
        window.setFrameOrigin(NSPoint(x: originalFrame.origin.x + 40, y: originalFrame.origin.y - 30))
        NotificationCenter.default.post(name: NSApplication.didChangeScreenParametersNotification, object: NSApp)
        NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didWakeNotification, object: NSWorkspace.shared)
        window.setFrame(originalFrame, display: true)
        guard let resumed = model.selectedTerminal else { throw BridgeFailure(code: "SMOKE_WAKE", message: "Selected terminal disappeared after lifecycle notifications") }
        resumed.enqueue(Data("printf 'WAKE_%s\\n' OK\r".utf8))
        try await wait("Continue real output after simulated sleep/display notifications") { resumed.text.contains("WAKE_OK") }
        guard lifecycleIdentities == model.terminals.values.map({ $0.id + ":" + ($0.generation ?? "") }).sorted(), ObjectIdentifier(first.view) == firstView else { throw BridgeFailure(code: "SMOKE_WAKE_IDENTITY", message: "Lifecycle notifications replaced a session or view") }
        report["lifecycleSimulation"] = ["passed": true, "driver": "Posted NSWorkspace sleep/wake and display-parameter notifications; programmatic window movement", "physicalSleep": false, "physicalMultipleDisplays": false, "availableDisplays": NSScreen.screens.count, "sameGenerationAndView": true, "realPTYOutputAfterWake": true] as [String: Any]
        report["sidebarHiddenAndRestored"] = model.sidebarVisible
        report["captures"] = captures
        report["viewIdentityRetained"] = true
        guard abs(model.toolbarHeight - CGFloat(CoreChrome.titlebarHeight)) < 1 else { throw BridgeFailure(code: "SMOKE_TOOLBAR", message: "Measured native toolbar height differs from the shared chrome target") }
        report["nativeToolbarHeight"] = model.toolbarHeight
        report["sessions"] = model.terminals.values.map { ["id": $0.id, "generation": $0.generation ?? ""] }
        let status = try await bridge.call("host.status")
        guard status["sessions"].array.filter({ $0["running"].bool == true }).count == 2,
              status["executable"].string?.hasSuffix("uterm-session-host") == true else { throw BridgeFailure(code: "SMOKE_HELPER", message: "Host is not the staged standalone Rust executable") }
        report["hostExecutable"] = status["executable"].string ?? ""
        report["hostStarted"] = true
        report["runningProcessesBeforeQuit"] = 2
    }

    private static func verifyVim(window: NSWindow, terminal: TerminalSession, project: URL, report: inout [String: Any]) async throws -> String {
        guard FileManager.default.isExecutableFile(atPath: "/usr/bin/vim"),
              let path = WorkspaceModel.argument("--terminal-smoke-report"),
              window.makeFirstResponder(terminal.view) else {
            throw BridgeFailure(code: "SMOKE_VIM", message: "System Vim or native terminal focus is unavailable")
        }
        let file = project.appendingPathComponent("native-tui-qa.txt")
        guard !FileManager.default.fileExists(atPath: file.path) else { throw BridgeFailure(code: "SMOKE_VIM", message: "The disposable Vim file already exists") }
        let generation = terminal.generation
        let view = ObjectIdentifier(terminal.view)
        terminal.enqueue(Data("printf '\\033[?1000l\\033[?2004l'; /usr/bin/vim -Nu NONE -n -i NONE --cmd 'set encoding=utf-8 fileencoding=utf-8' native-tui-qa.txt\r".utf8))
        try await wait("Start the actual Vim alternate screen") { terminal.view.getTerminal().isCurrentBufferAlternate && terminal.text.contains("native-tui-qa.txt") }
        try postKey(window: window, code: 34, characters: "i")
        try await wait("Enter Vim insertion through the native key event") { terminal.text.contains("-- INSERT --") }
        let typed = "NATIVE_VIM_中文 é 😀"
        let inputBeforeComposition = terminal.qaUserInputBytes
        terminal.view.setMarkedText("zhong" as NSString, selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        terminal.view.setMarkedText("中文" as NSString, selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        guard terminal.view.hasMarkedText(), terminal.qaUserInputBytes == inputBeforeComposition else { throw BridgeFailure(code: "SMOKE_COMPOSITION", message: "Uncommitted marked text leaked into the real PTY") }
        terminal.view.insertText(typed as NSString, replacementRange: NSRange(location: NSNotFound, length: 0))
        try await wait("Render actual Vim Unicode input") { terminal.text.contains(typed) }
        guard !terminal.view.hasMarkedText(), terminal.qaUserInputBytes - inputBeforeComposition == typed.utf8.count else { throw BridgeFailure(code: "SMOKE_COMPOSITION_COMMIT", message: "Composition committed duplicate or altered UTF-8 input") }
        report["nativeCompositionSimulation"] = ["passed": true, "driver": "NSTextInputClient setMarkedText/insertText on actual SwiftTerm and Vim", "interimPTYBytes": 0, "committedUTF8Bytes": typed.utf8.count, "physicalIME": false] as [String: Any]
        let clipboard = NSPasteboard.general
        let previous = clipboard.string(forType: .string)
        defer { clipboard.clearContents(); if let previous { clipboard.setString(previous, forType: .string) } }
        clipboard.clearContents()
        let pasted = " PASTE_中文 é"
        guard clipboard.setString(pasted, forType: .string) else { throw BridgeFailure(code: "SMOKE_VIM", message: "Native clipboard write failed") }
        let bracketed = terminal.view.getTerminal().bracketedPasteMode
        guard NSApp.sendAction(NSSelectorFromString("paste:"), to: terminal.view, from: NSApp) else {
            throw BridgeFailure(code: "SMOKE_VIM", message: "Native terminal paste action is unavailable")
        }
        try await wait("Paste through the actual native terminal action") { terminal.text.contains(typed + pasted) }
        let name = "native-vim-edit.png"
        let evidence = URL(fileURLWithPath: path).deletingLastPathComponent()
        try await capture(window: window, path: evidence.appendingPathComponent(name))
        try postKey(window: window, code: 53, characters: "\u{1b}")
        try await wait("Leave actual Vim insertion") { !terminal.text.contains("-- INSERT --") }
        terminal.view.insertText(":wq" as NSString, replacementRange: NSRange(location: NSNotFound, length: 0))
        try postKey(window: window, code: 36, characters: "\r")
        let expected = typed + pasted + "\n"
        try await wait("Save actual Vim bytes and return to the original screen") {
            !terminal.view.getTerminal().isCurrentBufferAlternate && (try? String(contentsOf: file, encoding: .utf8)) == expected
        }
        terminal.enqueue(Data("printf 'NATIVE_SHELL_%s\\n' RETURNED\r".utf8))
        try await wait("Resume the retained real shell after Vim") { terminal.text.contains("NATIVE_SHELL_RETURNED") }
        guard terminal.generation == generation, ObjectIdentifier(terminal.view) == view, terminal.error.isEmpty else {
            throw BridgeFailure(code: "SMOKE_VIM", message: "Vim replaced the terminal or left a transport error")
        }
        let saved = try Data(contentsOf: file)
        guard saved == Data(expected.utf8) else { throw BridgeFailure(code: "SMOKE_VIM", message: "Vim changed the expected UTF-8 bytes") }
        try saved.write(to: evidence.appendingPathComponent("native-vim-saved.txt"), options: .atomic)
        report["realVim"] = ["passed": true, "binary": "/usr/bin/vim", "inputDriver": "Native NSEvent keyDown/up, NSTextInputClient.insertText and native paste: target/action", "alternateScreenReturned": true, "nativeTextInput": true, "nativeClipboardPaste": true, "bracketedPasteActive": bracketed, "suppressedRendererReplyBytes": terminal.qaSuppressedReplyBytes, "savedUTF8Bytes": saved.count, "savedFile": "native-vim-saved.txt", "sameGenerationAndView": true, "shellResumed": true, "manualIMEAcceptance": false, "performanceComparison": false] as [String: Any]
        return name
    }

    private static func verifySlowConsumer(model: WorkspaceModel, window: NSWindow, terminal: TerminalSession, report: inout [String: Any]) async throws -> String {
        let beforeBytes = terminal.qaRenderedBytes
        let beforeFrames = terminal.qaRenderedFrames
        let generation = terminal.generation
        terminal.qaRenderDelay = .milliseconds(150)
        defer { terminal.qaRenderDelay = nil }
        let payload = String(repeating: "x", count: 80)
        terminal.enqueue(Data("i=0; while test \"$i\" -lt 1024; do printf 'NATIVE_LOAD_%04d_\(payload) 中文 é\\n' \"$i\"; i=$((i+1)); done; printf 'NATIVE_END_%s\\nUTERM_%s é\\n' READY 中文\r".utf8))
        try await wait("Observe the deliberately delayed native consumer") { terminal.qaWaitingToRender }
        guard let menu = NSApp.mainMenu?.items.compactMap(\.submenu).first(where: { $0.items.contains { $0.action.map(NSStringFromSelector) == "toggleSidebar" } }),
              let item = menu.items.first(where: { $0.action.map(NSStringFromSelector) == "toggleSidebar" }), let action = item.action else {
            throw BridgeFailure(code: "SMOKE_LOAD", message: "Native sidebar menu missing during delayed consumption")
        }
        let sidebar = model.sidebarVisible
        guard NSApp.sendAction(action, to: item.target, from: item), model.sidebarVisible != sidebar else {
            throw BridgeFailure(code: "SMOKE_LOAD", message: "Native menu did not respond during delayed consumption")
        }
        guard NSApp.sendAction(action, to: item.target, from: item), model.sidebarVisible == sidebar else {
            throw BridgeFailure(code: "SMOKE_LOAD", message: "Native menu did not restore the sidebar")
        }
        try await wait("Render and acknowledge the actual native bulk output") {
            terminal.qaRenderedBytes - beforeBytes >= 100_000 && terminal.text.contains("NATIVE_LOAD_1023") && terminal.text.contains("NATIVE_END_READY") && terminal.qaAcknowledgedFrames == terminal.qaRenderedFrames
        }
        guard terminal.error.isEmpty, terminal.generation == generation else {
            throw BridgeFailure(code: "SMOKE_LOAD", message: "Bulk rendering changed generation or failed: \(terminal.error)")
        }
        report["slowConsumer"] = ["injectedDelayMilliseconds": 150, "records": 1024,
            "renderedBytes": terminal.qaRenderedBytes - beforeBytes,
            "renderedFrames": terminal.qaRenderedFrames - beforeFrames,
            "largestFrameBytes": terminal.qaLargestFrame,
            "acknowledgedAfterRendering": true, "nativeMenuResponsive": true,
            "generationRetained": true, "performanceComparison": false] as [String: Any]
        guard let path = WorkspaceModel.argument("--terminal-smoke-report") else { throw BridgeFailure(code: "SMOKE_LOAD", message: "Load screenshot report path missing") }
        let name = "native-terminal-slow-consumer.png"
        try await capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name))
        return name
    }

    static func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap(descendants)
    }

    static func postKey(window: NSWindow, code: UInt16, characters: String, modifiers: NSEvent.ModifierFlags = []) throws {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: modifiers,
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, characters: characters, charactersIgnoringModifiers: characters,
                isARepeat: false, keyCode: code) else {
                throw BridgeFailure(code: "SMOKE_KEY", message: "Could not construct native keyboard event")
            }
            NSApp.postEvent(event, atStart: false)
        }
    }

    private static func verifySessionMenus(model: WorkspaceModel, window: NSWindow, first: TerminalSession, second: TerminalSession, report: inout [String: Any]) async throws -> [String] {
        guard let content = window.contentView,
              let table = descendants(content).first(where: { $0.identifier?.rawValue == "native-sidebar" }) as? NSTableView,
              let coordinator = table.delegate as? NativeSidebar.Coordinator,
              let bridge = model.bridge, let path = WorkspaceModel.argument("--terminal-smoke-report") else { throw BridgeFailure(code: "SMOKE_SESSION_MENU", message: "Native session menu context is missing") }
        let entries = model.state?.sessions.map(\.session) ?? []
        let generations = [first.generation, second.generation]
        let views = [ObjectIdentifier(first.view), ObjectIdentifier(second.view)]
        func menu(_ id: String) throws -> NSMenu {
            guard let row = (0..<table.numberOfRows).first(where: { table.view(atColumn: 0, row: $0, makeIfNecessary: true)?.identifier?.rawValue == "native-sidebar-row-s:" + id }) else { throw BridgeFailure(code: "SMOKE_SESSION_MENU", message: "Native session row is missing") }
            let menu = NSMenu(); coordinator.populate(menu, row: row); return menu
        }
        func click(_ id: String, _ selector: String, value: String? = nil) throws {
            let menu = try menu(id)
            guard let index = menu.items.firstIndex(where: { $0.action.map(NSStringFromSelector) == selector && $0.isEnabled && (value == nil || $0.representedObject as? String == value) }) else { throw BridgeFailure(code: "SMOKE_SESSION_MENU", message: "Native session action is unavailable: " + selector) }
            menu.performActionForItem(at: index)
        }
        try await wait("Render session menu targets") { !model.busy && table.numberOfRows > 0 }
        try click(second.id, "pin:", value: "true")
        try await wait("Persist session pin through its actual menu") { !model.busy && model.state?.sessions.first(where: { $0.sessionID == second.id })?.session["pinned"].bool == true }
        try click(second.id, "pin:", value: "false")
        try await wait("Restore session pin group") { !model.busy && model.state?.sessions.first(where: { $0.sessionID == second.id })?.session["pinned"].bool == false }
        try click(second.id, "up:")
        try await wait("Persist session menu ordering") { !model.busy && model.sessionOrderPeers(first.id).first?.sessionID == second.id }
        try click(second.id, "down:")
        try await wait("Restore session menu order") { !model.busy && model.sessionOrderPeers(first.id).first?.sessionID == first.id }
        guard let revision = model.state?.snapshot.revision else { throw BridgeFailure(code: "SMOKE_SESSION_MENU", message: "Missing menu revision") }
        let stale = try menu(first.id)
        let previous = model.settings["breakInterval"]
        let next: JSONValue = .number(previous.number == 31 ? 32 : 31)
        _ = try await bridge.call("settings.patch", params: .object(["expectedRevision": .string(revision), "patch": .object(["breakInterval": next])]))
        guard let pin = stale.items.firstIndex(where: { $0.action.map(NSStringFromSelector) == "pin:" }) else { throw BridgeFailure(code: "SMOKE_SESSION_MENU", message: "Missing stale pin action") }
        stale.performActionForItem(at: pin)
        try await wait("Reject a stale session menu write") { !model.busy && !model.error.isEmpty }
        let snapshot = try await bridge.snapshot()
        guard snapshot.document.settings["breakInterval"] == next,
              model.state?.sessions.map(\.session) == entries else { throw BridgeFailure(code: "SMOKE_SESSION_MENU", message: "Stale menu lost a peer setting or changed sessions") }
        await model.reload(); await model.patchSettings(["breakInterval": previous])
        try click(first.id, "ungroup")
        try await wait("Ungroup an existing native session") { !model.busy && model.selectedID == first.id && model.state?.layout["kind"].string == "leaf" && first.view.window === window }
        let ungrouped = "native-session-ungrouped.png"
        try await capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(ungrouped))
        try click(second.id, "group:", value: first.id)
        try await wait("Group existing native sessions without restarting them") { !model.busy && model.state?.layout["kind"].string == "split" && first.view.window === window && second.view.window === window }
        let grouped = "native-session-grouped.png"
        try await capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(grouped))
        guard [first.generation, second.generation] == generations,
              [ObjectIdentifier(first.view), ObjectIdentifier(second.view)] == views,
              model.state?.sessions.map(\.session) == entries,
              (try await bridge.call("host.status"))["sessions"].array.filter({ $0["running"].bool == true }).count == 2 else { throw BridgeFailure(code: "SMOKE_SESSION_MENU", message: "Session menus replaced a descriptor, generation or native terminal view") }
        await model.selectSession(first.id)
        report["nativeSessionMenuPinOrderGroupUngroupAndStaleWrite"] = true
        report["sessionMenuRetainsPTYGenerationsAndViews"] = true
        report["sessionDragGestureExecuted"] = false
        return [ungrouped, grouped]
    }

    private static func verifySidebarKeyboard(model: WorkspaceModel, window: NSWindow, first: String, second: String) async throws {
        guard let content = window.contentView,
              let table = descendants(content).first(where: { $0.identifier?.rawValue == "native-sidebar" }) as? NSTableView else {
            throw BridgeFailure(code: "SMOKE_SIDEBAR", message: "Native sidebar table is missing")
        }
        try await wait("Finish terminal selection and focus") { model.selectedID == first && !model.busy && window.firstResponder === model.terminals[first]?.view }
        guard window.makeFirstResponder(table) else { throw BridgeFailure(code: "SMOKE_FOCUS", message: "Sidebar cannot accept keyboard focus") }
        let down = table.selectedRow < table.numberOfRows - 1
        try postKey(window: window, code: down ? 125 : 126, characters: down ? "\u{F701}" : "\u{F700}")
        try await wait("Select the split peer using a native arrow key") { model.selectedID == second && !model.busy }
        guard window.firstResponder === table else { throw BridgeFailure(code: "SMOKE_FOCUS", message: "Session selection stole sidebar keyboard focus") }
        try postKey(window: window, code: down ? 126 : 125, characters: down ? "\u{F700}" : "\u{F701}")
        try await wait("Return to the first session using a native arrow key") { model.selectedID == first && !model.busy }
        guard window.firstResponder === table else { throw BridgeFailure(code: "SMOKE_FOCUS", message: "Repeated selection stole sidebar keyboard focus") }
    }

    static func capture(window: NSWindow, path: URL) async throws {
        window.displayIfNeeded()
        let identifier = window.windowNumber
        let before = try await captureObstructions(window: identifier, path: path, phase: "before")
        try await Task.detached {
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-o", "-l", String(identifier), path.path]
            let diagnostics = Pipe()
            capture.standardError = diagnostics
            try capture.run()
            capture.waitUntilExit()
            let message = String(decoding: diagnostics.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            guard capture.terminationStatus == 0, FileManager.default.fileExists(atPath: path.path) else {
                throw BridgeFailure(code: "SMOKE_CAPTURE", message: "WindowServer capture failed: " + message)
            }
        }.value
        let after = try await captureObstructions(window: identifier, path: path, phase: "after")
        let visible = before.obstructions.isEmpty && after.obstructions.isEmpty
        let visibility: [String: Any] = ["passed": visible, "windowNumber": identifier, "before": before.obstructions, "after": after.obstructions,
                                       "desktopSurfacesBefore": before.desktop, "desktopSurfacesAfter": after.desktop]
        let data = try JSONSerialization.data(withJSONObject: visibility, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: path.appendingPathExtension("visibility.json"), options: .atomic)
        guard visible else { throw BridgeFailure(code: "SMOKE_CAPTURE_OCCLUDED", message: "Another application's window covers the captured QA window; inspect its visibility report and original PNG") }
    }

    private static func captureObstructions(window identifier: Int, path: URL, phase: String) async throws -> (obstructions: [[String: Any]], desktop: [[String: Any]]) {
        guard let target = (CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(identifier)) as? [[String: Any]])?.first,
              let bounds = target[kCGWindowBounds as String] as? [String: Any],
              let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow, .excludeDesktopElements], CGWindowID(identifier)) as? [[String: Any]] else {
            throw BridgeFailure(code: "SMOKE_CAPTURE_VISIBILITY", message: "Could not inspect WindowServer visibility for the QA window")
        }
        // Keep the original image, but reject acceptance when another application covers it.
        // 保留原图，但其他应用遮挡时拒绝将其作为验收证据。
        var obstructions: [[String: Any]] = [], desktop: [[String: Any]] = []
        for entry in windows {
            guard let pid = entry[kCGWindowOwnerPID as String] as? Int, pid != Int(ProcessInfo.processInfo.processIdentifier),
                  (entry[kCGWindowAlpha as String] as? Double ?? 0) > 0,
                  let bounds = entry[kCGWindowBounds as String] as? [String: Any],
                  let rectangle = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  !frame.intersection(rectangle).isNull, !frame.intersection(rectangle).isEmpty else { continue }
            var record: [String: Any] = ["owner": entry[kCGWindowOwnerName as String] as? String ?? "", "pid": pid,
                    "windowNumber": entry[kCGWindowNumber as String] as? Int ?? 0,
                    "layer": entry[kCGWindowLayer as String] as? Int ?? 0, "bounds": bounds]
            if record["layer"] as? Int == 20, rectangle == CGDisplayBounds(CGMainDisplayID()),
               let processID = Int32(exactly: pid), NSRunningApplication(processIdentifier: processID)?.bundleIdentifier == "com.apple.dock",
               let number = record["windowNumber"] as? Int {
                // WindowServer can give a transparent Dock surface full-screen bounds; inspect its pixels.
                // WindowServer 可能为透明 Dock 图层报告全屏边界，因此检查其实际像素。
                let imagePath = path.deletingPathExtension().appendingPathExtension("desktop-\(phase)-\(number).png")
                do {
                    try await Task.detached {
                        let capture = Process(); capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                        capture.arguments = ["-x", "-o", "-l", String(number), imagePath.path]
                        capture.standardError = FileHandle.nullDevice
                        try capture.run(); capture.waitUntilExit()
                        guard capture.terminationStatus == 0 else { throw BridgeFailure(code: "SMOKE_CAPTURE_ALPHA", message: "Desktop-surface capture failed") }
                    }.value
                    guard let source = CGImageSourceCreateWithURL(imagePath as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw BridgeFailure(code: "SMOKE_CAPTURE_ALPHA", message: "Desktop-surface image is missing") }
                    let pixels = try WindowCaptureAlpha.nontransparentPixels(image: image, windowFrame: rectangle, targetFrame: frame)
                    record["capture"] = imagePath.lastPathComponent; record["nontransparentPixelsInTarget"] = pixels
                    desktop.append(record)
                    if pixels == 0 { continue }
                } catch { record["alphaInspectionFailure"] = error.localizedDescription; desktop.append(record) }
            }
            obstructions.append(record)
        }
        return (obstructions, desktop)
    }

    static func sizeCaptureWindow(_ window: NSWindow, width: Int, height: Int) async throws -> [[String: Any]] {
        var attempts: [[String: Any]] = []
        window.setContentSize(NSSize(width: width, height: height))
        for attempt in 0..<5 {
            window.contentView?.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(150))
            guard let actual = window.contentView?.bounds else { throw BridgeFailure(code: "SMOKE_WINDOW_SIZE", message: "Capture window has no content view") }
            attempts.append(["attempt": attempt, "frame": NSStringFromRect(window.frame), "contentBounds": NSStringFromRect(actual),
                "visibleScreen": NSStringFromRect(window.screen?.visibleFrame ?? .zero)])
            if abs(actual.width - CGFloat(width)) < 0.5 && abs(actual.height - CGFloat(height)) < 0.5 { return attempts }
            var frame = window.frame
            let top = frame.maxY
            frame.size.width += CGFloat(width) - actual.width
            frame.size.height += CGFloat(height) - actual.height
            frame.origin.y = top - frame.height
            window.setFrame(frame, display: true)
        }
        let details = String(decoding: try JSONSerialization.data(withJSONObject: attempts, options: [.sortedKeys]), as: UTF8.self)
        throw BridgeFailure(code: "SMOKE_WINDOW_SIZE", message: "Actual capture content did not reach \(width)x\(height): " + details)
    }
}
