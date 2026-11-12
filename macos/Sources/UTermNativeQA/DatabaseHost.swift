import AppKit
import UTermBridge

@MainActor
final class DatabaseHost: WorkbenchHost {
    let kind = "database"
    private let bridge: CoreBridge
    private var polling: Task<Void, Never>?
    private var selection: JSONValue = .null
    func selectProfile(group: String, id: String) async throws {
        let snapshot = try await bridge.snapshot()
        guard !prepared, !preparing, snapshot.document.workspace["selectedWorkspace"].string == group,
              snapshot.document.workspace["groups"].array.first(where: { $0["id"].string == group })?["databaseConnections"].array.contains(where: { $0["id"].string == id }) == true else {
            throw BridgeFailure(code: "PROFILE_CHANGED", message: localized("The connection or workspace changed. Select it again.", "连接或工作区已变化，请重新选择。"))
        }
        selection = .object(["request": .string(UUID().uuidString), "group": .string(group), "id": .string(id)])
        publish("database-selection-changed", .null)
    }
    private var pending = 0
    private var preparing = false
    private var lastSettings: JSONValue?
    private var windowListening = false
    private var observers: [UUID: (String, JSONValue) -> Void] = [:]
    private(set) var prepared = false
    var emit: ((String, JSONValue) -> Void)?
    var report: ((String) -> Void)?
    var changed: (() async -> Void)?

