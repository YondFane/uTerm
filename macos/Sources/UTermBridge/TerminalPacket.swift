import Foundation

public struct TerminalPacket: Sendable {
    public let header: CoreTerminalHeader
    public let bytes: Data
    let allocationSize: Int

    init(_ data: Data) throws {
        guard data.count >= 4 else { throw BridgeFailure(code: "TERMINAL_FRAME", message: "Truncated frame") }
        let size = Int(data.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian })
        guard size > 0, size <= 65_536, size <= data.count - 4 else {
            throw BridgeFailure(code: "TERMINAL_FRAME", message: "Invalid metadata length")
        }
        header = try JSONDecoder().decode(CoreTerminalHeader.self, from: data.subdata(in: 4..<(4 + size)))
        guard header.attachment?.isEmpty == false, header.generation?.isEmpty == false,
              header.rows > 0, header.rows <= 1000, header.cols > 0, header.cols <= 1000 else {
            throw BridgeFailure(code: "TERMINAL_FRAME", message: "Invalid stream identity or dimensions")
        }
        bytes = data.suffix(from: 4 + size)
        allocationSize = data.count
    }
}

public struct TerminalFailure: Sendable {
    public let attachment: String?
    public let generation: String?
    public let code: String
    public let message: String
}

final class TerminalSink: @unchecked Sendable {
    let continuation: AsyncThrowingStream<TerminalPacket, Error>.Continuation
    let failures: AsyncStream<TerminalFailure>.Continuation
    private let lock = NSLock()
    private var pendingBytes = 0
    init(_ continuation: AsyncThrowingStream<TerminalPacket, Error>.Continuation, failures: AsyncStream<TerminalFailure>.Continuation) { self.continuation = continuation; self.failures = failures }

    func receive(_ bytes: UnsafePointer<UInt8>, _ count: Int) -> UInt32 {
        lock.lock()
        guard count <= 16 * 1024 * 1024 - pendingBytes else {
            lock.unlock()
            report(bytes, count, code: "TERMINAL_BACKPRESSURE", message: "Output paused; reconnect to replay")
            return 0
        }
        pendingBytes += count
        lock.unlock()
        do {
            let packet = try TerminalPacket(Data(bytes: bytes, count: count))
            if case .enqueued = continuation.yield(packet) { return 1 }
            release(count)
            report(bytes, count, code: "TERMINAL_BACKPRESSURE", message: "Output paused; reconnect to replay")
        } catch {
            release(count)
            report(bytes, count, code: "TERMINAL_FRAME", message: error.localizedDescription)
        }
        return 0
    }

    private func report(_ bytes: UnsafePointer<UInt8>, _ count: Int, code: String, message: String) {
        var header: CoreTerminalHeader?
        if count >= 4 {
            let size = Int(UnsafeRawPointer(bytes).loadUnaligned(as: UInt32.self).littleEndian)
            if size > 0, size <= 65_536, size <= count - 4 { header = try? JSONDecoder().decode(CoreTerminalHeader.self, from: Data(bytes: bytes.advanced(by: 4), count: size)) }
        }
        failures.yield(TerminalFailure(attachment: header?.attachment, generation: header?.generation, code: code, message: message))
    }

    func release(_ count: Int) {
        lock.lock()
        pendingBytes = max(0, pendingBytes - count)
        lock.unlock()
    }
}
