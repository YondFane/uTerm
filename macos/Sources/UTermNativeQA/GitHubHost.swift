import AppKit
import UTermBridge

@MainActor
final class GitHubHost: WorkbenchHost {
    let kind = "github"
    let directory: String
    private let bridge: CoreBridge
    private var pending = 0
    private var formActive = false
    private var lastSettings: JSONValue?
    private(set) var prepared = false
    var emit: ((String, JSONValue) -> Void)?
    var context: (() async throws -> JSONValue)?
    var sessionAction: ((String, JSONValue) async throws -> Void)?
    var toolbar: ((String) throws -> Void)?
    weak var window: NSWindow?
    init(bridge: CoreBridge, directory: String) { self.bridge = bridge; self.directory = directory }
    func settingsChanged(_ settings: JSONValue) {
        guard settings != lastSettings else { return }; lastSettings = settings
        emit?("github-settings-changed", .null); emit?("github-context-changed", .null)
    }
    func execute(_ method: String, params: [String: JSONValue]) async throws -> JSONValue {
        guard !prepared else { throw BridgeFailure(code: "GITHUB_QUITTING", message: localized("GitHub is preparing to quit.", "GitHub 正在准备退出。")) }
        if method == "github_context" {
            guard params.isEmpty, let context else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "GitHub context accepts no arguments") }
            return try await context()
        }
        if method == "github_form_guard" {
            guard params.count == 1, let active = params["active"]?.bool else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Missing PR form state") }
            formActive = active; return .null
        }
        if method == "github_toolbar" {
            guard params.count == 1, let kind = params["kind"]?.string, let toolbar else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Missing GitHub toolbar action") }
            try toolbar(kind); return .null
        }
        pending += 1; defer { pending -= 1 }
        if method == "github_session_action" {
            guard params.count == 2, let action = params["kind"]?.string, let item = params["item"], let sessionAction else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Missing GitHub session action") }
            try await sessionAction(action, item); return .null
        }
        let methods = ["github_repositories": "github.repositories", "github_read": "github.read", "github_prepare_pr": "github.prepare", "github_create_pr": "github.create"]
        guard let operation = methods[method], params["directory"] == .string(directory) else { throw BridgeFailure(code: "ROOT_DENIED", message: "This GitHub window cannot select another repository root or method") }
        let bridge = bridge
        // Keep dispatched API writes alive until their actual result, even after document cancellation.
        // 文档取消后，已分发的 API 写入仍须等待实际结果，不能提前解除退出保护。
        return try await Task.detached { try await bridge.call(operation, params: .object(params)) }.value
    }
    func prepareForQuit() async throws -> Bool {
        if prepared { return true }
        guard pending == 0 else { return false }
        if formActive {
            guard let window, window.attachedSheet == nil else { return false }
            let alert = NSAlert(); alert.alertStyle = .warning
            alert.messageText = localized("Discard the PR draft and quit?", "放弃 PR 草稿并退出？")
            alert.informativeText = localized("The unsubmitted title, body and branch selections will be lost.", "尚未提交的标题、正文和分支选择将丢失。")
            alert.addButton(withTitle: localized("Cancel", "取消")); alert.addButton(withTitle: localized("Discard and Quit", "放弃并退出"))
            // Suspend this task so WebKit and other main-actor work can continue while the sheet is open.
            // 显示确认表时挂起当前任务，让 WebKit 和其他主执行器任务继续运行。
            let response = await withCheckedContinuation { continuation in
                alert.beginSheetModal(for: window) { continuation.resume(returning: $0) }
            }
            guard response == .alertSecondButtonReturn, pending == 0 else { return false }
        }
        prepared = true; emit?("github-frozen", .bool(true)); return true
    }
    func resumeAfterQuit() async { prepared = false; emit?("github-frozen", .bool(false)) }
}
