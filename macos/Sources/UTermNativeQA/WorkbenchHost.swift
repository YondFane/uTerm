import UTermBridge

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
