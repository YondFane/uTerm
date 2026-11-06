import AppKit
import UTermBridge

@MainActor
enum PreferencesSmoke {
    static func run(workspace: WorkspaceModel, parent: NSWindow, openFile: @escaping (URL, String) async throws -> ContentWindow, report: inout [String: Any]) async throws {
        guard let reportPath = WorkspaceModel.argument("--settings-smoke-report") else { return }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent().appendingPathComponent("preference-files")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for name in ["a.txt", "b.txt", "c.txt"] { try Data((name + "\n").utf8).write(to: root.appendingPathComponent(name)) }
        await workspace.patchSettings(["language": .string("en"), "appearance": .string("dark"), "fileTabLimit": .number(2), "breakReminder": .bool(true), "breakInterval": .number(1)])
        workspace.tickBreakReminder(now: ProcessInfo.processInfo.systemUptime + 61)
        parent.makeKeyAndOrderFront(nil)
        var dismiss: NSButton?
        try await TerminalSmoke.wait("Render the native nonmodal break reminder") {
            var views = parent.contentView.map { [$0] } ?? []
            while !views.isEmpty {
                let view = views.removeFirst()
                if let button = view as? NSButton, button.identifier?.rawValue == "native-break-dismiss" { dismiss = button; return true }
                views += view.subviews
            }
            return false
        }
        guard workspace.breakReminderVisible else { throw BridgeFailure(code: "PREFERENCE_BREAK", message: "Enabled reminder did not show after the simulated interval") }
        let image = "native-preferences-break-dark-en.png"
        try await TerminalSmoke.capture(window: parent, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(image))
        dismiss?.performClick(nil)
        guard !workspace.breakReminderVisible else { throw BridgeFailure(code: "PREFERENCE_BREAK_DISMISS", message: "The actual native Continue button did not dismiss the reminder") }
        await workspace.patchSettings(["breakReminder": .bool(false)])
        workspace.tickBreakReminder(now: ProcessInfo.processInfo.systemUptime + 100000)
        guard !workspace.breakReminderVisible else { throw BridgeFailure(code: "PREFERENCE_BREAK_DISABLED", message: "Disabled reminder appeared") }
        report["nativeBreakReminderRenderDismissAndDisable"] = true
        report["breakReminderClock"] = "Simulated elapsed uptime; actual native window/button, no sleep or human acceptance claim"
        report["preferenceCaptures"] = [image]

        report["preferenceFileStep"] = "Open and render the first editor"
        let first = try await openFile(root, "a.txt")
        try await ContentSmoke.wait(first, "document.querySelector('.cm-content[contenteditable=true]') !== null")
        report["preferenceFileStep"] = "Open and render the second editor"
        let second = try await openFile(root, "b.txt")
        try await ContentSmoke.wait(second, "document.querySelector('.cm-content[contenteditable=true]') !== null")
        report["preferenceFileStep"] = "Edit the first native tab"
        try await EditorSmoke.replace(first, text: "UNSAVED_TAB_LIMIT 中文")
        try await ContentSmoke.wait(first, "document.querySelector('.editor-save-state')?.textContent === 'Unsaved'")
        let external = "EXTERNAL_TAB_LIMIT\n"
        try Data(external.utf8).write(to: root.appendingPathComponent("a.txt"))
        report["preferenceFileStep"] = "Wait for the tab eviction guard"
        do { _ = try await openFile(root, "c.txt"); throw BridgeFailure(code: "PREFERENCE_TAB_CANCEL", message: "Conflicted tab eviction still opened a file") }
        catch let error as BridgeFailure where error.code == "FILE_TAB_CANCELLED" {}
        try await ContentSmoke.wait(first, "document.querySelector('.cm-content[contenteditable=true]') !== null", allowAlert: true)
        first.window?.performClose(nil)
        try await ContentSmoke.wait(first, "document.querySelector('dialog[open]') !== null", allowAlert: true)
        try await EditorSmoke.click(first, title: "Keep editing")
        guard first.window?.isVisible == true, first.window?.tabbedWindows?.contains(where: { $0 === second.window }) == true,
              try await EditorSmoke.evaluate(first, script: "return document.querySelector('.cm-content').textContent.includes('UNSAVED_TAB_LIMIT 中文');", arguments: [:]) else { throw BridgeFailure(code: "PREFERENCE_TAB_DRAFT", message: "Cancelling the tab limit lost an existing editor or draft") }
        report["preferenceFileStep"] = "Explicitly discard the oldest tab"
        first.window?.performClose(nil)
        try await ContentSmoke.wait(first, "document.querySelector('dialog[open]') !== null", allowAlert: true)
        try await EditorSmoke.click(first, title: "Discard changes and continue")
        try await TerminalSmoke.wait("Close the explicitly discarded tab") { first.window?.isVisible == false }
        let third = try await openFile(root, "c.txt")
        try await ContentSmoke.wait(third, "document.querySelector('.cm-content')?.textContent.includes('c.txt') === true")
        guard first.window?.isVisible == false, second.window?.tabbedWindows?.count == 2,
              try String(contentsOf: root.appendingPathComponent("a.txt"), encoding: .utf8) == external else { throw BridgeFailure(code: "PREFERENCE_TAB_LIMIT", message: "Tab eviction changed the disk file or exceeded the directory limit") }
        await workspace.patchSettings(["fileTabLimit": .number(1)])
        report["preferenceFileStep"] = "Trim existing tabs after lowering the limit"
        try await TerminalSmoke.wait("Apply a lower saved limit to existing native tabs") { second.window?.isVisible == false && third.window?.isVisible == true }
        report["nativeFileTabLimitConflictRetainsDraftAndExplicitCloseAllowsRetry"] = true
        report["nativeLowerFileTabLimitAppliesToExistingTabs"] = true
        third.forceClose()
    }
}
