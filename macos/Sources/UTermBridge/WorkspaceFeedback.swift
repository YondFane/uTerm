public struct WorkspaceFeedback: Sendable {
    public private(set) var message = ""
    private var snapshotFailure = false

    public init() {}

    public mutating func operation(_ message: String) {
        self.message = message
        snapshotFailure = false
    }

    public mutating func snapshotFailed(_ message: String) {
        guard self.message.isEmpty || snapshotFailure else { return }
        self.message = message
        snapshotFailure = true
    }

    public mutating func snapshotSucceeded() {
        if snapshotFailure { message = "" }
        snapshotFailure = false
    }
}
