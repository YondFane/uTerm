import AppKit
import UTermBridge

@MainActor
private final class SessionDragInfo: NSObject, NSDraggingInfo {
    var draggingDestinationWindow: NSWindow?
    var draggingSourceOperationMask: NSDragOperation = .move
    var draggingLocation = NSPoint.zero
    var draggedImageLocation = NSPoint.zero
    var draggedImage: NSImage? { nil }
    let draggingPasteboard: NSPasteboard
    var draggingSource: Any?
    var draggingSequenceNumber = 1
    var draggingFormation: NSDraggingFormation = .none
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    init(table: NSTableView, pasteboard: NSPasteboard) {
        draggingDestinationWindow = table.window; draggingSource = table; draggingPasteboard = pasteboard
    }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
    func enumerateDraggingItems(options: NSDraggingItemEnumerationOptions, for view: NSView?, classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    func resetSpringLoading() {}
}

@MainActor
enum SessionDragSimulation {
    static func run(model: WorkspaceModel, table: NSTableView, coordinator: NativeSidebar.Coordinator, ids: [String]) async throws -> [String: Bool] {
        guard ids.count >= 2, let bridge = model.bridge else { throw BridgeFailure(code: "DRAG_SIMULATION", message: "Missing native drag fixture") }
        let board = NSPasteboard(name: .init("sh.uterm.qa.drag." + UUID().uuidString))
        defer { coordinator.finishDrag(); table.setDropRow(-1, dropOperation: .above); board.releaseGlobally() }
        let info = SessionDragInfo(table: table, pasteboard: board)
        let foreign = NSTableView()
        let before = model.sessionOrderPeers(ids[0]).map(\.sessionID), oldInterval = model.settings["breakInterval"]
        guard before.count >= 2 else { throw BridgeFailure(code: "DRAG_SIMULATION", message: "Missing two sessions in the same ordering scope") }
        let first = before[0], second = before[1]
        @MainActor func row(_ id: String) throws -> Int {
            guard let row = (0..<table.numberOfRows).first(where: { table.view(atColumn: 0, row: $0, makeIfNecessary: true)?.identifier?.rawValue == "native-sidebar-row-s:" + id }) else { throw BridgeFailure(code: "DRAG_SIMULATION", message: "Missing actual native session row") }
            return row
        }
        @MainActor func begin(_ id: String) throws {
            board.clearContents()
            guard let writer = coordinator.tableView(table, pasteboardWriterForRow: try row(id)), board.writeObjects([writer]) else { throw BridgeFailure(code: "DRAG_SIMULATION", message: "Native table did not provide the session pasteboard item") }
        }
        try await TerminalSmoke.wait("Render actual drag source and target rows") { (try? row(first)) != nil && (try? row(second)) != nil }
        try begin(second); let target = try row(first)
        let original = try await bridge.snapshot()
        info.draggingSource = foreign
        guard coordinator.tableView(table, validateDrop: info, proposedRow: target, proposedDropOperation: .above).isEmpty else { throw BridgeFailure(code: "DRAG_SIMULATION", message: "Foreign drag source was accepted") }
        info.draggingSource = table
        board.setString("forged-session", forType: NativeSidebar.Coordinator.sessionDragType)
        guard coordinator.tableView(table, validateDrop: info, proposedRow: target, proposedDropOperation: .above).isEmpty else { throw BridgeFailure(code: "DRAG_SIMULATION", message: "Forged session payload was accepted") }
        try begin(second); coordinator.finishDrag()
        guard coordinator.tableView(table, validateDrop: info, proposedRow: target, proposedDropOperation: .above).isEmpty,
              (try await bridge.snapshot()).revision == original.revision else { throw BridgeFailure(code: "DRAG_SIMULATION", message: "Cancelled drag changed shared state") }
        try begin(second)
        let changed = JSONValue.number(oldInterval.number == 31 ? 32 : 31)
        await model.patchSettings(["breakInterval": changed])
        let accepted = coordinator.tableView(table, acceptDrop: info, row: target, dropOperation: .above)
        guard accepted else { throw BridgeFailure(code: "DRAG_SIMULATION", message: "Valid source did not reach the revision-checked drop callback") }
        try await TerminalSmoke.wait("Stale drop rejects its captured revision") { !model.busy && model.error.contains("CONFLICT") }
        guard model.sessionOrderPeers(first).map(\.sessionID) == before, model.settings["breakInterval"] == changed else { throw BridgeFailure(code: "DRAG_SIMULATION", message: "Stale drop overwrote ordering or peer settings") }
        try begin(second); let freshTarget = try row(first)
        guard coordinator.tableView(table, acceptDrop: info, row: freshTarget, dropOperation: .above) else { throw BridgeFailure(code: "DRAG_SIMULATION", message: "Fresh native drop was rejected") }
        try await TerminalSmoke.wait("Fresh native delegate drop reorders sessions") { !model.busy && model.sessionOrderPeers(first).first?.sessionID == second }
        try begin(first); let restoreTarget = try row(second)
        guard coordinator.tableView(table, acceptDrop: info, row: restoreTarget, dropOperation: .above) else { throw BridgeFailure(code: "DRAG_SIMULATION", message: "Reverse native drop was rejected") }
        try await TerminalSmoke.wait("Reverse drop restores the original session order") { !model.busy && model.sessionOrderPeers(first).map(\.sessionID) == before }
        await model.patchSettings(["breakInterval": oldInterval])
        guard model.settings["breakInterval"] == oldInterval else { throw BridgeFailure(code: "DRAG_SIMULATION", message: "Drag fixture did not restore settings") }
        return ["passed": true, "actualNSTableViewCallbacks": true, "ownedPasteboard": true, "foreignSourceRejected": true, "forgedPayloadRejected": true, "cancelledDragRejected": true, "staleRevisionRejected": true, "freshDropAndReverseVerified": true]
    }
}
