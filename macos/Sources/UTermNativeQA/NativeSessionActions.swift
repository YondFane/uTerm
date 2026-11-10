import AppKit
import SwiftUI
import UTermBridge

@MainActor
extension WorkspaceModel {
    func orderedSessions(_ sessions: [JSONValue]) -> [JSONValue] {
        sessions.filter { $0["pinned"].bool == true } + sessions.filter { $0["pinned"].bool != true }
    }
    var orderedSessionEntries: [CoreSessionEntry] {
        sessionEntries.filter { $0.session["pinned"].bool == true } + sessionEntries.filter { $0.session["pinned"].bool != true }
    }
    func sessionOrderPeers(_ id: String) -> [CoreSessionEntry] {
        guard let entry = state?.sessions.first(where: { $0.sessionID == id }) else { return [] }
        return (state?.sessions ?? []).filter {
            $0.rosterId == entry.rosterId && $0.session["worktreeId"] == entry.session["worktreeId"]
                && ($0.session["pinned"].bool == true) == (entry.session["pinned"].bool == true)
        }
    }
    private func splitRoots(_ entry: CoreSessionEntry) -> [JSONValue] {
        if let project = entry.projectId {
            return workspace["projects"].array.first(where: { $0["id"].string == project })?["splitGroups"].array ?? []
        }
        guard let group = groups.first(where: { $0["id"].string == entry.workspaceId }) else { return [] }
        if let connection = entry.session["ssh"]["connection_id"].string {
            return group["sshConnections"].array.first(where: { $0["id"].string == connection })?["splitGroups"].array ?? []
        }
        return group[entry.session["agent"].string == nil ? "terminalSplits" : "chatSplits"].array
    }
    func sessionGroupLeaves(_ node: JSONValue) -> [String] {
        if node["kind"].string == "leaf" { return node["session"].string.map { [$0] } ?? [] }
        guard node["kind"].string == "split" else { return [] }
        return sessionGroupLeaves(node["first"]) + sessionGroupLeaves(node["second"])
    }
    func sessionGroupMembers(_ id: String) -> [String] {
        guard let entry = state?.sessions.first(where: { $0.sessionID == id }),
              let root = splitRoots(entry).first(where: { sessionGroupLeaves($0).contains(id) }) else { return [] }
        return sessionGroupLeaves(root)
    }
    func sessionGroupCandidates(_ id: String) -> [CoreSessionEntry] {
        guard let entry = state?.sessions.first(where: { $0.sessionID == id }) else { return [] }
        let grouped = Set(sessionGroupMembers(id))
        return (state?.sessions ?? []).filter {
            $0.sessionID != id && $0.rosterId == entry.rosterId
                && $0.session["worktreeId"] == entry.session["worktreeId"] && !grouped.contains($0.sessionID)
        }
    }
    func groupSession(_ id: String, with anchor: String, revision: String?) async {
        if await mutate("session.group", ["id": .string(id), "anchor": .string(anchor), "splitId": .string(UUID().uuidString)], revision: revision) {
            revealSelectedPane()
        }
    }
    func ungroupSession(_ id: String, revision: String?) async {
        if await mutate("session.ungroup", ["id": .string(id)], revision: revision) { revealSelectedPane() }
    }
    func moveSessionOrder(_ id: String, target: String, after: Bool, revision: String?) async {
        _ = await mutate("session.reorder", ["id": .string(id), "target": .string(target), "after": .bool(after)], revision: revision)
    }
    func copySessionLink(_ id: String) {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        guard let encoded = id.addingPercentEncoding(withAllowedCharacters: allowed) else { return }
        NSPasteboard.general.clearContents()
        if !NSPasteboard.general.setString("uterm://session/" + encoded, forType: .string) {
            error = localized("Could not copy the session link.", "无法复制会话链接。")
        }
    }
}

