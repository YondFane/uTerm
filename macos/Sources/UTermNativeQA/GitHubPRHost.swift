import AppKit
import UTermBridge

@MainActor
final class GitHubPRHost: WorkbenchHost {
    let kind = "github-pr"
    let owner: GitHubHost
    let repository: String
    private let context: JSONValue
    private(set) var pending = false
    private var completed = false
    private(set) var prepared = false
    var emit: ((String, JSONValue) -> Void)?
    var layoutChanged: ((Double) -> Void)?
    var close: (() -> Void)?
    var dismiss: (() -> Void)?
    init(owner: GitHubHost, repository: String, context: JSONValue) {
        self.owner = owner; self.repository = repository; self.context = context
    }
    func settingsChanged(_ settings: JSONValue) { emit?("github-pr-settings-changed", .null) }
    func execute(_ method: String, params: [String: JSONValue]) async throws -> JSONValue {
        guard !prepared else { throw BridgeFailure(code: "CLOSED", message: "PR form is preparing to quit") }
        switch method {
        case "github_pr_context":
            guard params.isEmpty else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "PR context accepts no arguments") }
            return .object(["repository": .string(repository), "title": context["title"], "base": context["base"], "head": context["head"]])
        case "github_pr_layout":
            guard params.count == 1, let height = params["height"]?.number, height.isFinite, height >= 40, height <= 4096, let layoutChanged else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "PR layout height is invalid") }
            layoutChanged(height); return .null
        case "github_pr_submit":
            guard !pending, !completed, Set(params.keys) == Set(["title", "body", "base", "head", "draft"]), params["draft"]?.bool != nil,
                  ["title", "body", "base", "head"].allSatisfy({ params[$0]?.string != nil }) else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Invalid PR fields or operation state") }
            pending = true; defer { pending = false }
            // The native host fixes the repository and root; form content cannot redirect a write.
            // 原生宿主固定仓库和根目录，表单内容不能将写入重定向。
            var request = params; request["directory"] = .string(owner.directory); request["repository"] = .string(repository)
            let value = try await owner.execute("github_create_pr", params: request)
            completed = true; owner.formActive = false
            owner.emit?("github-pr-created", value)
            if let close { DispatchQueue.main.async { close() } }
            return value
        case "github_pr_close":
            guard !pending, params.isEmpty, let close else { throw BridgeFailure(code: "GITHUB_BUSY", message: "Wait for the PR operation") }
            DispatchQueue.main.async { close() }; return .null
        default: throw BridgeFailure(code: "METHOD_DENIED", message: "PR form method is not allowed")
        }
    }
    func prepareForQuit() async throws -> Bool {
        guard !pending else { return false }
        // The owning GitHub host presents the single draft confirmation on the main window.
        // 所属 GitHub 宿主在主窗口显示唯一的草稿确认。
        prepared = true; emit?("github-pr-frozen", .bool(true)); return true
    }
    func resumeAfterQuit() async { prepared = false; emit?("github-pr-frozen", .bool(false)) }
}
