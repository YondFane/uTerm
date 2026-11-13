import AppKit
import SwiftUI
import UTermBridge

@MainActor
private final class ResponsiveSidebarTable: NSTableView {
    override func setFrameSize(_ size: NSSize) {
        let changed = bounds.width != size.width
        super.setFrameSize(size)
        guard changed, size.width > 0 else { return }
        Task { @MainActor [weak self] in
            guard let self, self.bounds.width == size.width, self.numberOfRows > 0 else { return }
            self.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<self.numberOfRows))
        }
    }
}

@MainActor
private final class SidebarSessionCloseButton: NSButton {
    var sessionID = ""
    var hoverFill = NSColor.controlBackgroundColor
    var hoverBorder = NSColor.separatorColor
    var focusColor = NSColor.controlAccentColor
    var normalTint = NSColor.secondaryLabelColor
    var activeTint = NSColor.labelColor
    private var hovered = false
    private var hoverArea: NSTrackingArea?
    var rowHovered = false { didSet { if rowHovered != oldValue { updateVisibility() } } }
    override var acceptsFirstResponder: Bool { isEnabled }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        hoverArea = area; addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }
    func updateVisibility() {
        let visible = rowHovered || window?.firstResponder === self
        let alpha: CGFloat = visible ? 1 : 0
        if alphaValue != alpha { alphaValue = alpha }
    }
    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { alphaValue = 1; needsDisplay = true }
        return accepted
    }
    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        DispatchQueue.main.async { [weak self] in self?.updateVisibility() }
        return accepted
    }
    override func hitTest(_ point: NSPoint) -> NSView? {
        // Keep hidden actions in layout and keyboard navigation while pointer hits stay on the row.
        // 隐藏操作仍保留布局及键盘入口，鼠标命中则继续交给会话行。
        alphaValue > 0 ? super.hitTest(point) : nil
    }
    override func draw(_ dirtyRect: NSRect) {
        let focused = isEnabled && window?.firstResponder === self
        let active = isEnabled && (hovered || focused)
        let tint = active ? activeTint : normalTint
        if contentTintColor?.isEqual(tint) != true { contentTintColor = tint }
        let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 1, dy: 1))
        if active {
            hoverFill.setFill(); circle.fill()
            hoverBorder.setStroke(); circle.lineWidth = 1; circle.stroke()
        }
        super.draw(dirtyRect)
        if focused { focusColor.setStroke(); circle.lineWidth = 2; circle.stroke() }
    }
}

