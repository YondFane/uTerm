import AppKit
import UTermBridge

@MainActor
final class RecoveryPreviewPanel: NSObject {
    let alert = NSAlert()
    let choices = NSPopUpButton(frame: NSRect(x: 0, y: 240, width: 460, height: 28), pullsDown: false)
    private let preview = NSTextView(frame: NSRect(x: 0, y: 0, width: 440, height: 220))
    var changed: ((Int) -> Void)?
    private let readyButtonIndex: Int

    init(title: String, message: String, choices titles: [String], buttons: [String], readyButtonIndex: Int = 0, cancelButtonIndex: Int = 1, identifierPrefix: String = "editor-recovery") {
        self.readyButtonIndex = readyButtonIndex
        super.init()
        alert.messageText = title
        alert.informativeText = message
        for (index, title) in buttons.enumerated() {
            let button = alert.addButton(withTitle: title)
            button.identifier = NSUserInterfaceItemIdentifier("\(identifierPrefix)-button-\(index)")
            if index == cancelButtonIndex { button.keyEquivalent = "\u{1b}" }
        }
        choices.addItems(withTitles: titles)
        choices.identifier = NSUserInterfaceItemIdentifier("\(identifierPrefix)-choice")
        choices.target = self
        choices.action = #selector(select)
        preview.isEditable = false
        preview.isSelectable = true
        preview.isRichText = false
        preview.isVerticallyResizable = true
        preview.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        preview.textContainer?.widthTracksTextView = true
        preview.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        preview.autoresizingMask = [.width]
        preview.identifier = NSUserInterfaceItemIdentifier("\(identifierPrefix)-preview")
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 460, height: 230))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.documentView = preview
        let accessory = NSView(frame: NSRect(x: 0, y: 0, width: 460, height: 274))
        accessory.addSubview(choices)
        accessory.addSubview(scroll)
        alert.accessoryView = accessory
    }

    @objc private func select() { changed?(choices.indexOfSelectedItem) }
    func show(_ text: String, ready: Bool) {
        preview.string = text
        alert.buttons[readyButtonIndex].isEnabled = ready
    }
    func present(for window: NSWindow) async -> NSApplication.ModalResponse {
        await withCheckedContinuation { continuation in
            alert.beginSheetModal(for: window) { continuation.resume(returning: $0) }
        }
    }
}

@MainActor
enum EditorRecovery {
    private static func description(_ drafts: [CoreEditorDraft]) -> String {
        if drafts.isEmpty { return localized("This copy contains no editor drafts.", "此副本没有编辑器草稿。") }
        return drafts.map { draft in
            draft.directory + "/" + draft.path + "\n" + String(draft.text.prefix(1200))
        }.joined(separator: "\n\n")
    }

    static func chooseDraft(bridge: CoreBridge, window: NSWindow) async throws -> CoreEditorDraft? {
        let collection: CoreEditorDraftCollection
        do { collection = try await bridge.editorDrafts() }
        catch let error as BridgeFailure where error.code == "DRAFTS_NOT_IMPORTED" {
            throw BridgeFailure(code: "NO_DRAFTS", message: localized("There are no retained editor drafts.", "没有保留的编辑器草稿。"))
        }
        let drafts = collection.drafts.map(\.draft)
        guard !drafts.isEmpty else { throw BridgeFailure(code: "NO_DRAFTS", message: localized("There are no retained editor drafts.", "没有保留的编辑器草稿。")) }
        let panel = RecoveryPreviewPanel(
            title: localized("Recover editor drafts", "恢复编辑器草稿"),
            message: localized("Open loads the latest retained draft. Copy text copies this preview's complete text without changing files or recovery data.", "打开会读取最新保留草稿。复制文本会复制此预览的完整文本，不修改文件或恢复数据。"),
            choices: drafts.map { $0.path + " — " + $0.directory },
            buttons: [localized("Open", "打开"), localized("Cancel", "取消"), localized("Copy text", "复制文本")])
        panel.changed = { index in panel.show(description([drafts[index]]), ready: true) }
        panel.show(description([drafts[0]]), ready: true)
        let response = await panel.present(for: window)
        panel.changed = nil
        let draft = drafts[panel.choices.indexOfSelectedItem]
        if response == .alertThirdButtonReturn {
            NSPasteboard.general.clearContents()
            guard NSPasteboard.general.setString(draft.text, forType: .string) else {
                throw BridgeFailure(code: "COPY_FAILED", message: localized("Could not copy the draft text.", "无法复制草稿文本。"))
            }
            return nil
        }
        guard response == .alertFirstButtonReturn else { return nil }
        let directory = URL(fileURLWithPath: draft.directory).standardizedFileURL.resolvingSymlinksInPath()
        guard draft.directory.hasPrefix("/"), directory.path == draft.directory else {
            throw BridgeFailure(code: "DRAFT_LOCATION", message: localized("This draft's project location is not available as the same local path. Use Copy text to retain its contents.", "此草稿的项目位置无法以相同本地路径访问，请使用复制文本保留内容。"))
        }
        return draft
    }

    static func restoreCopy(bridge: CoreBridge, window: NSWindow) async throws {
        let catalog = try await bridge.editorRecoveryCatalog()
        guard !catalog.backups.isEmpty else { throw BridgeFailure(code: "NO_BACKUPS", message: localized("There are no verified editor recovery copies.", "没有校验通过的编辑器恢复副本。")) }
        let panel = RecoveryPreviewPanel(
            title: localized("Restore editor recovery copy", "恢复编辑器备份副本"),
            message: localized("Choose and preview a saved copy. Restore replaces recovery data, keeps damaged bytes and leaves files unchanged. Open editors keep their text; reopen files to load restored drafts.", "选择并预览已保存副本。恢复会替换恢复数据、保留损坏字节，不修改文件。已打开的编辑器保留当前文本，重新打开文件后读取恢复草稿。"),
            choices: catalog.backups,
            buttons: [localized("Restore copy", "恢复副本"), localized("Cancel", "取消")])
        var epoch = 0
        var task: Task<Void, Never>?
        var previewRevision: String?
        panel.changed = { index in
            epoch += 1
            let selectedEpoch = epoch
            let revision = catalog.backups[index]
            task?.cancel()
            previewRevision = nil
            panel.show(localized("Loading preview…", "正在加载预览…"), ready: false)
            task = Task { @MainActor in
                do {
                    let snapshot = try await bridge.editorRecoveryPreview(revision: revision)
                    guard !Task.isCancelled, epoch == selectedEpoch else { return }
                    previewRevision = snapshot.revision
                    panel.show(description(snapshot.document.drafts), ready: true)
                } catch {
                    guard !Task.isCancelled, epoch == selectedEpoch else { return }
                    panel.show(error.localizedDescription, ready: false)
                }
            }
        }
        panel.changed?(0)
        let response = await panel.present(for: window)
        epoch += 1
        task?.cancel()
        panel.changed = nil
        guard response == .alertFirstButtonReturn, let revision = previewRevision,
              revision == catalog.backups[panel.choices.indexOfSelectedItem] else { return }
        if let expected = catalog.currentRevision {
            _ = try await bridge.call("editor.drafts.recovery.restore", params: .object([
                "expectedRevision": .string(expected), "revision": .string(revision)
            ]))
        } else {
            _ = try await bridge.call("editor.drafts.recovery.restoreMissing", params: .object([
                "expectedMissing": .bool(true), "revision": .string(revision)
            ]))
        }
    }
}