    init(bridge: CoreBridge) { self.bridge = bridge }
    func startEvents() {
        windowListening = true
        startPolling()
    }
    func observe(_ observer: @escaping (String, JSONValue) -> Void) -> UUID {
        let id = UUID(); observers[id] = observer; startPolling(); return id
    }
    func removeObserver(_ id: UUID) {
        observers.removeValue(forKey: id)
        if !windowListening && observers.isEmpty { polling?.cancel(); polling = nil }
    }
    private func publish(_ kind: String, _ payload: JSONValue) {
        if windowListening { emit?(kind, payload) }
        for observer in Array(observers.values) { observer(kind, payload) }
    }
    private func startPolling() {
        // One Core drain feeds settings and the workbench without competing consumers.
        // 单一 Core 事件读取同时通知设置和工作台，避免竞争消费。
        guard polling == nil else { return }
        let bridge = bridge
        polling = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    let events = try await bridge.call("database.events")
                    for event in events.array {
                        if let kind = event["kind"].string { self?.publish(kind, event["payload"]) }
                    }
                    try await Task.sleep(for: .milliseconds(200))
                } catch {
                    if !Task.isCancelled { self?.publish("database-host-error", .string(error.localizedDescription)) }
                    return
                }
            }
        }
    }
    func stopEvents() {
        windowListening = false
        if observers.isEmpty { polling?.cancel(); polling = nil }
    }
    func shutdownEvents() {
        windowListening = false; observers.removeAll(); polling?.cancel(); polling = nil
    }
    deinit { polling?.cancel() }
    func settingsChanged(_ settings: JSONValue) {
        guard lastSettings != settings else { return }
        lastSettings = settings; publish("database-settings-changed", .null)
    }

    private func operation(_ parameters: [String: JSONValue]) async throws -> JSONValue {
        let bridge = bridge
        // Keep dispatched work alive until its actual result, even when its Web document cancels.
        // 即使 Web 文档取消，也保留已分发操作直到实际结果返回。
        return try await Task.detached {
            let operation = try await bridge.call("database.operation.start", params: .object(parameters))
            guard let id = operation["id"].string, let generation = operation["generation"].string else {
                throw BridgeFailure(code: "DB_PROTOCOL", message: "Missing database operation identity")
            }
            while true {
                let value = try await bridge.call("database.operation.read", params: .object(["id": .string(id), "generation": .string(generation), "consume": .bool(true)]))
                if value["state"] == .string("completed") { return value["result"] }
                if value["state"] == .string("failed") {
                    let code = value["error"].string ?? "DB_OPERATION_FAILED"
                    throw BridgeFailure(code: code, message: code)
                }
                guard value["state"] == .string("running") else { throw BridgeFailure(code: "DB_PROTOCOL", message: "Invalid database operation state") }
                try await Task.sleep(for: .milliseconds(20))
            }
        }.value
    }
    private func profiles() async throws -> JSONValue {
        let state = try await bridge.snapshot()
        return .object([
            "revision": .string(state.revision), "selectedWorkspace": state.document.workspace["selectedWorkspace"], "selection": selection,
            "groups": .array(state.document.workspace["groups"].array.map { group in .object([
                "id": group["id"], "name": group["name"],
                "databaseConnections": .array(group["databaseConnections"].array), "sshConnections": .array(group["sshConnections"].array)
            ]) })
        ])
    }
    func execute(_ method: String, params: [String: JSONValue]) async throws -> JSONValue {
        do { return try await perform(method, params: params) }
        catch {
            let methods = ["database_profiles", "database_profile_save", "database_profile_remove", "database_export_sql", "database_export_result", "database_connect", "database_request", "database_disconnect", "database_guard", "database_credential", "database_components"]
            let code = (error as? BridgeFailure)?.code ?? "HOST_ERROR"
            let safeCode = !code.isEmpty && code.count <= 64 && code.utf8.allSatisfy { (65...90).contains(Int($0)) || $0 == 95 }
            // Log only a fixed method name and a bounded error code, never request or vendor text.
            // 仅记录固定方法名及有界错误码，不记录请求内容或厂商文本。
            NSLog("Database host failure: method=%@ code=%@", methods.contains(method) ? method : "denied", safeCode ? code : "HOST_ERROR")
            throw error
        }
    }
    private func perform(_ method: String, params: [String: JSONValue]) async throws -> JSONValue {
        if method == "database_profiles" {
            guard params.isEmpty else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Database profiles accepts no arguments") }
            return try await profiles()
        }
        guard !prepared, !preparing else { throw BridgeFailure(code: "DB_QUITTING", message: localized("Database is preparing to quit.", "数据库正在准备退出。")) }
        pending += 1
        defer { pending -= 1 }
        if method == "database_profile_save" || method == "database_profile_remove" {
            _ = try await bridge.call(method == "database_profile_save" ? "database.profile.save" : "database.profile.remove", params: .object(params))
            await changed?()
            return try await profiles()
        }
        if method == "database_export_sql" || method == "database_export_result" {
            let sql = method == "database_export_sql"
            guard Set(params.keys) == Set(sql ? ["sql"] : ["data", "format"]),
                  let text = params[sql ? "sql" : "data"]?.string, text.utf8.count <= 8 * 1024 * 1024 else {
                throw BridgeFailure(code: "DB_INPUT_LIMIT", message: "Invalid database export")
            }
            let format = sql ? "sql" : params["format"]?.string ?? ""
            guard ["sql", "csv", "json"].contains(format), sql || format != "sql" else { throw BridgeFailure(code: "DB_INVALID_REQUEST", message: "Invalid database export format") }
            let panel = NSSavePanel(); panel.nameFieldStringValue = "query." + format
            guard panel.runModal() == .OK, let url = panel.url else { return .bool(false) }
            try await Task.detached { try Data(text.utf8).write(to: url, options: .atomic) }.value
            return .bool(true)
        }
        let kinds = ["database_connect": "connect", "database_request": "request", "database_disconnect": "disconnect", "database_guard": "guard", "database_credential": "credential", "database_components": "components"]
        guard let kind = kinds[method] else { throw BridgeFailure(code: "METHOD_DENIED", message: "This database window cannot access that method") }
        var values = params
        guard values["kind"] == nil else { throw BridgeFailure(code: "DB_INVALID_REQUEST", message: "Database operation kind cannot be replaced") }
        values["kind"] = .string(kind)
        if method == "database_components" {
            guard Set(params.keys).isSubset(of: Set(["action", "id"])) else { throw BridgeFailure(code: "METHOD_DENIED", message: "Component paths must come from the native picker") }
            if ["java", "import"].contains(params["action"]?.string ?? "") {
                let status = try await bridge.call("database.status")
                guard status["connected"] == .bool(false), status["busy"] == .bool(false) else { throw BridgeFailure(code: "DB_BUSY", message: localized("Disconnect before changing database components.", "修改数据库组件前请先断开连接。")) }
                let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
                guard panel.runModal() == .OK, let url = panel.url else {
                    return try await operation(["kind": .string("components"), "action": .string("status")])
                }
                values["path"] = .string(url.path)
            }
        }
        return try await operation(values)
    }
    func prepareForQuit() async throws -> Bool {
        if prepared { return true }
        guard !preparing, pending == 0 else { return false }
        preparing = true; publish("database-frozen", .bool(true))
        defer { preparing = false }
        do {
            let status = try await bridge.call("database.status")
            guard status["operations"] == .bool(false), status["busy"] == .bool(false) else { await resumeAfterQuit(); return false }
            if status["dirty"] == .bool(true) {
                let alert = NSAlert(); alert.alertStyle = .warning
                alert.messageText = localized("Discard database drafts and quit?", "放弃数据库草稿并退出？")
                alert.informativeText = localized("Unsaved SQL and document changes will be lost.", "未保存的 SQL 和文档修改将丢失。")
                alert.addButton(withTitle: localized("Cancel", "取消")); alert.addButton(withTitle: localized("Discard and Quit", "放弃并退出"))
                guard alert.runModal() == .alertSecondButtonReturn else { await resumeAfterQuit(); return false }
            }
            _ = try await operation(["kind": .string("prepareQuit")])
            prepared = true
            return true
        } catch { await resumeAfterQuit(); throw error }
    }
    func resumeAfterQuit() async {
        prepared = false
        do { _ = try await bridge.call("database.resume"); publish("database-frozen", .bool(false)) }
        catch { report?(error.localizedDescription) }
    }
}
