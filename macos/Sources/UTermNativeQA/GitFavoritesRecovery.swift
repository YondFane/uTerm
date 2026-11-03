import AppKit
import UTermBridge

@MainActor
enum GitFavoritesRecovery {
    private struct Choice {
        let revision: String
        let source: Bool
        var title: String { localized(source ? "Original source · " : "Favorite snapshot · ", source ? "原始来源 · " : "收藏副本 · ") + String(revision.prefix(12)) }
    }
    static func message(_ error: Error) -> String {
        guard let error = error as? BridgeFailure else { return error.localizedDescription }
        switch error.code {
        case "CONFLICT": return localized("Favorites changed after preview. Reload recovery copies before restoring.", "收藏在预览后发生变化，请重新读取恢复副本。")
        case "CORRUPT_STORE", "CORRUPT_FAVORITES": return localized("Recovery data failed verification. Original data was retained.", "恢复数据校验失败，原始数据已保留。")
        case "IO": return localized("Recovery could not finish. Reload the current state before retrying.", "无法完成恢复，请重新读取当前状态后重试。")
        default: return error.localizedDescription
        }
    }
    private static func description(_ snapshot: CoreGitFavoriteRecoverySnapshot) -> String {
        let text = snapshot.document.repositories.keys.sorted().map { repository in
            let references = snapshot.document.repositories[repository]!.references
            return repository + "\n" + (references.isEmpty ? localized("No favorites", "没有收藏") : references.map { "  " + $0 }.joined(separator: "\n"))
        }.joined(separator: "\n\n")
        return text.isEmpty ? localized("No favorites", "没有收藏") : text
    }
    static func present(bridge: CoreBridge, window: NSWindow) async throws -> Bool {
        let catalog = try await bridge.gitFavoriteRecoveryCatalog()
        let choices = catalog.backups.map { Choice(revision: $0, source: false) } + catalog.sources.map { Choice(revision: $0, source: true) }
        guard !choices.isEmpty else { throw BridgeFailure(code: "NO_BACKUPS", message: localized("There are no verified favorite recovery copies or original sources.", "没有校验通过的收藏恢复副本或原始来源。")) }
        let panel = RecoveryPreviewPanel(
            title: localized("Recover Git favorites", "恢复 Git 收藏"),
            message: localized("Restore replaces favorites for all repositories and retains damaged bytes and the previous snapshot. Original sources can be copied; they do not directly replace favorites.", "恢复会替换所有仓库的收藏，并保留损坏字节及恢复前副本。原始来源可以复制，不会直接替换收藏。"),
            choices: choices.map(\.title),
            buttons: [localized("Cancel", "取消"), localized("Restore all favorites", "恢复所有仓库收藏"), localized("Copy full preview", "复制完整预览")],
            readyButtonIndex: 1, cancelButtonIndex: 0, identifierPrefix: "git-favorite-recovery")
        panel.alert.buttons[1].hasDestructiveAction = true
        panel.alert.window.defaultButtonCell = panel.alert.buttons[0].cell as? NSButtonCell
        panel.alert.buttons[1].keyEquivalent = ""
        var epoch = 0
        var task: Task<Void, Never>?
        var selected: Choice?
        var fullText: String?
        panel.changed = { index in
            epoch += 1
            let current = epoch
            task?.cancel()
            selected = nil
            fullText = nil
            panel.show(localized("Loading favorite recovery data…", "正在读取收藏恢复数据…"), ready: false)
            panel.alert.buttons[2].isEnabled = false
            guard choices.indices.contains(index) else { return }
            let choice = choices[index]
            task = Task { @MainActor in
                do {
                    let text: String
                    if choice.source {
                        let value = try await bridge.call("git.favorites.recovery.source", params: .object(["revision": .string(choice.revision)]))
                        guard let source = value.string else { throw BridgeFailure(code: "INVALID_REPLY", message: localized("Invalid favorite recovery source.", "收藏恢复来源无效。")) }
                        text = source
                    } else {
                        let snapshot = try await bridge.gitFavoriteRecoveryPreview(revision: choice.revision)
                        guard snapshot.revision == choice.revision else { throw BridgeFailure(code: "INVALID_REPLY", message: localized("Invalid favorite recovery preview.", "收藏恢复预览无效。")) }
                        text = description(snapshot)
                    }
                    guard !Task.isCancelled, epoch == current else { return }
                    selected = choice
                    fullText = text
                    let suffix = text.count > 20000 ? "\n\n" + localized("Preview is truncated. Copy retains the full contents.", "预览已截断，复制会保留全部内容。") : ""
                    panel.show(String(text.prefix(20000)) + suffix, ready: !choice.source)
                    panel.alert.buttons[2].isEnabled = true
                } catch {
                    guard !Task.isCancelled, epoch == current else { return }
                    panel.show(message(error), ready: false)
                }
            }
        }
        panel.changed?(0)
        let response = await panel.present(for: window)
        epoch += 1
        task?.cancel()
        panel.changed = nil
        if response == .alertThirdButtonReturn, let fullText {
            NSPasteboard.general.clearContents()
            guard NSPasteboard.general.setString(fullText, forType: .string) else { throw BridgeFailure(code: "COPY_FAILED", message: localized("Could not copy the full preview.", "无法复制完整预览。")) }
            return false
        }
        guard response == .alertSecondButtonReturn, let selected, !selected.source else { return false }
        _ = try await bridge.call("git.favorites.recovery.restore", params: .object([
            "revision": .string(selected.revision), "expectedRevision": catalog.currentRevision.map(JSONValue.string) ?? .null,
            "expectedMissing": .bool(catalog.currentRevision == nil)
        ]))
        return true
    }
}
