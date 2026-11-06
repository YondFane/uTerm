import Foundation

public struct AgentNotificationTicket: Equatable, Sendable {
    public let token: UUID
    public let session: String
    public let generation: String
    public let kind: String
    public let source: String
}

// Keep stream ordering separate from permission checks, which can finish after newer activity.
// 流顺序与权限检查分开处理，因为权限检查可能晚于更新的活动完成。
public struct AgentNotificationGate {
    private struct Stream {
        var generation: String
        var state: String?
        var sequence: UInt64?
        var seen: [String] = []
        var pending: AgentNotificationTicket?
    }
    private var streams: [String: Stream] = [:]
    public init() {}
    public func current(_ ticket: AgentNotificationTicket) -> Bool { streams[ticket.session]?.pending == ticket }
    public mutating func cancel(_ session: String) { streams[session]?.pending = nil }
    public mutating func retain(_ sessions: Set<String>) { streams = streams.filter { sessions.contains($0.key) } }
    public mutating func consume(session: String, generation: String, state: String?, events: [CoreActivityEvent], replay: Bool) -> AgentNotificationTicket? {
        let previous = streams[session]
        var stream = previous?.generation == generation ? previous! : Stream(generation: generation)
        if stream.state != state { stream.pending = nil }
        stream.state = state
        var newest: CoreActivityEvent?
        for event in events.sorted(by: { $0.sequence < $1.sequence }) {
            guard stream.sequence == nil || event.sequence > stream.sequence! else { continue }
            stream.sequence = event.sequence
            guard !stream.seen.contains(event.id) else { continue }
            stream.seen.append(event.id)
            if stream.seen.count > 128 { stream.seen.removeFirst(stream.seen.count - 128) }
            stream.pending = nil
            newest = event
        }
        var result: AgentNotificationTicket?
        if !replay, let event = newest, event.kind == state, ["waiting", "done", "notice", "error"].contains(event.kind) {
            let ticket = AgentNotificationTicket(token: UUID(), session: session, generation: generation, kind: event.kind, source: event.source)
            stream.pending = ticket; result = ticket
        }
        streams[session] = stream
        return result
    }
}
