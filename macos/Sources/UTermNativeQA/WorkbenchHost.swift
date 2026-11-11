import UTermBridge

@MainActor
func nativeWorkbenchTitle(_ kind: String) -> String {
    switch kind {
    case "files": return localized("Files", "文件")
    case "github": return "GitHub"
    case "redis": return localized("Redis connections", "Redis 连接")
    default: return localized("Databases", "数据库")
    }
}

@MainActor
protocol WorkbenchHost: AnyObject {
    var kind: String { get }
    var prepared: Bool { get }
    var emit: ((String, JSONValue) -> Void)? { get set }
    func startEvents()
    func stopEvents()
    func settingsChanged(_ settings: JSONValue)
    func execute(_ method: String, params: [String: JSONValue]) async throws -> JSONValue
    func prepareForQuit() async throws -> Bool
    func resumeAfterQuit() async
}

@MainActor
extension WorkbenchHost {
    func startEvents() {}
    func stopEvents() {}
}