@MainActor
private final class SidebarRowView: NSTableRowView {
    var accent = NSColor.controlAccentColor
    var hover = NSColor.controlBackgroundColor
    var alpha: CGFloat = 22.0 / 255
    var padding: CGFloat = 1
    var selectable = true
    private var hovered = false
    private var hoverArea: NSTrackingArea?
    override var interiorBackgroundStyle: NSView.BackgroundStyle { .normal }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        hoverArea = area; addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; updateCloseButtons(); needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; updateCloseButtons(); needsDisplay = true }
    private func updateCloseButtons() {
        var queue = subviews
        while let view = queue.popLast() {
            if let close = view as? SidebarSessionCloseButton { close.rowHovered = hovered }
            else { queue += view.subviews }
        }
    }
    override func drawBackground(in dirtyRect: NSRect) {
        updateCloseButtons()
        guard selectable, hovered, !isSelected else { return }
        hover.setFill(); outline.fill()
    }
    private var outline: NSBezierPath {
        NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: padding + 0.5), xRadius: CGFloat(CoreChrome.sidebarRowCorner), yRadius: CGFloat(CoreChrome.sidebarRowCorner))
    }
    override func drawSelection(in dirtyRect: NSRect) {
        guard selectable else { return }
        let path = outline
        accent.withAlphaComponent(alpha).setFill(); path.fill()
        accent.withAlphaComponent(0.25).setStroke(); path.lineWidth = 1; path.stroke()
        accent.setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: padding + 8, width: 2, height: max(0, bounds.height - 2 * padding - 16)), xRadius: 1, yRadius: 1).fill()
    }
}

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
        let sectionID: String?
        let collapsed: Bool
        init(key: String, name: String, symbol: String?, projectID: String? = nil, worktreeID: String? = nil, depth: Int = 0, sectionID: String? = nil, collapsed: Bool = false) {
            self.key = key; self.name = name; self.symbol = symbol
            self.projectID = projectID; self.worktreeID = worktreeID; self.depth = depth
            self.sectionID = sectionID; self.collapsed = collapsed
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.autohidesScrollers = true; scroll.scrollerStyle = .overlay
        scroll.automaticallyAdjustsContentInsets = false
        let table = ResponsiveSidebarTable()
        table.identifier = NSUserInterfaceItemIdentifier("native-sidebar")
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
        table.addTableColumn(column)
        table.headerView = nil
        table.style = .plain
        table.rowHeight = CGFloat(CoreChrome.sidebarRowHeight)
        table.intercellSpacing = .zero
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
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate, NSSearchFieldDelegate {
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
        private let sshSearch = NSSearchField()

        func update(_ model: WorkspaceModel) {
            self.model = model
            guard let table else { return }
            let settings = model.settings
            let palette = NativePreferences.interfacePalette(settings, catalog: model.settingsCatalog)
            let signature = [settings["interfaceFont"].string ?? "", String(settings["interfaceSize"].number ?? 13), String(settings["rowPadding"].number ?? 1), settings["interfaceTheme"].string ?? "", String(NativePreferences.light(settings)), settings["activeIconColor"].string ?? ""]
            table.rowHeight = max(CGFloat(CoreChrome.sidebarRowHeight), CGFloat(settings["interfaceSize"].number ?? 13) + 19) + CGFloat(settings["rowPadding"].number ?? 1) * 2
            table.backgroundColor = NativePreferences.color(palette["sidebar"], fallback: .windowBackgroundColor)
            let section = model.sidebarSection
            let query = model.sidebarQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            var next: [Row] = []
            func sessionRow(_ session: JSONValue, depth: Int) -> Row {
                let id = session["id"].string ?? ""
                let activity = model.terminals[id]?.activityLabel ?? ""
                let name = (session["name"].string ?? "") + (activity.isEmpty ? "" : " · " + activity)
                return Row(key: "s:" + id, name: name, symbol: session["pinned"].bool == true ? "pin.fill" : session["agent"].string == nil ? "terminal" : "sparkle", projectID: model.sessionEntries.first(where: { $0.sessionID == id })?.projectId, depth: depth)
            }
            func worktreeRows(_ tree: JSONValue, project: JSONValue, depth: Int) -> [Row] {
                let id = project["id"].string ?? ""
                let suffix = tree["missing"] == .bool(true) ? localized(" (missing)", "（缺失）") : ""
                var rows = [Row(key: "w:" + (tree["id"].string ?? ""), name: (tree["name"].string ?? "") + suffix, symbol: "arrow.triangle.branch", projectID: id, worktreeID: tree["id"].string, depth: depth)]
                rows += model.orderedSessions(project["sessions"].array.filter { $0["worktreeId"] == tree["id"] }).map { sessionRow($0, depth: depth + 1) }
                return rows
            }
            func projectRows(_ project: JSONValue) -> [Row] {
                let id = project["id"].string ?? ""
                let collapsed = project["collapsed"].bool == true
                var rows = [Row(key: "p:" + id, name: project["name"].string ?? "", symbol: project["pinned"].bool == true ? "pin.fill" : "folder", projectID: id, collapsed: collapsed)]
                if collapsed { return rows }
                rows += model.orderedSessions(project["sessions"].array.filter { $0["worktreeId"].string == nil }).map { sessionRow($0, depth: 1) }
                for tree in project["worktrees"].array where !project["sessions"].array.isEmpty || project["pinned"].bool == true || tree["pinned"].bool != true {
                    rows += worktreeRows(tree, project: project, depth: 1)
                }
                return rows
            }
            func appendSection(_ id: String, _ title: String, rows: [Row]) {
                let collapsed = model.sidebarCollapsed.contains(id)
                next.append(Row(key: "section:" + id, name: title, symbol: nil, sectionID: id, collapsed: collapsed))
                if !collapsed { next += rows }
            }
            let showProjects = section == "all" || section == "projects"
            let active = model.projects.filter { !$0["sessions"].array.isEmpty }
            let inactive = model.projects.filter { $0["sessions"].array.isEmpty }
            let loose = model.orderedSessionEntries.filter { $0.projectId == nil && $0.session["ssh"] == .null }
            if showProjects {
                if !active.isEmpty { appendSection("active", localized("Active", "活动"), rows: active.flatMap(projectRows)) }
                var pinned = inactive.filter { $0["pinned"].bool == true }.flatMap(projectRows)
                for project in inactive where project["pinned"].bool != true {
                    for tree in project["worktrees"].array where tree["pinned"].bool == true { pinned += worktreeRows(tree, project: project, depth: 0) }
                }
                pinned += loose.filter { $0.session["pinned"].bool == true }.map { sessionRow($0.session, depth: 0) }
                if !pinned.isEmpty { appendSection("pinned", localized("Pinned", "已固定"), rows: pinned) }
            }
            let group = model.groups.first { $0["id"].string == model.groupID } ?? .null
            if (section == "all" || section == "ssh") && settings["showSshConnections"].bool != false {
                var connections: [Row] = [Row(key: "ssh-quick", name: localized("Quick SSH connection", "快速 SSH 连接"), symbol: nil), Row(key: "ssh-filter", name: model.sidebarQuery, symbol: nil)]
                for connection in group["sshConnections"].array {
                    if !query.isEmpty && !["name", "host", "username"].compactMap({ connection[$0].string }).contains(where: { $0.lowercased().contains(query) }) { continue }
                    let temporary = connection["temporary"].bool == true ? localized(" · Temporary", " · 临时") : ""
                    connections.append(Row(key: "q:" + (connection["id"].string ?? ""), name: (connection["name"].string ?? "SSH") + temporary, symbol: "network"))
                    connections += model.orderedSessions(connection["sessions"].array).map { sessionRow($0, depth: 1) }
                }
                appendSection("ssh", "SSH", rows: connections)
            }
            if (section == "all" || section == "redis") && settings["showRedisConnections"].bool != false {
                appendSection("redis", "Redis", rows: group["redisConnections"].array.compactMap { profile in
                    profile["id"].string.map { Row(key: "r:" + $0, name: profile["name"].string ?? "Redis", symbol: "cylinder") }
                })
            }
            if (section == "all" || section == "database") && settings["showDatabaseConnections"].bool != false {
                appendSection("database", localized("Databases", "数据库"), rows: group["databaseConnections"].array.compactMap { profile in
                    profile["id"].string.map { Row(key: "d:" + $0, name: profile["name"].string ?? localized("Database", "数据库"), symbol: "externaldrive") }
                })
            }
            if showProjects {
                let terminals = loose.filter { $0.session["pinned"].bool != true && $0.session["agent"].string == nil }
                let chats = loose.filter { $0.session["pinned"].bool != true && $0.session["agent"].string != nil }
                if !terminals.isEmpty { appendSection("terminals", localized("Terminals", "终端"), rows: terminals.map { sessionRow($0.session, depth: 0) }) }
                if !chats.isEmpty { appendSection("chats", localized("Chats", "聊天"), rows: chats.map { sessionRow($0.session, depth: 0) }) }
                appendSection("projects", localized("Projects", "项目"), rows: inactive.filter { $0["pinned"].bool != true }.flatMap(projectRows))
            }
            if section == "sessions" {
                next = model.orderedSessionEntries.map { sessionRow($0.session, depth: 0) }
            }
            updating = true
            defer { updating = false }
            if next != rows || preferenceSignature != signature {
                let editor = sshSearch.currentEditor()
                let ownsQuery = editor != nil && table.window?.firstResponder === editor
                let range = editor?.selectedRange
                if sshSearch.stringValue != model.sidebarQuery {
                    sshSearch.stringValue = model.sidebarQuery
                    if ownsQuery, let editor {
                        editor.string = model.sidebarQuery
                        if let range {
                            let length = (model.sidebarQuery as NSString).length
                            let start = min(range.location, length)
                            editor.selectedRange = NSRange(location: start, length: min(range.length, length - start))
                        }
                    }
                }
                let previous = rows
                let preserveSearch = ownsQuery && preferenceSignature == signature && next.contains(where: { $0.key == "ssh-filter" })
                rows = next; preferenceSignature = signature
                if preserveSearch {
                    // Keep the search cell attached while filtering host rows; detaching ends native editing.
                    // 筛选主机行时保留搜索单元格的挂载，移除控件会结束原生输入。
                    let difference = next.map(\.key).difference(from: previous.map(\.key))
                    var removed = IndexSet(), inserted = IndexSet()
                    for change in difference {
                        switch change {
                        case .remove(let offset, _, _): removed.insert(offset)
                        case .insert(let offset, _, _): inserted.insert(offset)
                        }
                    }
                    table.beginUpdates()
                    table.removeRows(at: removed, withAnimation: [])
                    table.insertRows(at: inserted, withAnimation: [])
                    table.endUpdates()
                    let changed = IndexSet(next.indices.filter { index in
                        let row = next[index]
                        return row.key != "ssh-filter" && !inserted.contains(index) && previous.first(where: { $0.key == row.key }) != row
                    })
                    table.reloadData(forRowIndexes: changed, columnIndexes: IndexSet(integer: 0))
                    if let quick = rows.firstIndex(where: { $0.key == "ssh-quick" }), changed.contains(quick) { table.noteHeightOfRows(withIndexesChanged: IndexSet(integer: quick)) }
                } else { table.reloadData() }
                // Reloading filtered rows must retain only an already-focused search editor.
                // 重载筛选行时，仅恢复原本已获得焦点的搜索编辑器。
                if ownsQuery, !preserveSearch, let index = rows.firstIndex(where: { $0.key == "ssh-filter" }) {
                    _ = table.view(atColumn: 0, row: index, makeIfNecessary: true)
                    table.layoutSubtreeIfNeeded()
                    if table.window?.makeFirstResponder(sshSearch) == true, let range { sshSearch.currentEditor()?.selectedRange = range }
                }
            }
            for index in rows.indices {
                guard let cell = table.view(atColumn: 0, row: index, makeIfNecessary: false) else { continue }
                for disclosure in cell.subviews.compactMap({ $0 as? NSButton }) {
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
        func measuredGeometry(in root: NSView) -> [String: Double]? {
            guard let table, let first = rows.firstIndex(where: { $0.sectionID != nil }),
                  let later = rows.indices.first(where: { $0 > first && rows[$0].sectionID != nil }),
                  let regular = rows.firstIndex(where: { $0.sectionID == nil }) else { return nil }
            let frame = table.convert(table.rect(ofRow: first), to: root)
            let top = root.isFlipped ? frame.minY - root.bounds.minY : root.bounds.maxY - frame.maxY
            let section = table.rect(ofRow: first).height
            let regularHeight = table.rect(ofRow: regular).height - CGFloat(model?.settings["rowPadding"].number ?? 1) * 2
            return ["sidebarRowHeight": Double(regularHeight), "sidebarSectionHeight": Double(section), "sidebarSectionGap": Double(table.rect(ofRow: later).height - section), "sidebarListTop": Double(top) - CoreChrome.titlebarHeight]
        }
        func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
            guard rows.indices.contains(row) else { return tableView.rowHeight }
            if rows[row].key == "ssh-filter" { return 50 }
            if rows[row].key == "ssh-quick" {
                let width = max(1, (tableView.tableColumns.first?.width ?? tableView.bounds.width) - 16)
                let title = quickSSHTitle(rows[row].name, settings: model?.settings ?? .null)
                let height = title.boundingRect(with: NSSize(width: width, height: CGFloat.greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading]).height
                return max(28, ceil(height)) + 4
            }
            guard rows[row].sectionID != nil else { return tableView.rowHeight }
            return CGFloat(CoreChrome.sidebarSectionHeight + (row == 0 ? 0 : CoreChrome.sidebarSectionGap))
        }
        private func quickSSHTitle(_ name: String, settings: JSONValue) -> NSAttributedString {
            let font = NativePreferences.semiboldFont(settings["interfaceFont"].string ?? "", size: CGFloat(settings["interfaceSize"].number ?? 13))
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center; paragraph.lineBreakMode = .byWordWrapping
            paragraph.minimumLineHeight = max(18, font.pointSize * 1.4); paragraph.maximumLineHeight = paragraph.minimumLineHeight
            let palette = NativePreferences.interfacePalette(settings, catalog: model?.settingsCatalog ?? .null)
            return NSAttributedString(string: name, attributes: [.font: font, .paragraphStyle: paragraph, .foregroundColor: NativePreferences.color(palette["text"], fallback: .labelColor)])
        }
        func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
            let view = SidebarRowView()
            let settings = model?.settings ?? .null
            let palette = NativePreferences.interfacePalette(settings, catalog: model?.settingsCatalog ?? .null)
            view.accent = NativePreferences.color(palette["accent"], fallback: .controlAccentColor)
            view.hover = NativePreferences.color(palette["hover"], fallback: .controlBackgroundColor)
            view.alpha = NativePreferences.light(settings) ? 18.0 / 255 : 22.0 / 255
            view.padding = CGFloat(settings["rowPadding"].number ?? 1)
            view.selectable = rows.indices.contains(row) && rows[row].sectionID == nil
            return view
        }
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
        func finishDrag() { dragSession = nil; dragProject = nil; dragRevision = nil }
        func tableView(_ tableView: NSTableView, draggingSession session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) { finishDrag() }
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
            if row.key.hasPrefix("q:") {
                let id = String(row.key.dropFirst(2))
                let profile = model.groups.flatMap { $0["sshConnections"].array }.first { $0["id"].string == id }
                if profile?["temporary"].bool == true {
                    let keep = NSMenuItem(title: localized("Save connection", "保存为常用连接"), action: #selector(keepQuickSSH(_:)), keyEquivalent: "")
                    keep.target = self; keep.representedObject = id; keep.isEnabled = !model.busy
                    menu.addItem(keep)
                }
                return
            }
            guard row.key.hasPrefix("p:") || row.worktreeID != nil else { return }
            if row.key.hasPrefix("p:"), let project = model.projects.first(where: { $0["id"].string == String(row.key.dropFirst(2)) }) {
                let id = project["id"].string ?? ""
                let enabled = !model.busy && !model.gitFavoritesRecoveryPresented && !model.worktreeDeletionPresented
                let revision = model.state?.snapshot.revision ?? ""
                @MainActor func action(_ title: String, _ selector: Selector, _ target: Any, enabled available: Bool = true) {
                    let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
                    var captured = target
                    if var values = target as? [String: String] { values["revision"] = revision; captured = values }
                    item.target = self; item.representedObject = captured; item.isEnabled = enabled && available; menu.addItem(item)
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
                    item.target = self; item.representedObject = ["id": id, "workspaceId": group.id, "revision": revision]; item.isEnabled = enabled
                    targets.addItem(item)
                }
                move.submenu = targets; move.isEnabled = enabled && !targets.items.isEmpty; menu.addItem(move)
                action(localized("Remove project", "移除项目"), #selector(removeProject(_:)), ["id": id], enabled: project["sessions"].array.isEmpty)
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
            guard let params = item.representedObject as? [String: String], let id = params["id"], let key = params["key"], let revision = params["revision"], !revision.isEmpty, let model,
                  let project = model.projects.first(where: { $0["id"].string == id }) else { return }
            Task { await model.setProjectFlag(id, key: key, value: project[key].bool != true, revision: revision) }
        }
        final class SectionButton: NSButton { var sectionID = "" }
        @objc private func closeSidebarSession(_ sender: SidebarSessionCloseButton) {
            guard let model, !model.busy, !model.workspaceModalPresented,
                  model.sessionEntries.contains(where: { $0.sessionID == sender.sessionID }) else { return }
            let id = sender.sessionID
            Task { await model.closeSession(id: id) }
        }
        @objc private func quickSSH(_ sender: NSButton) { model?.openQuickSSHRequested?() }
        @objc private func keepQuickSSH(_ sender: NSMenuItem) {
            guard let id = sender.representedObject as? String else { return }
            Task { await model?.keepQuickSSH(id) }
        }
        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSSearchField, field === sshSearch else { return }
            model?.sidebarQuery = sshSearch.stringValue
        }
        @objc private func toggleSection(_ button: SectionButton) {
            guard let model else { return }
            if !model.sidebarCollapsed.insert(button.sectionID).inserted { model.sidebarCollapsed.remove(button.sectionID) }
        }
        @objc private func addInSection(_ button: SectionButton) {
            guard let model else { return }
            switch button.sectionID {
            case "projects": model.openProject()
            case "ssh": model.openSSHRequested?(nil)
            case "redis": model.openRedisRequested?()
            case "database": model.openDatabasesRequested?()
            default: break
            }
        }
        final class DisclosureButton: NSButton {
            var projectID = ""
            var expanded = true
            var folder: NSImage?
            private var hoverArea: NSTrackingArea?
            override func updateTrackingAreas() {
                super.updateTrackingAreas()
                if let hoverArea { removeTrackingArea(hoverArea) }
                let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
                hoverArea = area; addTrackingArea(area)
            }
            override func mouseEntered(with event: NSEvent) { image = NativeChromeImages.sidebarChevron(expanded: expanded) }
            override func mouseExited(with event: NSEvent) { image = folder }
        }
        @objc private func toggleDisclosure(_ button: DisclosureButton) {
            guard let model, let project = model.projects.first(where: { $0["id"].string == button.projectID }) else { return }
            Task { await model.setProjectFlag(button.projectID, key: "collapsed", value: project["collapsed"].bool != true) }
        }
        @objc private func reorderProject(_ item: NSMenuItem) {
            guard let params = item.representedObject as? [String: String], let id = params["id"], let revision = params["revision"], !revision.isEmpty, let model else { return }
            let peers = model.projectOrderPeers(id)
            guard let index = peers.firstIndex(of: id) else { return }
            if params["direction"] == "up", index > 0 { Task { await model.moveProjectOrder(id, before: peers[index - 1], revision: revision) } }
            else if params["direction"] == "down", index + 1 < peers.count { Task { await model.moveProjectOrder(id, before: index + 2 < peers.count ? peers[index + 2] : nil, revision: revision) } }
        }
        @objc private func moveProject(_ item: NSMenuItem) {
            guard let params = item.representedObject as? [String: String], let id = params["id"], let workspace = params["workspaceId"], let revision = params["revision"], !revision.isEmpty, let model else { return }
            Task { await model.mutate("project.move", ["id": .string(id), "workspaceId": .string(workspace)], revision: revision) }
        }
        @objc private func removeProject(_ item: NSMenuItem) {
            guard let params = item.representedObject as? [String: String], let id = params["id"], let revision = params["revision"], !revision.isEmpty, let model else { return }
            Task { await model.mutate("project.remove", ["id": .string(id)], revision: revision) }
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
            let settings = model?.settings ?? .null
            let palette = NativePreferences.interfacePalette(settings, catalog: model?.settingsCatalog ?? .null)
            if item.key == "ssh-quick" || item.key == "ssh-filter" {
                let control: NSView
                if item.key == "ssh-quick" {
                    let button = NSButton(title: item.name, target: self, action: #selector(quickSSH(_:)))
                    button.isBordered = false; button.alignment = .center
                    button.cell?.wraps = true; button.cell?.usesSingleLineMode = false; button.cell?.lineBreakMode = .byWordWrapping
                    button.contentTintColor = NativePreferences.color(palette["text"], fallback: .labelColor)
                    button.identifier = NSUserInterfaceItemIdentifier("native-ssh-quick")
                    button.font = NativePreferences.semiboldFont(settings["interfaceFont"].string ?? "", size: CGFloat(settings["interfaceSize"].number ?? 13))
                    button.attributedTitle = quickSSHTitle(item.name, settings: settings)
                    button.isEnabled = model?.busy == false
                    control = button
                } else {
                    sshSearch.removeFromSuperview()
                    sshSearch.delegate = self
                    (sshSearch.cell as? NSSearchFieldCell)?.searchButtonCell = nil
                    sshSearch.identifier = NSUserInterfaceItemIdentifier("native-sidebar-filter")
                    sshSearch.placeholderString = localized("Search SSH hosts", "搜索 SSH 主机")
                    sshSearch.setAccessibilityLabel(sshSearch.placeholderString)
                    sshSearch.sendsSearchStringImmediately = true
                    sshSearch.stringValue = model?.sidebarQuery ?? ""
                    sshSearch.font = NativePreferences.font(settings["interfaceFont"].string ?? "", size: CGFloat(settings["interfaceSize"].number ?? 13))
                    control = sshSearch
                }
                control.translatesAutoresizingMaskIntoConstraints = false; cell.addSubview(control)
                NSLayoutConstraint.activate([control.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 8), control.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -8), control.topAnchor.constraint(equalTo: cell.topAnchor, constant: item.key == "ssh-filter" ? 6 : 4), control.bottomAnchor.constraint(equalTo: cell.bottomAnchor, constant: item.key == "ssh-filter" ? -8 : 0)])
                return cell
            }
            if let section = item.sectionID {
                let toggle = SectionButton(title: item.name, target: self, action: #selector(toggleSection(_:)))
                toggle.sectionID = section; toggle.isBordered = false; toggle.alignment = .left
                toggle.font = NativePreferences.semiboldFont(settings["interfaceFont"].string ?? "", size: 11)
                toggle.contentTintColor = NativePreferences.color(palette["text"], fallback: .labelColor)
                toggle.image = NativeChromeImages.sidebarChevron(expanded: !item.collapsed)
                toggle.imagePosition = .imageTrailing; toggle.imageScaling = .scaleProportionallyDown
                toggle.identifier = NSUserInterfaceItemIdentifier("native-sidebar-section-" + section)
                toggle.setAccessibilityLabel(item.name); toggle.setAccessibilityExpanded(!item.collapsed)
                toggle.translatesAutoresizingMaskIntoConstraints = false; cell.addSubview(toggle)
                NSLayoutConstraint.activate([toggle.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4), toggle.centerYAnchor.constraint(equalTo: cell.bottomAnchor, constant: -CGFloat(CoreChrome.sidebarSectionHeight) / 2), toggle.heightAnchor.constraint(equalToConstant: 24)])
                if ["projects", "ssh", "redis", "database"].contains(section) {
                    let add = SectionButton(title: "", target: self, action: #selector(addInSection(_:)))
                    add.sectionID = section; add.isBordered = false; add.contentTintColor = NativePreferences.color(palette["muted"], fallback: .secondaryLabelColor); add.image = NativeChromeImages.sidebar(.plus)
                    add.imageScaling = .scaleProportionallyDown
                    add.identifier = NSUserInterfaceItemIdentifier("native-sidebar-add-" + section)
                    add.setAccessibilityLabel(localized("Add ", "添加") + item.name)
                    add.translatesAutoresizingMaskIntoConstraints = false; cell.addSubview(add)
                    NSLayoutConstraint.activate([add.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -2), add.centerYAnchor.constraint(equalTo: toggle.centerYAnchor), add.widthAnchor.constraint(equalToConstant: 20), add.heightAnchor.constraint(equalToConstant: 24), toggle.trailingAnchor.constraint(lessThanOrEqualTo: add.leadingAnchor, constant: -4)])
                } else { toggle.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -4).isActive = true }
                return cell
            }
            let text = NSTextField(labelWithString: item.name)
            text.font = NativePreferences.semiboldFont(settings["interfaceFont"].string ?? "", size: CGFloat(settings["interfaceSize"].number ?? 13))
            text.textColor = NativePreferences.color(palette[item.symbol == nil ? "muted" : "text"], fallback: item.symbol == nil ? .secondaryLabelColor : .labelColor)
            text.lineBreakMode = .byTruncatingTail
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
                    disclosure.expanded = !collapsed
                    disclosure.folder = NativeChromeImages.sidebar(collapsed ? .folderClosed : .folder)
                    disclosure.image = disclosure.folder; disclosure.contentTintColor = icon.contentTintColor
                    disclosure.imageScaling = .scaleProportionallyDown
                    icon.isHidden = true
                    disclosure.isBordered = false; disclosure.isEnabled = model?.busy == false && model?.gitFavoritesRecoveryPresented == false
                    disclosure.setAccessibilityLabel(collapsed ? localized("Expand project", "展开项目") : localized("Collapse project", "折叠项目"))
                    disclosure.identifier = NSUserInterfaceItemIdentifier("native-project-disclosure-" + id)
                    disclosure.translatesAutoresizingMaskIntoConstraints = false; cell.addSubview(disclosure)
                    NSLayoutConstraint.activate([disclosure.leadingAnchor.constraint(equalTo: icon.leadingAnchor), disclosure.centerYAnchor.constraint(equalTo: cell.centerYAnchor), disclosure.widthAnchor.constraint(equalToConstant: CGFloat(CoreChrome.sidebarIconSize)), disclosure.heightAnchor.constraint(equalToConstant: 22)])
                }
                NSLayoutConstraint.activate([icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 5 + CGFloat(item.depth) * 16 + (item.key.hasPrefix("s:") ? 3.5 : 0)), icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor), icon.widthAnchor.constraint(equalToConstant: CGFloat(CoreChrome.sidebarIconSize)), icon.heightAnchor.constraint(equalToConstant: CGFloat(CoreChrome.sidebarIconSize))])
                leading = icon.trailingAnchor
                inset = 7
            }
            var trailing = cell.trailingAnchor
            var trailingInset: CGFloat = -8
            if item.key.hasPrefix("s:") {
                let id = String(item.key.dropFirst(2))
                let close = SidebarSessionCloseButton(title: "", target: self, action: #selector(closeSidebarSession(_:)))
                close.sessionID = id; close.isBordered = false; close.imagePosition = .imageOnly
                if let image = NativeChromeImages.toolbar(.close).copy() as? NSImage {
                    image.size = NSSize(width: 13, height: 13); close.image = image
                }
                close.contentTintColor = NativePreferences.color(palette["muted"], fallback: .secondaryLabelColor)
                let textColor = NativePreferences.color(palette["text"], fallback: .labelColor)
                close.normalTint = NativePreferences.color(palette["muted"], fallback: .secondaryLabelColor)
                close.activeTint = textColor
                close.hoverFill = NativePreferences.color(palette["hover"], fallback: .controlBackgroundColor).blended(withFraction: 0.28, of: textColor) ?? .controlBackgroundColor
                close.hoverBorder = NativePreferences.color(palette["border"], fallback: .separatorColor).blended(withFraction: 0.2, of: textColor) ?? .separatorColor
                close.focusColor = NativePreferences.color(palette["accent"], fallback: .controlAccentColor)
                close.focusRingType = .none
                close.alphaValue = 0
                close.isEnabled = model?.busy == false && model?.gitFavoritesRecoveryPresented == false && model?.workspaceModalPresented == false
                close.identifier = NSUserInterfaceItemIdentifier("native-sidebar-close-" + id)
                close.toolTip = localized("Close Session", "关闭会话")
                close.setAccessibilityLabel(localized("Close Session: ", "关闭会话：") + item.name)
                close.translatesAutoresizingMaskIntoConstraints = false; cell.addSubview(close)
                NSLayoutConstraint.activate([close.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -5), close.centerYAnchor.constraint(equalTo: cell.centerYAnchor), close.widthAnchor.constraint(equalToConstant: 22), close.heightAnchor.constraint(equalToConstant: 22)])
                trailing = close.leadingAnchor; trailingInset = -4
            }
            NSLayoutConstraint.activate([text.leadingAnchor.constraint(equalTo: leading, constant: inset), text.trailingAnchor.constraint(equalTo: trailing, constant: trailingInset), text.centerYAnchor.constraint(equalTo: cell.centerYAnchor)])
            cell.setAccessibilityLabel(item.name)
            return cell
        }
        func tableViewSelectionDidChange(_ notification: Notification) {
            guard !updating, let table, rows.indices.contains(table.selectedRow), let model else { return }
            let row = rows[table.selectedRow]
            guard row.symbol != nil else { return }
            request += 1
            let token = request
            let group = model.groupID
            let focus = NSApp.currentEvent?.type != .keyDown
            pending = true
            // Programmatic selection never invokes domain actions; user actions wait until AppKit returns.
            // 程序更新选中项不触发业务操作；用户操作等待 AppKit 回调返回后执行。
            DispatchQueue.main.async { [weak self, weak model] in
                guard let self, let model, self.request == token else { return }
                Task { @MainActor in
                    let id = String(row.key.dropFirst(2))
                    if row.key.hasPrefix("d:") { if model.groupID == group { model.openDatabaseProfileRequested?(group, id) } }
                    else if row.key.hasPrefix("r:") { if model.groupID == group { model.openRedisProfileRequested?(group, id) } }
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
