import AppKit
import UTermBridge

@MainActor
final class QuickSSHHost: WorkbenchHost {
    let kind = "ssh-quick"
    let workspaceID: String
    private(set) var pending = false
    private var completed = false
    private(set) var prepared = false
    var emit: ((String, JSONValue) -> Void)?
    var connect: ((JSONValue) async throws -> Bool)?
    var close: (() -> Void)?
    init(workspaceID: String) { self.workspaceID = workspaceID }
    func settingsChanged(_ settings: JSONValue) { emit?("quick-ssh-settings-changed", .null) }
    func execute(_ method: String, params: [String: JSONValue]) async throws -> JSONValue {
        guard !prepared else { throw BridgeFailure(code: "CLOSED", message: "Quick SSH is preparing to quit") }
        switch method {
        case "quick_ssh_context":
            guard params.isEmpty else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Quick SSH context accepts no arguments") }
            return .object(["workspaceId": .string(workspaceID)])
        case "quick_ssh_connect":
            guard !pending, !completed, params.count == 1, let connection = params["connection"], connection["workspace_id"] == .string(workspaceID), let connect else {
                throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Quick SSH workspace or operation changed")
            }
            pending = true; defer { pending = false }
            completed = try await connect(connection)
            return .bool(completed)
        case "quick_ssh_close":
            guard !pending, params.isEmpty, let close else { throw BridgeFailure(code: "SSH_OPERATION_BUSY", message: "Wait for the quick SSH operation") }
            // Complete this request before dismantling its document and reply handler.
            // 先完成当前请求，再移除对应文档及回复处理器。
            DispatchQueue.main.async { close() }
            return .null
        default: throw BridgeFailure(code: "METHOD_DENIED", message: "Quick SSH method is not allowed")
        }
    }
    func prepareForQuit() async throws -> Bool {
        guard !pending else { return false }
        prepared = true; return true
    }
    func resumeAfterQuit() async { prepared = false }
}
