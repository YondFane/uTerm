import AppKit
import Foundation
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

        window.performClose(nil)
        guard !window.isVisible else { throw BridgeFailure(code: "SMOKE_HIDE", message: "Close did not hide the native window") }
        first.enqueue(Data("printf 'HIDDEN_%s\\n' READY\r".utf8))
        try await wait("Retain output while the window is hidden") { first.text.contains("HIDDEN_READY") }
        window.makeKeyAndOrderFront(nil)
        report["hideAndReopenRetainedOutput"] = window.isVisible

        var captures: [String] = [loadCapture, vimCapture]
        guard let settingsMenu = NSApp.mainMenu?.items.first?.submenu,
              let item = settingsMenu.items.first(where: { $0.action.map(NSStringFromSelector) == "settings" }),
              let action = item.action, NSApp.sendAction(action, to: item.target, from: item) else {
            throw BridgeFailure(code: "SMOKE_SETTINGS", message: "Native Settings menu action is missing")
        }
        try await wait("Present Settings from its native menu") { model.settingsPresented && window.attachedSheet?.isVisible == true }
        guard let sheet = window.attachedSheet else { throw BridgeFailure(code: "SMOKE_SETTINGS", message: "Settings sheet is missing") }
        try await Task.sleep(for: .milliseconds(150))
        if let reportPath = WorkspaceModel.argument("--terminal-smoke-report") {
            let name = "native-settings.png"
            try await capture(window: sheet, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name))
            captures.append(name)
        }
        report["settingsOpenedFromNativeMenu"] = true
        report["settingsScene"] = ["language": model.settings["language"].string ?? "system", "appearance": model.settings["appearance"].string ?? "system", "windowWidth": sheet.frame.width] as [String: Any]
        try postKey(window: sheet, code: 36, characters: "\r")
        try await wait("Dismiss Settings with Return") { !model.settingsPresented && window.attachedSheet == nil }
        report["settingsDismissedWithReturn"] = true
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
        guard abs(model.toolbarHeight - 40) < 1 else { throw BridgeFailure(code: "SMOKE_TOOLBAR", message: "Measured native toolbar height differs from the 40pt target") }
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

    private static func postKey(window: NSWindow, code: UInt16, characters: String) throws {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, characters: characters, charactersIgnoringModifiers: characters,
                isARepeat: false, keyCode: code) else {
                throw BridgeFailure(code: "SMOKE_KEY", message: "Could not construct native keyboard event")
            }
            NSApp.postEvent(event, atStart: false)
        }
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
    }
}
