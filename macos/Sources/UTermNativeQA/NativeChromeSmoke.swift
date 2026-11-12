import AppKit
import UTermBridge

@MainActor
enum NativeChromeSmoke {
    static func selectConnection(model: WorkspaceModel, id: String, name: String, category: String, capture: URL, report: inout [String: Any]) async throws {
        model.sidebarVisible = true; model.sidebarSection = category; model.sidebarCollapsed.remove(category)
        for window in NSApp.windows {
            if let root = window.contentView, TerminalSmoke.descendants(root).contains(where: { $0.identifier?.rawValue == "native-sidebar" }) {
                window.makeKeyAndOrderFront(nil); break
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        var matched: (NSWindow, NSTableView, Int)?
        let rowIdentifier = "native-sidebar-row-" + (category == "database" ? "d:" : "r:") + id
        do {
            try await TerminalSmoke.wait("Actual native sidebar contains the saved connection") {
                for window in NSApp.windows {
                    guard let root = window.contentView,
                          let table = TerminalSmoke.descendants(root).first(where: { $0.identifier?.rawValue == "native-sidebar" }) as? NSTableView else { continue }
                    for row in 0..<table.numberOfRows {
                        if let cell = table.view(atColumn: 0, row: row, makeIfNecessary: true) as? NSTableCellView, cell.identifier?.rawValue == rowIdentifier, cell.textField?.stringValue == name {
                            matched = (window, table, row); return true
                        }
                    }
                }
                return false
            }
        } catch {
            let tables = NSApp.windows.compactMap { window -> [String: Any]? in
                guard let root = window.contentView, let table = TerminalSmoke.descendants(root).first(where: { $0.identifier?.rawValue == "native-sidebar" }) as? NSTableView else { return nil }
                return ["windowVisible": window.isVisible, "windowKey": window.isKeyWindow, "rows": table.numberOfRows,
                    "rowIDs": (0..<table.numberOfRows).compactMap { table.view(atColumn: 0, row: $0, makeIfNecessary: true)?.identifier?.rawValue }]
            }
            report[category + "SidebarDiagnostics"] = ["category": model.sidebarSection, "workspace": model.groupID, "tables": tables,
                "savedIDs": model.groups.flatMap { $0[category == "database" ? "databaseConnections" : "redisConnections"].array }.compactMap { $0["id"].string }]
            throw error
        }
        guard let (window, table, row) = matched else { throw BridgeFailure(code: "SIDEBAR_PROFILE", message: "Missing connection row") }
        window.makeKeyAndOrderFront(nil); table.scrollRowToVisible(row)
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        try await TerminalSmoke.wait("Selected sidebar profile opens its retained workbench in the main window") {
            guard let document = model.documents.active(in: model.inspectorContextKey) else { return false }
            return document.content.workbenchHost?.kind == category && document.content.webView.window === window && window.isVisible
        }
        guard let content = model.documents.active(in: model.inspectorContextKey)?.content else { throw BridgeFailure(code: "SIDEBAR_PROFILE", message: "The selected workbench is unavailable") }
        let deadline = Date().addingTimeInterval(20)
        var ready = false
        while Date() < deadline {
            ready = try await EditorSmoke.evaluate(content, script: """
                const selected=document.querySelector('.native-database-profile-name[aria-pressed=true]');
                return selected?.closest('.native-database-profile')?.dataset.profileId===id &&
                    document.querySelector('.native-database-toolbar')?.hidden===true &&
                    document.querySelector('.native-database-layout > aside')?.hidden===true;
                """, arguments: ["id": id])
            if ready { break }
            try await Task.sleep(for: .milliseconds(40))
        }
        guard ready else { throw BridgeFailure(code: "SIDEBAR_PROFILE", message: "The main workbench did not finish selecting the connection") }
        _ = try await EditorSmoke.evaluate(content, script: "await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return true;", arguments: [:])
        try await TerminalSmoke.capture(window: window, path: capture)
    }
}
