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

public struct CoreEditorDraft: Codable, Sendable {
    public var bom: Bool
    public var directory: String
    public var kind: String
    public var line_ending: String
    public var path: String
    public var saved: String
    public var text: String
    public var version: String
}

public struct CoreEditorDraftDocument: Codable, Sendable {
    public var drafts: [CoreEditorDraft]
    public var schemaVersion: UInt32
    public var sourceDigest: String?
}

public struct CoreEditorDraftSnapshot: Codable, Sendable {
    public var document: CoreEditorDraftDocument
    public var revision: String
}

public struct CoreEvent: Codable, Sendable {
    public var kind: String
    public var operationId: String
    public var revision: String
    public var version: UInt32
}

public struct CoreFileDocument: Codable, Sendable {
    public var bom: Bool
    public var kind: String
    public var line_ending: String
    public var notice: String?
    public var readonly: Bool
    public var text: String
    public var version: String
}

public struct CoreFileEntry: Codable, Sendable {
    public var directory: Bool
    public var name: String
    public var path: String
    public var symlink: Bool
}

public struct CoreFileListing: Codable, Sendable {
    public var entries: [CoreFileEntry]
    public var partial: Bool
    public var skipped: Int
}

public struct CoreFileMatch: Codable, Sendable {
    public var line: Int
    public var path: String
    public var text: String
}

public struct CoreFileSearch: Codable, Sendable {
    public var matches: [CoreFileMatch]
    public var partial: Bool
    public var skipped: Int
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
