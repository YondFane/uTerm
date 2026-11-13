import Foundation

@MainActor
public final class WorkspaceRefreshCycle {
    private var task: Task<Void, Never>?
    private var requested = false

    public init() {}

    public func run(_ read: @escaping @MainActor () async -> Void) async {
        await enqueue(read).value
    }

    func enqueue(_ read: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        requested = true
        if let task { return task }
        // Every caller waits for the last requested read, including its derived menu bindings.
        // 所有调用方都等待最后一次请求的读取完成，包含由快照派生的菜单绑定。
        let cycle = Task { @MainActor in
            defer { self.task = nil }
            while self.requested {
                self.requested = false
                await read()
            }
        }
        task = cycle
        return cycle
    }
}
