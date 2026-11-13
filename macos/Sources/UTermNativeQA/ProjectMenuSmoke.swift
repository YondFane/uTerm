import AppKit
import UTermBridge

@MainActor
enum ProjectMenuSmoke {
    static func run(model: WorkspaceModel, window: NSWindow, projectID: String, prefix: String, evidence: URL, report: inout [String: Any]) async throws {
        guard let bridge = model.bridge, let content = window.contentView,
              let table = TerminalSmoke.descendants(content).first(where: { $0.identifier?.rawValue == "native-sidebar" }) as? NSTableView,
              let coordinator = table.delegate as? NativeSidebar.Coordinator,
              let initial = model.workspace["projects"].array.first(where: { $0["id"].string == projectID }), let selected = model.selectedID else { throw BridgeFailure(code: "PROJECT_MENU", message: "Missing live project menu fixture") }
        let workspaceID = model.groupID, oldInterval = model.settings["breakInterval"]
        let originalLayout = JSONValue.array(initial["splitGroups"].array)
        let originalSession = selected
        var temporarySession: String?
        if initial["sessions"].array.count == 1 && originalLayout.array.isEmpty {
            await model.newTerminal(); temporarySession = model.selectedID
            try await TerminalSmoke.wait("Project menu fixture starts a second real terminal") { model.selectedTerminal?.generation != nil }
        }
        let ids = model.state?.sessions.filter { $0.projectId == projectID }.map(\.sessionID) ?? []
        var generations: [String: String] = [:], views: [String: ObjectIdentifier] = [:]
        for id in ids {
            guard let terminal = model.terminals[id], let generation = terminal.generation else { throw BridgeFailure(code: "PROJECT_MENU", message: "Project terminal is not ready") }
            generations[id] = generation; views[id] = ObjectIdentifier(terminal.view)
        }
        guard ids.count >= 2 else { throw BridgeFailure(code: "PROJECT_MENU", message: "Project menu fixture needs two real terminals") }
        let dragProof = try await SessionDragSimulation.run(model: model, table: table, coordinator: coordinator, ids: ids)
        var groupedThroughMenu = false
        if originalLayout.array.isEmpty {
            let actions = NativeSessionMenuActions(model: model, id: ids[0]), menu = NSMenu()
            actions.populate(menu)
            guard let index = menu.items.firstIndex(where: { $0.action.map(NSStringFromSelector) == "group:" && $0.representedObject as? String == ids[1] && $0.isEnabled }) else { throw BridgeFailure(code: "PROJECT_MENU", message: "Missing actual Group with menu action") }
            withExtendedLifetime(actions) { menu.performActionForItem(at: index) }
            try await TerminalSmoke.wait("Group real project sessions through their menu") { !model.busy && model.sessionGroupMembers(ids[0]).contains(ids[1]) }
            groupedThroughMenu = true
        }
        let layout = model.workspace["projects"].array.first { $0["id"].string == projectID }?["splitGroups"].array ?? []
        let targetID = UUID().uuidString
        guard await model.mutate("workspace.create", ["id": .string(targetID), "name": .string("Menu move QA"), "select": .bool(false)]) else { throw BridgeFailure(code: "PROJECT_MENU", message: model.error) }
        model.sidebarSection = "all"; model.sidebarVisible = true
        @MainActor func projectMenu() throws -> NSMenu {
            guard let row = (0..<table.numberOfRows).first(where: { table.view(atColumn: 0, row: $0, makeIfNecessary: true)?.identifier?.rawValue == "native-sidebar-row-p:" + projectID }) else { throw BridgeFailure(code: "PROJECT_MENU", message: "Actual project row is missing") }
            let menu = NSMenu(); coordinator.populate(menu, row: row); return menu
        }
        @MainActor func moveItem(_ menu: NSMenu, target: String) throws -> (NSMenu, Int) {
            guard let submenu = menu.items.first(where: { $0.submenu?.items.contains(where: { ($0.representedObject as? [String: String])?["workspaceId"] == target }) == true })?.submenu,
                  let index = submenu.items.firstIndex(where: { ($0.representedObject as? [String: String])?["workspaceId"] == target && $0.isEnabled }) else { throw BridgeFailure(code: "PROJECT_MENU", message: "Move to workspace menu is missing") }
            return (submenu, index)
        }
        @MainActor func dispatch(_ menu: NSMenu, index: Int, label: String, accepted: @escaping @MainActor () -> Bool) async throws {
            let before = try await bridge.snapshot()
            for attempt in 0..<3 {
                model.error = ""
                menu.performActionForItem(at: index)
                do {
                    try await TerminalSmoke.wait(label) { !model.busy && (!model.error.isEmpty || accepted()) }
                } catch {
                    report["nativeProjectMenuFailure"] = ["action": label, "attempt": attempt, "enabled": menu.item(at: index)?.isEnabled == true, "busy": model.busy, "error": model.error]
                    throw error
                }
                let message = model.error
                var attempts = report["nativeProjectMenuActionAttempts"] as? [[String: Any]] ?? []
                attempts.append(["action": label, "attempt": attempt, "error": message])
                report["nativeProjectMenuActionAttempts"] = attempts
                if accepted() { return }
                guard attempt < 2, message.hasPrefix("WRITER_BUSY:") else { throw BridgeFailure(code: "PROJECT_MENU", message: label + ": " + message) }
                let unchanged = try await bridge.snapshot()
                guard unchanged.revision == before.revision, unchanged.document.workspace == before.document.workspace, unchanged.document.settings == before.document.settings else { throw BridgeFailure(code: "PROJECT_MENU_RETRY", message: "Refusing to repeat a menu action after shared data changed") }
                // Re-click the same captured revision only after a visible busy failure and unchanged data.
                // 仅在可见忙碌错误且数据未变后，重新点击保留原 revision 的同一菜单。
            }
        }
        try await TerminalSmoke.wait("Render original project row before capturing menus") { (0..<table.numberOfRows).contains { table.view(atColumn: 0, row: $0, makeIfNecessary: true)?.identifier?.rawValue == "native-sidebar-row-p:" + projectID } }
        let stalePin = try projectMenu(), staleMove = try projectMenu()
        guard let pinIndex = stalePin.items.firstIndex(where: { $0.action.map(NSStringFromSelector) == "toggleProjectFlag:" && ($0.representedObject as? [String: String])?["key"] == "pinned" }) else { throw BridgeFailure(code: "PROJECT_MENU", message: "Pin project menu is missing") }
        let pinned = initial["pinned"].bool == true
        let (oldMoveMenu, oldMoveIndex) = try moveItem(staleMove, target: targetID)
        let peerInterval = JSONValue.number(oldInterval.number == 31 ? 32 : 31)
        let peer = try await CoreBridge.open(root: WorkspaceModel.dataRoot())
        do {
            let snapshot = try await peer.snapshot()
            _ = try await peer.call("settings.patch", params: .object(["expectedRevision": .string(snapshot.revision), "patch": .object(["breakInterval": peerInterval])]))
            await peer.close()
        } catch { await peer.close(); throw error }
        await model.reload(); model.error = ""
        try await dispatch(stalePin, index: pinIndex, label: "Reject a stale real project pin menu") { model.error.hasPrefix("CONFLICT:") }
        guard model.projects.first(where: { $0["id"].string == projectID })?["pinned"].bool == pinned else { throw BridgeFailure(code: "PROJECT_MENU_STALE", message: "Stale pin menu changed current data") }
        try await dispatch(oldMoveMenu, index: oldMoveIndex, label: "Reject a stale real workspace-move menu") { model.error.hasPrefix("CONFLICT:") }
        guard model.workspace["projects"].array.first(where: { $0["id"].string == projectID })?["workspaceId"].string == workspaceID, model.settings["breakInterval"] == peerInterval else { throw BridgeFailure(code: "PROJECT_MENU_STALE", message: "Stale menu moved a project or lost a peer setting") }
        await model.reload(); model.error = ""
        let fresh = try projectMenu()
        let (move, index) = try moveItem(fresh, target: targetID)
        try await dispatch(move, index: index, label: "Fresh actual menu moves the project and its sessions") { model.error.isEmpty && model.workspace["projects"].array.first(where: { $0["id"].string == projectID })?["workspaceId"].string == targetID }
        guard await model.mutate("workspace.switch", ["id": .string(targetID)]) else { throw BridgeFailure(code: "PROJECT_MENU", message: model.error) }
        await model.selectSession(originalSession)
        try await TerminalSmoke.wait("Moved project retains native terminal views") { ids.allSatisfy { model.terminals[$0]?.generation == generations[$0] && model.terminals[$0].map { ObjectIdentifier($0.view) } == views[$0] } }
        let reopened = try await CoreBridge.open(root: WorkspaceModel.dataRoot())
        let saved = try await reopened.snapshot(); await reopened.close()
        guard let project = saved.document.workspace["projects"].array.first(where: { $0["id"].string == projectID }), project["workspaceId"].string == targetID, project["splitGroups"].array == layout else { throw BridgeFailure(code: "PROJECT_MENU_PERSIST", message: "Reopened snapshot lost project ownership or split layout") }
        let screenshot = prefix + "-project-workspace-move.png"
        try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent(screenshot))
        let back = try projectMenu()
        let (returnMenu, returnIndex) = try moveItem(back, target: workspaceID)
        try await dispatch(returnMenu, index: returnIndex, label: "Move the project back through its fresh menu") { model.error.isEmpty && model.workspace["projects"].array.first(where: { $0["id"].string == projectID })?["workspaceId"].string == workspaceID }
        guard await model.mutate("workspace.switch", ["id": .string(workspaceID)]) else { throw BridgeFailure(code: "PROJECT_MENU", message: model.error) }
        await model.selectSession(originalSession)
        if groupedThroughMenu {
            let actions = NativeSessionMenuActions(model: model, id: ids[0]), menu = NSMenu(); actions.populate(menu)
            guard let index = menu.items.firstIndex(where: { $0.action.map(NSStringFromSelector) == "ungroup" && $0.isEnabled }) else { throw BridgeFailure(code: "PROJECT_MENU", message: "Ungroup menu is missing") }
            withExtendedLifetime(actions) { menu.performActionForItem(at: index) }
            try await TerminalSmoke.wait("Restore original ungrouped project layout") { !model.busy && model.sessionGroupMembers(ids[0]).isEmpty }
        }
        if let temporarySession { await model.closeSession(id: temporarySession) }
        guard await model.mutate("workspace.remove", ["id": .string(targetID)]) else { throw BridgeFailure(code: "PROJECT_MENU", message: model.error) }
        await model.patchSettings(["breakInterval": oldInterval]); await model.selectSession(originalSession)
        let retainedIDs = ids.filter { $0 != temporarySession }
        guard model.workspace["projects"].array.first(where: { $0["id"].string == projectID })?["splitGroups"].array == originalLayout.array,
              model.settings["breakInterval"] == oldInterval, model.selectedID == originalSession,
              retainedIDs.allSatisfy({ model.terminals[$0]?.generation == generations[$0] && model.terminals[$0].map { ObjectIdentifier($0.view) } == views[$0] }) else { throw BridgeFailure(code: "PROJECT_MENU_PERSIST", message: "Cleanup did not restore layout/settings or retain original terminals") }
        var proof: [String: Any] = ["passed": true, "actualMenuActions": true, "stalePinRejected": true, "staleMoveRejected": true, "peerSettingRetained": true, "terminalGenerationsAndViewsRetained": true, "splitLayoutRetainedInReopenedSnapshot": true, "movedAndReturned": true]
        proof["dragSimulation"] = dragProof
        proof["groupMenuExecuted"] = groupedThroughMenu; proof["physicalDragExecuted"] = false; proof["screenshot"] = screenshot
        proof["sourceHeadSHA"] = report["sourceHeadSHA"] as? String ?? ""
        proof["testedMergeSHA"] = report["testedMergeSHA"] as? String ?? report["sourceSHA"] as? String ?? ""
        proof["platform"] = "macOS"; proof["architecture"] = report["architecture"] as? String ?? ""; proof["system"] = report["system"] as? String ?? ""
        report["nativeProjectMenuRevisionAndWorkspaceMove"] = proof
    }
}
