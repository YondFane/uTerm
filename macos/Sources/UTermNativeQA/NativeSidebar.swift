import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct NativeSidebar: NSViewRepresentable {
    @ObservedObject var model: WorkspaceModel

    struct Row: Equatable {
        let key: String
        let name: String
        let symbol: String?
        let projectID: String?
        let worktreeID: String?
        let depth: Int
        init(key: String, name: String, symbol: String?, projectID: String? = nil, worktreeID: String? = nil, depth: Int = 0) {
            self.key = key; self.name = name; self.symbol = symbol
            self.projectID = projectID; self.worktreeID = worktreeID; self.depth = depth
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
        table.registerForDraggedTypes([Coordinator.projectDragType, Coordinator.sessionDragType])
        table.setDraggingSourceOperationMask(.move, forLocal: true)
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
        private var preferenceSignature: [String] = []
        private var updating = false
        private var request = 0
        private var pending = false
        static let projectDragType = NSPasteboard.PasteboardType("sh.uterm.native.project")
        private var dragRevision: String?
        private var dragProject: String?
        static let sessionDragType = NSPasteboard.PasteboardType("sh.uterm.native.session")
        private var dragSession: String?
        private var sessionMenuActions: NativeSessionMenuActions?

        func update(_ model: WorkspaceModel) {
            self.model = model
            guard let table else { return }
            let settings = model.settings
            let palette = NativePreferences.interfacePalette(settings, catalog: model.settingsCatalog)
            let signature = [settings["interfaceFont"].string ?? "", String(settings["interfaceSize"].number ?? 13), String(settings["rowPadding"].number ?? 1), settings["interfaceTheme"].string ?? "", String(NativePreferences.light(settings)), settings["activeIconColor"].string ?? ""]
            table.rowHeight = 26 + CGFloat(settings["rowPadding"].number ?? 1) * 2
            table.backgroundColor = NativePreferences.color(palette["sidebar"], fallback: .windowBackgroundColor)
            let section = model.sidebarSection
            let query = section == "ssh" ? model.sidebarQuery.trimmingCharacters(in: .whitespacesAndNewlines) : ""
            var next: [Row] = []
            if settings["showDatabaseConnections"].bool != false { next.append(Row(key: "db", name: localized("Databases", "数据库"), symbol: "externaldrive")) }
            if settings["showRedisConnections"].bool != false { next.append(Row(key: "redis", name: localized("Redis connections", "Redis 连接"), symbol: "cylinder")) }
            func sessionRow(_ session: JSONValue, depth: Int) -> Row {
                let id = session["id"].string ?? ""
                let activity = model.terminals[id]?.activityLabel ?? ""
                let name = (session["name"].string ?? "") + (activity.isEmpty ? "" : " · " + activity)
                return Row(key: "s:" + id, name: name, symbol: session["pinned"].bool == true ? "pin.fill" : session["agent"].string == nil ? "terminal" : "sparkle", projectID: model.sessionEntries.first(where: { $0.sessionID == id })?.projectId, depth: depth)
            }
            next.append(Row(key: "projects", name: localized("Projects", "项目"), symbol: nil))
            for project in model.projects {
                let id = project["id"].string ?? ""
                next.append(Row(key: "p:" + id, name: project["name"].string ?? "", symbol: project["pinned"].bool == true ? "pin.fill" : "folder", projectID: id))
                if project["collapsed"].bool == true && query.isEmpty { continue }
                next += model.orderedSessions(project["sessions"].array.filter { $0["worktreeId"].string == nil }).map { sessionRow($0, depth: 1) }
                for tree in project["worktrees"].array {
                    let suffix = tree["missing"] == .bool(true) ? localized(" (missing)", "（缺失）") : ""
                    next.append(Row(key: "w:" + (tree["id"].string ?? ""), name: (tree["name"].string ?? "") + suffix, symbol: "arrow.triangle.branch", projectID: id, worktreeID: tree["id"].string, depth: 1))
                    next += model.orderedSessions(project["sessions"].array.filter { $0["worktreeId"] == tree["id"] }).map { sessionRow($0, depth: 2) }
                }
            }
            let connections = model.groups.first { $0["id"].string == model.groupID }?["sshConnections"].array ?? []
            if !connections.isEmpty && settings["showSshConnections"].bool != false {
                next.append(Row(key: "ssh", name: localized("SSH connections", "SSH 连接"), symbol: nil))
                for connection in connections {
                    next.append(Row(key: "q:" + (connection["id"].string ?? ""), name: connection["name"].string ?? "SSH", symbol: "network"))
                    next += model.orderedSessions(connection["sessions"].array).map { sessionRow($0, depth: 1) }
                }
            }
            next += [Row(key: "sessions", name: localized("Sessions", "会话"), symbol: nil)]
                + model.orderedSessionEntries.filter { $0.projectId == nil && $0.session["ssh"] == .null }.map { sessionRow($0.session, depth: 0) }
            next = next.filter { row in
                let matchesSection = section == "all"
                    || (section == "projects" && (row.key == "projects" || row.projectID != nil))
                    || (section == "sessions" && (row.key == "sessions" || row.key.hasPrefix("s:")))
                    || (section == "ssh" && (row.key == "ssh" || row.key.hasPrefix("q:") || (row.key.hasPrefix("s:") && model.sessionEntries.contains { "s:" + $0.sessionID == row.key && $0.session["ssh"] != .null })))
                    || (section == "redis" && row.key == "redis")
                    || (section == "database" && row.key == "db")
                return matchesSection && (query.isEmpty || row.name.localizedCaseInsensitiveContains(query))
            }
            if section == "sessions" {
                next = [Row(key: "sessions", name: localized("Sessions", "会话"), symbol: nil)] + model.orderedSessionEntries.filter {
                    query.isEmpty || ($0.session["name"].string ?? "").localizedCaseInsensitiveContains(query)
                }.map { sessionRow($0.session, depth: 0) }
            }
            updating = true
            defer { updating = false }
            if next != rows || preferenceSignature != signature { rows = next; preferenceSignature = signature; table.reloadData() }
            for index in rows.indices {
                guard let cell = table.view(atColumn: 0, row: index, makeIfNecessary: false) else { continue }
                for disclosure in cell.subviews.compactMap({ $0 as? DisclosureButton }) {
                    disclosure.isEnabled = !model.busy && !model.gitFavoritesRecoveryPresented && !model.worktreeDeletionPresented
                }
            }
            guard !pending else { return }
            let selected = model.selectedID.map { "s:" + $0 } ?? model.workspace["selectedWorktree"].string.map { "w:" + $0 } ?? model.workspace["selectedProject"].string.map { "p:" + $0 }
            let index = rows.firstIndex { $0.key == selected }
            let selection = index.map { IndexSet(integer: $0) } ?? IndexSet()
            if table.selectedRowIndexes != selection { table.selectRowIndexes(selection, byExtendingSelection: false) }
        }

        func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
        func tableView(_ tableView: NSTableView, pasteboardWriterForRow row: Int) -> NSPasteboardWriting? {
            guard rows.indices.contains(row), let model, !model.busy,
                  !model.gitFavoritesRecoveryPresented, !model.worktreeDeletionPresented else { return nil }
            if rows[row].key.hasPrefix("s:") {
                let id = String(rows[row].key.dropFirst(2))
                dragSession = id; dragProject = nil; dragRevision = model.state?.snapshot.revision
                let item = NSPasteboardItem(); item.setString(id, forType: Self.sessionDragType)
                return item
            }
            guard rows[row].key.hasPrefix("p:"), model.settings["projectOrder"].string != "name" else { return nil }
            let id = String(rows[row].key.dropFirst(2))
            dragProject = id; dragSession = nil; dragRevision = model.state?.snapshot.revision
            let item = NSPasteboardItem(); item.setString(id, forType: Self.projectDragType)
            return item
        }
        func tableView(_ tableView: NSTableView, validateDrop info: NSDraggingInfo, proposedRow row: Int, proposedDropOperation operation: NSTableView.DropOperation) -> NSDragOperation {
            if let id = info.draggingPasteboard.string(forType: Self.sessionDragType) {
                guard info.draggingSource as? NSTableView === tableView, let model, !model.busy,
                      !model.gitFavoritesRecoveryPresented, !model.worktreeDeletionPresented,
                      id == dragSession, dragRevision != nil, rows.indices.contains(row), rows[row].key.hasPrefix("s:") else { return [] }
                let target = String(rows[row].key.dropFirst(2))
                guard target != id, model.sessionOrderPeers(id).contains(where: { $0.sessionID == target }) else { return [] }
                tableView.setDropRow(row, dropOperation: .above)
                return .move
            }
            guard info.draggingSource as? NSTableView === tableView, let model, !model.busy,
                  !model.gitFavoritesRecoveryPresented, let id = info.draggingPasteboard.string(forType: Self.projectDragType),
                  id == dragProject, dragRevision != nil, row >= 0 && row <= rows.count else { return [] }
            let peers = model.projectOrderPeers(id)
            guard peers.contains(id) else { return [] }
            if row < rows.count {
                guard rows[row].key.hasPrefix("p:"), peers.contains(String(rows[row].key.dropFirst(2))) else { return [] }
            }
            tableView.setDropRow(row, dropOperation: .above)
            return .move
        }
        func tableView(_ tableView: NSTableView, acceptDrop info: NSDraggingInfo, row: Int, dropOperation: NSTableView.DropOperation) -> Bool {
            if let id = info.draggingPasteboard.string(forType: Self.sessionDragType) {
                guard self.tableView(tableView, validateDrop: info, proposedRow: row, proposedDropOperation: dropOperation) == .move,
                      let model, let revision = dragRevision else { return false }
                let target = String(rows[row].key.dropFirst(2))
                Task { await model.moveSessionOrder(id, target: target, after: false, revision: revision) }
                dragSession = nil; dragRevision = nil
                return true
            }
            guard self.tableView(tableView, validateDrop: info, proposedRow: row, proposedDropOperation: dropOperation) == .move,
                  let model, let id = dragProject, let revision = dragRevision else { return false }
            let target = row < rows.count ? String(rows[row].key.dropFirst(2)) : nil
            guard target != id else { return false }
            Task { await model.moveProjectOrder(id, before: target, revision: revision) }
            dragProject = nil; dragRevision = nil
            return true
        }
        func tableView(_ tableView: NSTableView, draggingSession session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
            dragSession = nil; dragProject = nil; dragRevision = nil
        }
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
            if row.key.hasPrefix("s:") {
                let id = String(row.key.dropFirst(2))
                let actions = NativeSessionMenuActions(model: model, id: id)
                sessionMenuActions = actions; actions.populate(menu)
                return
            }
            guard row.key.hasPrefix("p:") || row.worktreeID != nil else { return }
            if row.key.hasPrefix("p:"), let project = model.projects.first(where: { $0["id"].string == String(row.key.dropFirst(2)) }) {
                let id = project["id"].string ?? ""
                let enabled = !model.busy && !model.gitFavoritesRecoveryPresented && !model.worktreeDeletionPresented
                func action(_ title: String, _ selector: Selector, _ target: Any, enabled available: Bool = true) {
                    let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
                    item.target = self; item.representedObject = target; item.isEnabled = enabled && available; menu.addItem(item)
                }
                action(localized("Rename project…", "重命名项目…"), #selector(renameProject(_:)), id)
                action(project["pinned"].bool == true ? localized("Unpin project", "取消置顶项目") : localized("Pin project", "置顶项目"), #selector(toggleProjectFlag(_:)), ["id": id, "key": "pinned"])
                action(project["collapsed"].bool == true ? localized("Expand project", "展开项目") : localized("Collapse project", "折叠项目"), #selector(toggleProjectFlag(_:)), ["id": id, "key": "collapsed"])
                let peers = model.projectOrderPeers(id)
                let index = peers.firstIndex(of: id)
                action(localized("Move up", "上移"), #selector(reorderProject(_:)), ["id": id, "direction": "up"], enabled: index.map { $0 > 0 } ?? false)
                action(localized("Move down", "下移"), #selector(reorderProject(_:)), ["id": id, "direction": "down"], enabled: index.map { $0 + 1 < peers.count } ?? false)
                let move = NSMenuItem(title: localized("Move to workspace", "移动到工作区"), action: nil, keyEquivalent: "")
                let targets = NSMenu()
                for group in model.groupItems where group.id != model.groupID {
                    let item = NSMenuItem(title: group.name, action: #selector(moveProject(_:)), keyEquivalent: "")
                    item.target = self; item.representedObject = ["id": id, "workspaceId": group.id]; item.isEnabled = enabled
                    targets.addItem(item)
                }
                move.submenu = targets; move.isEnabled = enabled && !targets.items.isEmpty; menu.addItem(move)
                action(localized("Remove project", "移除项目"), #selector(removeProject(_:)), id, enabled: project["sessions"].array.isEmpty)
                menu.addItem(.separator())
            }
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
        @objc private func renameProject(_ item: NSMenuItem) {
            guard let id = item.representedObject as? String else { return }
            model?.renameProject(id)
        }
        @objc private func toggleProjectFlag(_ item: NSMenuItem) {
            guard let params = item.representedObject as? [String: String], let id = params["id"], let key = params["key"], let model,
                  let project = model.projects.first(where: { $0["id"].string == id }) else { return }
            Task { await model.setProjectFlag(id, key: key, value: project[key].bool != true) }
        }
        final class DisclosureButton: NSButton { var projectID = "" }
        @objc private func toggleDisclosure(_ button: DisclosureButton) {
            guard let model, let project = model.projects.first(where: { $0["id"].string == button.projectID }) else { return }
            Task { await model.setProjectFlag(button.projectID, key: "collapsed", value: project["collapsed"].bool != true) }
        }
        @objc private func reorderProject(_ item: NSMenuItem) {
            guard let params = item.representedObject as? [String: String], let id = params["id"], let model else { return }
            let peers = model.projectOrderPeers(id)
            guard let index = peers.firstIndex(of: id) else { return }
            if params["direction"] == "up", index > 0 { Task { await model.moveProjectOrder(id, before: peers[index - 1]) } }
            else if params["direction"] == "down", index + 1 < peers.count { Task { await model.moveProjectOrder(id, before: index + 2 < peers.count ? peers[index + 2] : nil) } }
        }
        @objc private func moveProject(_ item: NSMenuItem) {
            guard let params = item.representedObject as? [String: String], let id = params["id"], let workspace = params["workspaceId"], let model else { return }
            Task { await model.mutate("project.move", ["id": .string(id), "workspaceId": .string(workspace)]) }
        }
        @objc private func removeProject(_ item: NSMenuItem) {
            guard let id = item.representedObject as? String, let model else { return }
            Task { await model.mutate("project.remove", ["id": .string(id)]) }
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
            cell.identifier = NSUserInterfaceItemIdentifier("native-sidebar-row-" + item.key)
            let text = NSTextField(labelWithString: item.name)
            let settings = model?.settings ?? .null
            let palette = NativePreferences.interfacePalette(settings, catalog: model?.settingsCatalog ?? .null)
            text.font = NativePreferences.font(settings["interfaceFont"].string ?? "", size: CGFloat(settings["interfaceSize"].number ?? 13) - (item.symbol == nil ? 2 : 0), bold: item.symbol == nil)
            text.textColor = NativePreferences.color(palette[item.symbol == nil ? "muted" : "text"], fallback: item.symbol == nil ? .secondaryLabelColor : .labelColor)
            text.lineBreakMode = .byTruncatingMiddle
            text.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(text)
            cell.textField = text
            var leading: NSLayoutXAxisAnchor = cell.leadingAnchor
            var inset: CGFloat = 12
            if let symbol = item.symbol {
                let shared: [String: CoreSidebarIcon] = ["folder": .folder, "terminal": .terminal, "arrow.triangle.branch": .branch, "network": .terminal, "externaldrive": .sqlDatabase, "cylinder": .database]
                let image = shared[symbol].map { NativeChromeImages.sidebar($0) } ?? NSImage(systemSymbolName: symbol, accessibilityDescription: nil) ?? NSImage()
                let icon = NSImageView(image: image)
                icon.contentTintColor = NativePreferences.color(settings["activeIconColor"], fallback: NativePreferences.color(palette["accent"], fallback: .controlAccentColor))
                icon.translatesAutoresizingMaskIntoConstraints = false
                cell.addSubview(icon)
                cell.imageView = icon
                if item.key.hasPrefix("p:"), let id = item.projectID {
                    let collapsed = model?.projects.first(where: { $0["id"].string == id })?["collapsed"].bool == true
                    let disclosure = DisclosureButton()
                    disclosure.projectID = id; disclosure.target = self; disclosure.action = #selector(toggleDisclosure(_:))
                    disclosure.image = NSImage(systemSymbolName: collapsed ? "chevron.right" : "chevron.down", accessibilityDescription: nil)
                    disclosure.isBordered = false; disclosure.isEnabled = model?.busy == false && model?.gitFavoritesRecoveryPresented == false
                    disclosure.setAccessibilityLabel(collapsed ? localized("Expand project", "展开项目") : localized("Collapse project", "折叠项目"))
                    disclosure.identifier = NSUserInterfaceItemIdentifier("native-project-disclosure-" + id)
                    disclosure.translatesAutoresizingMaskIntoConstraints = false; cell.addSubview(disclosure)
                    NSLayoutConstraint.activate([disclosure.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2), disclosure.centerYAnchor.constraint(equalTo: cell.centerYAnchor), disclosure.widthAnchor.constraint(equalToConstant: 14), disclosure.heightAnchor.constraint(equalToConstant: 20)])
                }
                NSLayoutConstraint.activate([icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 20 + CGFloat(item.depth) * 16), icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor), icon.widthAnchor.constraint(equalToConstant: CGFloat(CoreChrome.sidebarIconSize)), icon.heightAnchor.constraint(equalToConstant: CGFloat(CoreChrome.sidebarIconSize))])
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
                    if row.key == "db" { model.openDatabasesRequested?() }
                    else if row.key == "redis" { model.openRedisRequested?() }
                    else if row.key.hasPrefix("q:") { model.openSSHRequested?(id) }
                    else if row.key.hasPrefix("s:") { await model.selectSession(id, focus: focus) }
                    else if let project = row.projectID, let tree = row.worktreeID { await model.selectProject(project, worktree: tree, focus: focus) }
                    else { await model.selectProject(id, focus: focus) }
                    if self.request == token { self.pending = false; self.update(model) }
                }
            }
        }
    }
}
