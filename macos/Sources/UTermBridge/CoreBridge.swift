import Foundation
import UTermFFI

public struct BridgeFailure: Error, LocalizedError, Sendable {
    public let code: String
    public let message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
    public var errorDescription: String? { "\(code): \(message)" }
}

private final class EventSink: @unchecked Sendable {
    let continuation: AsyncStream<CoreEvent>.Continuation
    init(_ continuation: AsyncStream<CoreEvent>.Continuation) { self.continuation = continuation }
}

public actor CoreBridge {
    public static func runSSHAskpassIfRequested() -> Int32? {
        let status = uterm_ssh_askpass()
        return status < 0 ? nil : status
    }
    private var handle: UInt64
    private let sink: EventSink
    private nonisolated let terminalSink: TerminalSink
    public nonisolated let events: AsyncStream<CoreEvent>
    public nonisolated let terminalFrames: AsyncThrowingStream<TerminalPacket, Error>
    public nonisolated let terminalFailures: AsyncStream<TerminalFailure>

    private init(root: URL) throws {
        guard uterm_abi_version() == 1 else { throw BridgeFailure(code: "ABI_VERSION", message: "Unsupported ABI") }
        var h: UInt64 = 0
        let bytes = Array(root.path.utf8)
        let result = bytes.withUnsafeBufferPointer { uterm_open($0.baseAddress, $0.count, &h) }
        _ = try Self.decode(result)
        let (stream, continuation) = AsyncStream<CoreEvent>.makeStream(bufferingPolicy: .bufferingNewest(64))
        handle = h
        sink = EventSink(continuation)
        events = stream
        let (terminalStream, terminalContinuation) = AsyncThrowingStream<TerminalPacket, Error>.makeStream(bufferingPolicy: .bufferingOldest(256))
        let (failures, failureContinuation) = AsyncStream<TerminalFailure>.makeStream(bufferingPolicy: .bufferingNewest(256))
        terminalFailures = failures
        terminalSink = TerminalSink(terminalContinuation, failures: failureContinuation)
        terminalFrames = terminalStream
        let context = Unmanaged.passUnretained(sink).toOpaque()
        guard uterm_subscribe(h, { context, _, bytes, count in
            guard let context, let bytes else { return }
            let data = Data(bytes: bytes, count: count)
            let sink = Unmanaged<EventSink>.fromOpaque(context).takeUnretainedValue()
            if let event = try? JSONDecoder().decode(CoreEvent.self, from: data) { sink.continuation.yield(event) }
        }, context) == 1 else {
            uterm_close(h)
            throw BridgeFailure(code: "SUBSCRIBE", message: "Event subscription failed")
        }
        guard uterm_terminal_subscribe(h, { context, bytes, count in
            guard let context, let bytes else { return 0 }
            return Unmanaged<TerminalSink>.fromOpaque(context).takeUnretainedValue().receive(bytes, count)
        }, Unmanaged.passUnretained(terminalSink).toOpaque()) == 1 else {
            uterm_close(h)
            throw BridgeFailure(code: "SUBSCRIBE", message: "Terminal subscription failed")
        }
    }

    public static func open(root: URL) async throws -> CoreBridge {
        try await Task.detached { try CoreBridge(root: root) }.value
    }

    public func call(_ method: String, params: JSONValue = .null) throws -> JSONValue {
        try Task.checkCancellation()
        guard handle != 0 else { throw BridgeFailure(code: "CLOSED", message: "Client is closed") }
        let id = UUID().uuidString
        let request = CoreRequest(id: id, method: method, params: params, version: 1)
        let data = try JSONEncoder().encode(request)
        let response = try data.withUnsafeBytes { bytes in
            try Self.decode(uterm_call(handle, bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count))
        }
        guard response.id == id else { throw BridgeFailure(code: "OPERATION_ID", message: "Mismatched response") }
        return response.result ?? .null
    }

    public func snapshot() throws -> CoreSnapshot {
        try JSONDecoder().decode(CoreSnapshot.self, from: JSONEncoder().encode(call("snapshot.read")))
    }

    public func sessionEntries() throws -> [CoreSessionEntry] {
        try JSONDecoder().decode([CoreSessionEntry].self, from: JSONEncoder().encode(call("session.entries")))
    }
    public func viewSnapshot() throws -> CoreViewSnapshot {
        try JSONDecoder().decode(CoreViewSnapshot.self, from: JSONEncoder().encode(call("snapshot.view")))
    }
    public func editorDrafts() throws -> CoreEditorDraftCollection {
        try JSONDecoder().decode(CoreEditorDraftCollection.self, from: JSONEncoder().encode(call("editor.drafts.list")))
    }
    public func projectContext(expectedRevision: String) throws -> CoreProjectContext {
        try JSONDecoder().decode(CoreProjectContext.self, from: JSONEncoder().encode(call("project.context", params: .object(["expectedRevision": .string(expectedRevision)]))))
    }
    public func editorRecoveryCatalog() throws -> CoreEditorRecoveryCatalog {
        try JSONDecoder().decode(CoreEditorRecoveryCatalog.self, from: JSONEncoder().encode(call("editor.drafts.recovery.list")))
    }
    public func gitFavoriteRecoveryCatalog() throws -> CoreGitFavoriteRecoveryCatalog {
        try JSONDecoder().decode(CoreGitFavoriteRecoveryCatalog.self, from: JSONEncoder().encode(call("git.favorites.recovery.list")))
    }
    public func gitFavoriteRecoveryPreview(revision: String) throws -> CoreGitFavoriteRecoverySnapshot {
        try JSONDecoder().decode(CoreGitFavoriteRecoverySnapshot.self, from: JSONEncoder().encode(call("git.favorites.recovery.preview", params: .object(["revision": .string(revision)]))))
    }
    public func editorRecoveryPreview(revision: String) throws -> CoreEditorDraftSnapshot {
        try JSONDecoder().decode(CoreEditorDraftSnapshot.self, from: JSONEncoder().encode(call("editor.drafts.recovery.preview", params: .object(["revision": .string(revision)]))))
    }

    private static func decode(_ buffer: UTermBuffer) throws -> CoreResponse {
        defer { uterm_buffer_release(buffer.allocation) }
        guard let bytes = buffer.data else { throw BridgeFailure(code: "EMPTY_BUFFER", message: "Missing response") }
        let response = try JSONDecoder().decode(CoreResponse.self, from: Data(bytes: bytes, count: buffer.length))
        guard response.version == 1 else { throw BridgeFailure(code: "CONTRACT_VERSION", message: "Unsupported response") }
        if let e = response.error { throw BridgeFailure(code: e.code, message: e.message) }
        return response
    }

    public func close() {
        guard handle != 0 else { return }
        uterm_close(handle)
        handle = 0
        sink.continuation.finish()
        terminalSink.continuation.finish()
        terminalSink.failures.finish()
    }

    public func write(attachment: String, bytes: Data) throws {
        let name = Array(attachment.utf8)
        _ = try name.withUnsafeBufferPointer { name in
            try bytes.withUnsafeBytes { bytes in
                try Self.decode(uterm_terminal_write(handle, name.baseAddress, name.count, bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count))
            }
        }
    }

    public nonisolated func consumed(_ packet: TerminalPacket) { terminalSink.release(packet.allocationSize) }

    deinit {
        let closingHandle = handle
        let retainedSink = sink
        let retainedTerminalSink = terminalSink
        Task.detached {
            if closingHandle != 0 { uterm_close(closingHandle) }
            retainedSink.continuation.finish()
            retainedTerminalSink.continuation.finish()
            retainedTerminalSink.failures.finish()
        }
    }
}
