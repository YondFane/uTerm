import AppKit
import SwiftUI

@MainActor
struct NativeSidebar: NSViewRepresentable {
    @ObservedObject var model: WorkspaceModel

    struct Row: Equatable {
        let key: String
        let name: String
        let symbol: String?
        let projectID: String?
        let worktreeID: String?
        init(key: String, name: String, symbol: String?, projectID: String? = nil, worktreeID: String? = nil) {
            self.key = key; self.name = name; self.symbol = symbol
            self.projectID = projectID; self.worktreeID = worktreeID
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let table = NSTableView()
        table.identifier = NSUserInterfaceItemIdentifier("native-sidebar")
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = 28
        table.intercellSpacing = NSSize(width: 0, height: 2)
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.backgroundColor = .clear
        table.allowsEmptySelection = true
        table.autoresizingMask = [.width]
        table.delegate = context.coordinator
        table.dataSource = context.coordinator
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = context.coordinator
        table.menu = menu
        scroll.documentView = table
        context.coordinator.table = table
        context.coordinator.update(model)
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) { context.coordinator.update(model) }

    @MainActor
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate {
        weak var table: NSTableView?
        weak var model: WorkspaceModel?
        private var rows: [Row] = []
        private var updating = false
        private var request = 0
        private var pending = false

        func update(_ model: WorkspaceModel) {
            self.model = model
            guard let table else { return }
            var next = [Row(key: "projects", name: localized("Projects", "项目"), symbol: nil)]
            for project in model.projects {
                let id = project["id"].string ?? ""
                next.append(Row(key: "p:" + id, name: project["name"].string ?? "", symbol: "folder"))
                for tree in project["worktrees"].array {
                    let suffix = tree["missing"] == .bool(true) ? localized(" (missing)", "（缺失）") : ""
                    next.append(Row(key: "w:" + (tree["id"].string ?? ""), name: (tree["name"].string ?? "") + suffix, symbol: "arrow.triangle.branch", projectID: id, worktreeID: tree["id"].string))
                }
            }
            next += [Row(key: "sessions", name: localized("Sessions", "会话"), symbol: nil)]
                + model.sessionEntries.map { Row(key: "s:" + $0.sessionID, name: $0.session["name"].string ?? "", symbol: $0.session["agent"].string == nil ? "terminal" : "sparkle") }
            updating = true
            defer { updating = false }
            if next != rows { rows = next; table.reloadData() }
            guard !pending else { return }
            let selected = model.selectedID.map { "s:" + $0 } ?? model.workspace["selectedWorktree"].string.map { "w:" + $0 } ?? model.workspace["selectedProject"].string.map { "p:" + $0 }
            let index = rows.firstIndex { $0.key == selected }
            let selection = index.map { IndexSet(integer: $0) } ?? IndexSet()
            if table.selectedRowIndexes != selection { table.selectRowIndexes(selection, byExtendingSelection: false) }
        }

        func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
        func menuNeedsUpdate(_ menu: NSMenu) {
            menu.removeAllItems()
            guard let table else { return }
            populate(menu, row: table.clickedRow)
        }
        func populate(_ menu: NSMenu, row index: Int) {
            menu.autoenablesItems = false
            menu.removeAllItems()
            guard rows.indices.contains(index), let model else { return }
            let row = rows[index]
            guard row.key.hasPrefix("p:") || row.worktreeID != nil else { return }
            let item = NSMenuItem(title: localized("Refresh Worktrees", "刷新 Worktree"), action: #selector(refreshWorktrees(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = row.projectID ?? String(row.key.dropFirst(2))
            item.isEnabled = !model.busy && !model.worktreeDeletionPresented && !model.gitFavoritesRecoveryPresented
            menu.addItem(item)
            if let projectID = row.projectID, let worktreeID = row.worktreeID {
                let deletion = NSMenuItem(title: localized("Delete Worktree…", "删除 Worktree…"), action: #selector(deleteWorktree(_:)), keyEquivalent: "")
                deletion.target = self
                deletion.representedObject = ["project": projectID, "worktree": worktreeID]
                let sessions = model.projects.first(where: { $0["id"].string == projectID })?["sessions"].array ?? []
                deletion.isEnabled = !model.busy && !model.worktreeDeletionPresented && !model.gitFavoritesRecoveryPresented && !sessions.contains(where: { $0["worktreeId"].string == worktreeID })
                menu.addItem(deletion)
            }
        }
        @objc private func refreshWorktrees(_ item: NSMenuItem) {
            guard let id = item.representedObject as? String, let model else { return }
            Task { @MainActor in await model.refreshWorktrees(id) }
        }
        @objc private func deleteWorktree(_ item: NSMenuItem) {
            guard let target = item.representedObject as? [String: String], let project = target["project"], let tree = target["worktree"] else { return }
            model?.deleteWorktreeRequested?(project, tree)
        }
        func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
            model?.gitFavoritesRecoveryPresented != true && rows.indices.contains(row) && rows[row].symbol != nil
        }
        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            guard rows.indices.contains(row) else { return nil }
            let item = rows[row]
            let cell = NSTableCellView()
            let text = NSTextField(labelWithString: item.name)
            text.font = item.symbol == nil ? .boldSystemFont(ofSize: 11) : .systemFont(ofSize: 13)
            text.textColor = item.symbol == nil ? .secondaryLabelColor : .labelColor
            text.lineBreakMode = .byTruncatingMiddle
            text.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(text)
            cell.textField = text
            var leading: NSLayoutXAxisAnchor = cell.leadingAnchor
            var inset: CGFloat = 12
            if let symbol = item.symbol {
                let icon = NSImageView(image: NSImage(systemSymbolName: symbol, accessibilityDescription: nil) ?? NSImage())
                icon.contentTintColor = .controlAccentColor
                icon.translatesAutoresizingMaskIntoConstraints = false
                cell.addSubview(icon)
                cell.imageView = icon
                NSLayoutConstraint.activate([icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: item.worktreeID == nil ? 12 : 24), icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor), icon.widthAnchor.constraint(equalToConstant: 16), icon.heightAnchor.constraint(equalToConstant: 16)])
                leading = icon.trailingAnchor
                inset = 6
            }
            NSLayoutConstraint.activate([text.leadingAnchor.constraint(equalTo: leading, constant: inset), text.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -8), text.centerYAnchor.constraint(equalTo: cell.centerYAnchor)])
            cell.setAccessibilityLabel(item.name)
            return cell
        }
        func tableViewSelectionDidChange(_ notification: Notification) {
            guard !updating, let table, rows.indices.contains(table.selectedRow), let model else { return }
            let row = rows[table.selectedRow]
            guard row.symbol != nil else { return }
            request += 1
            let token = request
            let focus = NSApp.currentEvent?.type != .keyDown
            pending = true
            // Programmatic selection never invokes domain actions; user actions wait until AppKit returns.
            // 程序更新选中项不触发业务操作；用户操作等待 AppKit 回调返回后执行。
            DispatchQueue.main.async { [weak self, weak model] in
                guard let self, let model, self.request == token else { return }
                Task { @MainActor in
                    let id = String(row.key.dropFirst(2))
                    if row.key.hasPrefix("s:") { await model.selectSession(id, focus: focus) }
                    else if let project = row.projectID, let tree = row.worktreeID { await model.selectProject(project, worktree: tree, focus: focus) }
                    else { await model.selectProject(id, focus: focus) }
                    if self.request == token { self.pending = false; self.update(model) }
                }
            }
        }
    }
}