@MainActor
struct NativeSessionContextMenu: View {
    @ObservedObject var model: WorkspaceModel
    let id: String
    var body: some View {
        let revision = model.state?.snapshot.revision
        let peers = model.sessionOrderPeers(id)
        let index = peers.firstIndex(where: { $0.sessionID == id })
        let pinned = model.state?.sessions.first(where: { $0.sessionID == id })?.session["pinned"].bool == true
        Button(localized("Rename session", "重命名会话")) { model.renameSession(id) }
        Button(pinned ? localized("Unpin", "取消置顶") : localized("Pin", "置顶")) {
            Task { await model.mutate("session.pin", ["id": .string(id), "pinned": .bool(!pinned)], revision: revision) }
        }
        Button(localized("Move up", "上移")) {
            if let index, index > 0 { Task { await model.moveSessionOrder(id, target: peers[index - 1].sessionID, after: false, revision: revision) } }
        }.disabled(index.map { $0 == 0 } ?? true)
        Button(localized("Move down", "下移")) {
            if let index, index + 1 < peers.count { Task { await model.moveSessionOrder(id, target: peers[index + 1].sessionID, after: true, revision: revision) } }
        }.disabled(index.map { $0 + 1 >= peers.count } ?? true)
        if !model.sessionGroupMembers(id).isEmpty {
            Button(localized("Ungroup", "取消分组")) { Task { await model.ungroupSession(id, revision: revision) } }
        }
        ForEach(model.sessionGroupCandidates(id), id: \.sessionID) { peer in
            Button(localized("Group with ", "与以下会话分组：") + (peer.session["name"].string ?? "")) {
                Task { await model.groupSession(id, with: peer.sessionID, revision: revision) }
            }
        }
        Button(localized("Copy session link", "复制会话链接")) { model.copySessionLink(id) }
        Button(localized("Close session", "关闭会话")) { Task { await model.closeSession(id: id) } }
    }
}

@MainActor
final class NativeSessionMenuActions: NSObject {
    private weak var model: WorkspaceModel?
    private let id: String
    private let revision: String?
    init(model: WorkspaceModel, id: String) { self.model = model; self.id = id; revision = model.state?.snapshot.revision }
    func populate(_ menu: NSMenu) {
        guard let model else { return }
        let enabled = model.ready && !model.busy && !model.gitFavoritesRecoveryPresented && !model.worktreeDeletionPresented
        func item(_ title: String, _ action: Selector, value: String? = nil, available: Bool = true) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self; item.representedObject = value; item.isEnabled = enabled && available; menu.addItem(item)
        }
        let peers = model.sessionOrderPeers(id), index = peers.firstIndex(where: { $0.sessionID == id })
        let pinned = model.state?.sessions.first(where: { $0.sessionID == id })?.session["pinned"].bool == true
        item(localized("Rename session", "重命名会话"), #selector(rename))
        item(pinned ? localized("Unpin", "取消置顶") : localized("Pin", "置顶"), #selector(pin(_:)), value: pinned ? "false" : "true")
        item(localized("Move up", "上移"), #selector(up(_:)), value: index.flatMap { $0 > 0 ? peers[$0 - 1].sessionID : nil }, available: index.map { $0 > 0 } ?? false)
        item(localized("Move down", "下移"), #selector(down(_:)), value: index.flatMap { $0 + 1 < peers.count ? peers[$0 + 1].sessionID : nil }, available: index.map { $0 + 1 < peers.count } ?? false)
        if !model.sessionGroupMembers(id).isEmpty { item(localized("Ungroup", "取消分组"), #selector(ungroup)) }
        for peer in model.sessionGroupCandidates(id) {
            item(localized("Group with ", "与以下会话分组：") + (peer.session["name"].string ?? ""), #selector(group(_:)), value: peer.sessionID)
        }
        item(localized("Copy session link", "复制会话链接"), #selector(copyLink))
        item(localized("Close session", "关闭会话"), #selector(close))
    }
    @objc private func rename() { model?.renameSession(id) }
    @objc private func pin(_ item: NSMenuItem) {
        guard let model, let value = item.representedObject as? String else { return }
        Task { await model.mutate("session.pin", ["id": .string(id), "pinned": .bool(value == "true")], revision: revision) }
    }
    @objc private func up(_ item: NSMenuItem) {
        guard let model, let target = item.representedObject as? String else { return }
        Task { await model.moveSessionOrder(id, target: target, after: false, revision: revision) }
    }
    @objc private func down(_ item: NSMenuItem) {
        guard let model, let target = item.representedObject as? String else { return }
        Task { await model.moveSessionOrder(id, target: target, after: true, revision: revision) }
    }
    @objc private func group(_ item: NSMenuItem) {
        guard let model, let anchor = item.representedObject as? String else { return }
        Task { await model.groupSession(id, with: anchor, revision: revision) }
    }
    @objc private func ungroup() { guard let model else { return }; Task { await model.ungroupSession(id, revision: revision) } }
    @objc private func copyLink() { model?.copySessionLink(id) }
    @objc private func close() { guard let model else { return }; Task { await model.closeSession(id: id) } }
}
