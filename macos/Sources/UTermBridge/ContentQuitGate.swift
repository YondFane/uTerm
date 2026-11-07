import Foundation

@MainActor
public final class ContentQuitGate {
    private struct Pending {
        let token: String
        let continuation: CheckedContinuation<Bool, Error>
        let timer: Task<Void, Never>
    }
    private var pending: Pending?
    public init() {}

    public func prepare(timeout: Duration = .seconds(20), send: (String) throws -> Void) async throws -> Bool {
        guard pending == nil else { throw BridgeFailure(code: "QUIT_BUSY", message: "Content is already preparing to quit") }
        let token = UUID().uuidString
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let timer = Task { @MainActor [weak self] in
                    do { try await Task.sleep(for: timeout) } catch { return }
                    self?.finish(token, .failure(BridgeFailure(code: "QUIT_TIMEOUT", message: "Content did not confirm that saving finished")))
                }
                pending = Pending(token: token, continuation: continuation, timer: timer)
                do { try send(token) } catch { finish(token, .failure(error)) }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finish(token, .failure(CancellationError())) }
        }
    }
    public func respond(token: String, ready: Bool) throws {
        guard pending?.token == token else { throw BridgeFailure(code: "STALE_QUIT", message: "Content quit request is no longer active") }
        finish(token, .success(ready))
    }
    public func invalidate() {
        guard let token = pending?.token else { return }
        finish(token, .failure(BridgeFailure(code: "CONTENT_CHANGED", message: "Content changed while preparing to quit")))
    }
    private func finish(_ token: String, _ result: Result<Bool, Error>) {
        // An old timeout or cancellation cannot settle a replacement document's request.
        // 旧超时或取消不能结束替换文档的新请求。
        guard let value = pending, value.token == token else { return }
        pending = nil
        value.timer.cancel()
        value.continuation.resume(with: result)
    }
}
