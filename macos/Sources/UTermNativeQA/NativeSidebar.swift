import AppKit
import SwiftUI

@MainActor
struct NativeSidebar: NSViewRepresentable {
    @ObservedObject var model: WorkspaceModel

    struct Row: Equatable {
        let key: String
        let name: String
        let symbol: String?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let table = NSTableView()
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
        scroll.documentView = table
        context.coordinator.table = table
        context.coordinator.update(model)
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) { context.coordinator.update(model) }

    @MainActor
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        weak var table: NSTableView?
        weak var model: WorkspaceModel?
        private var rows: [Row] = []
        private var updating = false
        private var request = 0
        private var pending = false

        func update(_ model: WorkspaceModel) {
            self.model = model
            guard let table else { return }
            let next = [Row(key: "projects", name: localized("Projects", "项目"), symbol: nil)]
                + model.projectItems.map { Row(key: "p:" + $0.id, name: $0.name, symbol: "folder") }
                + [Row(key: "sessions", name: localized("Sessions", "会话"), symbol: nil)]
                + model.sessionEntries.map { Row(key: "s:" + $0.sessionID, name: $0.session["name"].string ?? "", symbol: $0.session["agent"].string == nil ? "terminal" : "sparkle") }
            updating = true
            defer { updating = false }
            if next != rows { rows = next; table.reloadData() }
            guard !pending else { return }
            let selected = model.selectedID.map { "s:" + $0 } ?? model.workspace["selectedProject"].string.map { "p:" + $0 }
            let index = rows.firstIndex { $0.key == selected }
            let selection = index.map { IndexSet(integer: $0) } ?? IndexSet()
            if table.selectedRowIndexes != selection { table.selectRowIndexes(selection, byExtendingSelection: false) }
        }

        func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
        func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
            rows.indices.contains(row) && rows[row].symbol != nil
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
                NSLayoutConstraint.activate([icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 12), icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor), icon.widthAnchor.constraint(equalToConstant: 16), icon.heightAnchor.constraint(equalToConstant: 16)])
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
                    else { await model.selectProject(id, focus: focus) }
                    if self.request == token { self.pending = false; self.update(model) }
                }
            }
        }
    }
}
