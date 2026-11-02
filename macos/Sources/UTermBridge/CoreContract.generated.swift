// Generated from uterm-core Rust DTOs; run pnpm contracts:generate.
// 由 uterm-core Rust DTO 生成；执行 pnpm contracts:generate。
import Foundation

public struct CoreActivityEvent: Codable, Sendable {
    public var id: String
    public var kind: String
    public var sequence: UInt64
    public var source: String
}

public struct CoreCoreError: Codable, Sendable {
    public var code: String
    public var message: String
    public var recoverable: Bool
}

public struct CoreDocument: Codable, Sendable {
    public var legacy: [String: String]
    public var migrationId: String
    public var schemaVersion: UInt32
    public var settings: JSONValue
    public var workspace: JSONValue
}

public struct CoreEvent: Codable, Sendable {
    public var kind: String
    public var operationId: String
    public var revision: String
    public var version: UInt32
}

public struct CoreImport: Codable, Sendable {
    public var legacy: [String: String]
    public var settings: JSONValue
    public var workspace: JSONValue
}

public struct CoreRequest: Codable, Sendable {
    public var id: String
    public var method: String
    public var params: JSONValue?
    public var version: UInt32
}

public struct CoreResponse: Codable, Sendable {
    public var error: CoreCoreError?
    public var id: String
    public var result: JSONValue?
    public var version: UInt32
}

public struct CoreSessionEntry: Codable, Sendable {
    public var directory: String
    public var projectId: String?
    public var rosterId: String
    public var session: JSONValue
    public var workspaceId: String
}

public struct CoreSnapshot: Codable, Sendable {
    public var document: CoreDocument
    public var revision: String
}

public struct CoreTerminalHeader: Codable, Sendable {
    public var agent_activity_error: String?
    public var agent_events: [CoreActivityEvent]?
    public var agent_state: String?
    public var attachment: String?
    public var code: UInt32?
    public var cols: UInt16
    public var error: String?
    public var exited: Bool
    public var foreground_agent: String?
    public var generation: String?
    public var reset: Bool
    public var rows: UInt16
    public var sequence: UInt64
}

public struct CoreViewSnapshot: Codable, Sendable {
    public var layout: JSONValue
    public var sessions: [CoreSessionEntry]
    public var snapshot: CoreSnapshot
}
