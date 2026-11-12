import AppKit
import UniformTypeIdentifiers
import UTermBridge

@MainActor
final class RedisHost: WorkbenchHost {
    let kind = "redis"
    private let bridge: CoreBridge
    private var selection: JSONValue = .null
    func selectProfile(group: String, id: String) async throws {
        let snapshot = try await bridge.snapshot()
        guard !prepared, !preparing, snapshot.document.workspace["selectedWorkspace"].string == group,
              snapshot.document.workspace["groups"].array.first(where: { $0["id"].string == group })?["redisConnections"].array.contains(where: { $0["id"].string == id }) == true else {
            throw BridgeFailure(code: "PROFILE_CHANGED", message: localized("The connection or workspace changed. Select it again.", "连接或工作区已变化，请重新选择。"))
        }
        selection = .object(["request": .string(UUID().uuidString), "group": .string(group), "id": .string(id)])
        emit?("redis-selection-changed", .null)
    }
    private var pending = 0
    private var preparing = false
    private var lastSettings: JSONValue?
    private(set) var prepared = false
    var emit: ((String, JSONValue) -> Void)?
    var report: ((String) -> Void)?
    var changed: (() async -> Void)?
    init(bridge: CoreBridge) { self.bridge = bridge }
    func settingsChanged(_ settings: JSONValue) {
        guard lastSettings != settings else { return }
        lastSettings = settings; emit?("redis-settings-changed", .null)
    }
    private func operation(_ parameters: [String: JSONValue]) async throws -> JSONValue {
        let bridge = bridge
        // A document cancellation must not report a dispatched write complete before Redis replies.
        // 文档取消不能在 Redis 返回前将已分发写入报告为完成。
        return try await Task.detached {
            let started = try await bridge.call("redis.operation.start", params: .object(parameters))
            let operation = try JSONDecoder().decode(CoreRedisOperation.self, from: JSONEncoder().encode(started))
            while true {
                let response = try await bridge.call("redis.operation.read", params: .object(["id": .string(operation.id), "generation": .string(operation.generation), "consume": .bool(true)]))
                if response["state"] == .string("completed") { return response["result"] }
                if response["state"] == .string("failed") {
                    let code = response["error"].string ?? "REDIS_OPERATION_FAILED"
                    throw BridgeFailure(code: code, message: code)
                }
                guard response["state"] == .string("running") else { throw BridgeFailure(code: "REDIS_PROTOCOL", message: "Invalid Redis operation state") }
                try await Task.sleep(for: .milliseconds(20))
            }
        }.value
    }
    private func profiles() async throws -> JSONValue {
        let snapshot = try await bridge.snapshot()
        return .object(["revision": .string(snapshot.revision), "selectedWorkspace": snapshot.document.workspace["selectedWorkspace"], "selection": selection,
            "groups": .array(snapshot.document.workspace["groups"].array.map { group in .object([
                "id": group["id"], "name": group["name"], "redisConnections": .array(group["redisConnections"].array), "sshConnections": .array(group["sshConnections"].array)
            ]) })])
    }
    func execute(_ method: String, params: [String: JSONValue]) async throws -> JSONValue {
        if method == "redis_profiles" {
            guard params.isEmpty else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Redis profiles accepts no arguments") }
            return try await profiles()
        }
        guard !prepared, !preparing else { throw BridgeFailure(code: "REDIS_QUITTING", message: localized("Redis is preparing to quit.", "Redis 正在准备退出。")) }
        pending += 1; defer { pending -= 1 }
        if method == "redis_profile_save" || method == "redis_profile_remove" {
            _ = try await bridge.call(method == "redis_profile_save" ? "redis.profile.save" : "redis.profile.remove", params: .object(params))
            await changed?(); return try await profiles()
        }
        if method == "redis_pick_ca" {
            guard params.isEmpty else { throw BridgeFailure(code: "METHOD_DENIED", message: "CA paths must come from the native picker") }
            let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
            panel.allowedContentTypes = ["pem", "crt", "cer"].compactMap { UTType(filenameExtension: $0) }
            guard panel.runModal() == .OK, let url = panel.url else { return .null }
            return .string(url.path)
        }
        let kinds = ["redis_connect": "connect", "redis_reconnect": "reconnect", "redis_request": "request", "redis_writable": "writable", "redis_disconnect": "disconnect", "redis_guard": "guard", "redis_credential": "credential"]
        guard let kind = kinds[method], params["kind"] == nil else { throw BridgeFailure(code: "METHOD_DENIED", message: "This Redis window cannot access that method") }
        var values = params; values["kind"] = .string(kind)
        return try await operation(values)
    }
    func prepareForQuit() async throws -> Bool {
        if prepared { return true }
        guard !preparing, pending == 0 else { return false }
        preparing = true; emit?("redis-frozen", .bool(true)); defer { preparing = false }
        do {
            let status = try await bridge.call("redis.status")
            guard status["operations"] == .bool(false), status["busy"] == .bool(false) else { await resumeAfterQuit(); return false }
            if status["dirty"] == .bool(true) {
                let alert = NSAlert(); alert.alertStyle = .warning
                alert.messageText = localized("Discard Redis drafts and quit?", "放弃 Redis 草稿并退出？")
                alert.informativeText = localized("Unsaved Redis value and profile changes will be lost.", "未保存的 Redis 值和连接配置修改将丢失。")
                alert.addButton(withTitle: localized("Cancel", "取消")); alert.addButton(withTitle: localized("Discard and Quit", "放弃并退出"))
                guard alert.runModal() == .alertSecondButtonReturn else { await resumeAfterQuit(); return false }
            }
            _ = try await operation(["kind": .string("prepareQuit")]); prepared = true; return true
        } catch { await resumeAfterQuit(); throw error }
    }
    func resumeAfterQuit() async {
        prepared = false
        do { _ = try await bridge.call("redis.resume"); emit?("redis-frozen", .bool(false)) }
        catch { report?(error.localizedDescription) }
    }
}
