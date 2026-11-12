import AppKit
import UTermBridge

@MainActor
enum NativeChromeSmoke {
    static func selectConnection(model: WorkspaceModel, name: String, category: String, capture: URL) async throws {
        model.sidebarVisible = true; model.sidebarSection = category; model.sidebarCollapsed.remove(category)
        var matched: (NSWindow, NSTableView, Int)?
        try await TerminalSmoke.wait("Actual native sidebar contains the saved connection") {
            for window in NSApp.windows {
                guard let root = window.contentView,
                      let table = TerminalSmoke.descendants(root).first(where: { $0.identifier?.rawValue == "native-sidebar" }) as? NSTableView else { continue }
                for row in 0..<table.numberOfRows {
                    if let cell = table.view(atColumn: 0, row: row, makeIfNecessary: true) as? NSTableCellView, cell.textField?.stringValue == name {
                        matched = (window, table, row); return true
                    }
                }
            }
            return false
        }
        guard let (window, table, row) = matched else { throw BridgeFailure(code: "SIDEBAR_PROFILE", message: "Missing connection row") }
        window.makeKeyAndOrderFront(nil); table.scrollRowToVisible(row)
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        try await TerminalSmoke.capture(window: window, path: capture)
    }
}
