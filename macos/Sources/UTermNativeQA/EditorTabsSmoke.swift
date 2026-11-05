import AppKit
import UTermBridge

@MainActor
enum EditorTabsSmoke {
    private static let names = ["first-中文.txt", "second-中文.txt"]
    private static let originals = ["FIRST_DISK 中文\n", "SECOND_DISK 中文\n"]
    private static let edits = ["FIRST_TAB_UNSAVED 中文 😀\n", "SECOND_TAB_UNSAVED 中文 é\n"]
    private static func draft(_ bridge: CoreBridge, root: URL, path: String) async throws -> JSONValue {
        try await bridge.call("editor.drafts.document", params: .object(["directory": .string(root.path), "path": .string(path)]))
    }
    private static func capture(_ window: NSWindow, path: String, name: String, captures: inout [String]) async throws {
        window.makeKeyAndOrderFront(nil)
        try await Task.sleep(for: .milliseconds(200))
        try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name))
        captures.append(name)
    }
    static func run(model: WorkspaceModel, phase: String, open: (URL, String) async throws -> ContentWindow,
                    reportPath: String, captures: inout [String], report: inout [String: Any]) async throws {
        guard let bridge = model.bridge else { throw BridgeFailure(code: "EDITOR_TABS", message: "Missing real editor bridge") }
        let base = try WorkspaceModel.dataRoot().deletingLastPathComponent()
        let root = base.appendingPathComponent("editor-tabs 中文")
        if phase == "checkpoint" {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            for index in names.indices {
                try Data(originals[index].utf8).write(to: root.appendingPathComponent(names[index]))
                let disk = try await bridge.call("files.read", params: .object(["directory": .string(root.path), "path": .string(names[index])]))
                _ = try await bridge.call("editor.drafts.putDocument", params: .object([
                    "expectedDraftRevision": .null, "draft": .object([
                        "directory": .string(root.path), "path": .string(names[index]), "kind": .string("text"),
                        "text": .string("RECOVERED_TAB_SEED\n"), "saved": disk["text"], "version": disk["version"],
                        "line_ending": disk["line_ending"], "bom": disk["bom"]
                    ])
                ]))
            }
        }
        let first = try await open(root, names[0])
        try await ContentSmoke.wait(first, "document.querySelector('.cm-content[contenteditable=true]') !== null")
        if phase == "checkpoint" { try await EditorSmoke.replace(first, text: edits[0]) }
        let second = try await open(root, names[1])
        defer { if phase != "checkpoint" { first.forceClose(); second.forceClose() } }
        try await ContentSmoke.wait(second, "document.querySelector('.cm-content[contenteditable=true]') !== null")
        if phase == "checkpoint" { try await EditorSmoke.replace(second, text: edits[1]) }
        guard let firstWindow = first.window, let secondWindow = second.window else {
            throw BridgeFailure(code: "EDITOR_TABS", message: "Missing actual file windows")
        }
        try await TerminalSmoke.wait("Append files in one native project tab group") {
            firstWindow.tabbedWindows?.count == 2 && firstWindow.tabGroup === secondWindow.tabGroup
        }
        report["nativeFileTabTitles"] = firstWindow.tabbedWindows?.map(\.title) ?? []
        guard [firstWindow, secondWindow].allSatisfy({ $0.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }) else {
            throw BridgeFailure(code: "EDITOR_TABS_APPEARANCE", message: "Native tab chrome did not inherit the configured dark appearance")
        }
        report["nativeFileTabsMatchConfiguredAppearance"] = true
        guard firstWindow.tabbedWindows?.map(\.title) == names else {
            throw BridgeFailure(code: "EDITOR_TABS_ORDER", message: "Native file tabs did not retain opening order")
        }
        let reused = try await open(root, names[0])
        guard reused === first, firstWindow.tabGroup?.selectedWindow === firstWindow,
              firstWindow.tabbedWindows?.map(\.title) == names else {
            throw BridgeFailure(code: "EDITOR_TABS_REUSE", message: "Reopening a file duplicated or reordered its native tab")
        }
        try await ContentSmoke.wait(first, "document.querySelector('.cm-content')?.textContent.includes('FIRST_TAB_UNSAVED') === true")
        second.reveal()
        try await ContentSmoke.wait(second, "document.querySelector('.cm-content')?.textContent.includes('SECOND_TAB_UNSAVED') === true")
        for index in names.indices {
            var stored = try await draft(bridge, root: root, path: names[index])
            let deadline = Date().addingTimeInterval(10)
            while stored["draft"]["text"].string != edits[index], Date() < deadline {
                try await Task.sleep(for: .milliseconds(50))
                stored = try await draft(bridge, root: root, path: names[index])
            }
            guard stored["draft"]["text"].string == edits[index],
                  try Data(contentsOf: root.appendingPathComponent(names[index])) == Data(originals[index].utf8) else {
                throw BridgeFailure(code: "EDITOR_TABS_BYTES", message: "Tab switching lost the exact draft or changed original bytes")
            }
        }
        report["nativeFileTabsGroupedAndOrdered"] = true
        report["nativeFileTabReopenSelectedExisting"] = true
        report["nativeFileTabSwitchRetainedExactDrafts"] = true
        report["nativeFileTabInput"] = "Actual AppKit tab group selection and DOM input in isolated WK editors; no manual keyboard/IME claim"
        report["nativeFileTabLayoutRestore"] = "Files explicitly reopened; persisted tab order/window geometry remain unimplemented"
        try await capture(secondWindow, path: reportPath, name: "native-editor-tabs-\(phase).png", captures: &captures)
        if phase == "checkpoint" { return }
        report["nativeFileTabDraftsSurvivedForcedExit"] = true
        let otherRoot = base.appendingPathComponent("other-editor-project")
        try FileManager.default.createDirectory(at: otherRoot, withIntermediateDirectories: true)
        try Data("OTHER_PROJECT\n".utf8).write(to: otherRoot.appendingPathComponent(names[0]))
        let other = try await open(otherRoot, names[0])
        let preview = try ContentWindow(bridge: bridge, directory: root, path: names[0])
        defer { other.forceClose(); preview.forceClose() }
        preview.reveal()
        guard let otherWindow = other.window, let previewWindow = preview.window,
              otherWindow.tabGroup !== firstWindow.tabGroup, previewWindow.tabGroup !== firstWindow.tabGroup,
              previewWindow.tabbingMode == .disallowed, firstWindow.tabbedWindows?.count == 2 else {
            throw BridgeFailure(code: "EDITOR_TABS_SCOPE", message: "Other project or read-only preview joined the editable file group")
        }
        report["nativeFileTabsExcludeOtherProjectsAndPreviews"] = true
        let external = Data("EXTERNAL_FIRST_TAB 中文\n".utf8)
        try external.write(to: root.appendingPathComponent(names[0]))
        first.reveal()
        firstWindow.performClose(nil)
        try await ContentSmoke.wait(first, "document.querySelector('dialog[open]') !== null", allowAlert: true)
        try await EditorSmoke.click(first, title: "Keep editing")
        guard firstWindow.tabbedWindows?.count == 2, firstWindow.tabGroup?.selectedWindow === firstWindow,
              try Data(contentsOf: root.appendingPathComponent(names[0])) == external,
              (try await draft(bridge, root: root, path: names[0]))["draft"]["text"].string == edits[0],
              (try await draft(bridge, root: root, path: names[1]))["draft"]["text"].string == edits[1] else {
            throw BridgeFailure(code: "EDITOR_TABS_CONFLICT", message: "Cancelled tab close lost a draft, tab or external writer")
        }
        report["nativeFileTabConflictCancelRetainedBothDrafts"] = true
        firstWindow.setContentSize(NSSize(width: 640, height: 600))
        try await capture(firstWindow, path: reportPath, name: "native-editor-tabs-conflict-640.png", captures: &captures)
        firstWindow.performClose(nil)
        try await ContentSmoke.wait(first, "document.querySelector('dialog[open]') !== null", allowAlert: true)
        try await EditorSmoke.click(first, title: "Discard changes and continue")
        try await TerminalSmoke.wait("Close only the reviewed dirty file tab") { !firstWindow.isVisible }
        second.reveal()
        guard (try await draft(bridge, root: root, path: names[0])) == .null,
              secondWindow.tabbedWindows?.contains(where: { $0 === firstWindow }) != true,
              (try await draft(bridge, root: root, path: names[1]))["draft"]["text"].string == edits[1],
              try Data(contentsOf: root.appendingPathComponent(names[0])) == external else {
            throw BridgeFailure(code: "EDITOR_TABS_CLOSE", message: "Discarding one tab affected another document or external bytes")
        }
        try await EditorSmoke.click(second, title: "Save")
        try await ContentSmoke.wait(second, "document.querySelector('.editor-save-state')?.textContent.includes('Saved') === true")
        guard try Data(contentsOf: root.appendingPathComponent(names[1])) == Data(edits[1].utf8),
              (try await draft(bridge, root: root, path: names[1])) == .null else {
            throw BridgeFailure(code: "EDITOR_TABS_SAVE", message: "Remaining tab did not save and acknowledge its own exact bytes")
        }
        report["nativeFileTabClosePreservedSiblingAndExternalFile"] = true
    }
}
