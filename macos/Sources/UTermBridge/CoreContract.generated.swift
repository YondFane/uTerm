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

public struct CoreDatabaseOperation: Codable, Sendable {
    public var error: String?
    public var generation: String
    public var id: String
    public var kind: String
    public var result: JSONValue?
    public var state: String
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

public struct CoreEditorDraftCollection: Codable, Sendable {
    public var drafts: [CoreEditorDraftEntry]
    public var revision: String
}

public struct CoreEditorDraftDocument: Codable, Sendable {
    public var drafts: [CoreEditorDraft]
    public var schemaVersion: UInt32
    public var sourceDigest: String?
}

public struct CoreEditorDraftEntry: Codable, Sendable {
    public var draft: CoreEditorDraft
    public var revision: String
}

public struct CoreEditorDraftSnapshot: Codable, Sendable {
    public var document: CoreEditorDraftDocument
    public var revision: String
}

public struct CoreEditorRecoveryCatalog: Codable, Sendable {
    public var backups: [String]
    public var currentRevision: String?
    public var sources: [String]
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

public struct CoreGitBranches: Codable, Sendable {
    public var current: String?
    public var local: [String]
    public var upstream: String?
}

public struct CoreGitChange: Codable, Sendable {
    public var index: String
    public var original: String?
    public var path: String
    public var working: String
}

public struct CoreGitCommit: Codable, Sendable {
    public var author: String
    public var id: String
    public var message: String
    public var parents: [String]
    public var subject: String
    public var timestamp: String
}

public struct CoreGitDiff: Codable, Sendable {
    public var text: String
    public var truncated: Bool
}

public struct CoreGitFavoriteDocument: Codable, Sendable {
    public var repositories: [String: CoreGitFavoriteRepository]
    public var schemaVersion: UInt32
}

public struct CoreGitFavoriteRecoveryCatalog: Codable, Sendable {
    public var backups: [String]
    public var currentRevision: String?
    public var sources: [String]
}

public struct CoreGitFavoriteRecoverySnapshot: Codable, Sendable {
    public var document: CoreGitFavoriteDocument
    public var revision: String
}

public struct CoreGitFavoriteRepository: Codable, Sendable {
    public var aliases: [String]
    public var references: [String]
    public var sourceDigest: String?
}

public struct CoreGitFavorites: Codable, Sendable {
    public var references: [String]
    public var repository: String
    public var revision: String?
    public var sourceDigest: String?
}

public struct CoreGitFileStatus: Codable, Sendable {
    public var changes: [CoreGitChange]
    public var root: String
    public var truncated: Bool
}

public struct CoreGitReference: Codable, Sendable {
    public var ahead: UInt32?
    public var behind: UInt32?
    public var branch: String?
    public var current: Bool
    public var full_name: String
    public var kind: String
    public var name: String
    public var oid: String?
    public var remote: String?
    public var upstream: String?
    public var worktree: String?
}

public struct CoreGitReferenceAction: Codable, Sendable {
    public var action: String
    public var branch: String?
    public var current: String?
    public var name: String?
    public var oid: String?
    public var reference: String
    public var remote: String?
}

public struct CoreGitReferences: Codable, Sendable {
    public var current: String?
    public var references: [CoreGitReference]
    public var remotes: [String]
    public var repository: String
    public var root: String
}

public struct CoreGitRemoteBranch: Codable, Sendable {
    public var branch: String
    public var remote: String
}

public struct CoreGitRemoteBranches: Codable, Sendable {
    public var branches: [CoreGitRemoteBranch]
    public var errors: [String]
}

public struct CoreGitSnapshot: Codable, Sendable {
    public var branch: String
    public var changes: [CoreGitChange]
    public var head: String?
    public var references: [String]
    public var root: String
    public var truncated: Bool
}

public struct CoreGitWorktree: Codable, Sendable {
    public var branch: String
    public var missing: Bool
    public var path: String
}

public struct CoreGitWorktreeSuggestion: Codable, Sendable {
    public var branch: String
    public var path: String
}

public struct CoreImport: Codable, Sendable {
    public var legacy: [String: String]
    public var settings: JSONValue
    public var workspace: JSONValue
}

public struct CoreInputControl: Codable, Sendable {
    public var owned: Bool
    public var owner: String?
}

public struct CoreJavaConfiguration: Codable, Sendable {
    public var configured: Bool
    public var global: CoreJavaMavenConfig
    public var jdks: [CoreJavaHome]
    public var maven_home: String?
    public var project: CoreJavaProjectConfig
    public var revision: String
}

public struct CoreJavaHome: Codable, Sendable {
    public var available: Bool
    public var home: String
    public var registered: Bool
    public var version: UInt32
}

public struct CoreJavaMainClass: Codable, Sendable {
    public var name: String
    public var spring_boot: Bool
}

public struct CoreJavaMavenConfig: Codable, Sendable {
    public var distribution: String?
    public var home: String?
    public var repository: String?
    public var settings: String?
    public var wrapper: Bool?
}

public struct CoreJavaModule: Codable, Sendable {
    public var boot: Bool
    public var jars: [String]
    public var java_version: UInt32?
    public var main_classes: [CoreJavaMainClass]
    public var name: String
    public var packaging: String
    public var path: String
}

public struct CoreJavaProjectConfig: Codable, Sendable {
    public var arguments: [String]?
    public var jar: String?
    public var java_home: String?
    public var java_version: UInt32?
    public var main_class: String?
    public var maven: CoreJavaMavenConfig?
    public var maven_configured: Bool?
    public var maven_profiles: String?
    public var maven_scope: String?
    public var mode: String?
    public var module: String?
    public var offline: Bool?
    public var skip_tests: Bool?
    public var spring_profiles: String?
    public var vm_arguments: [String]?
}

public struct CoreJavaProjectInfo: Codable, Sendable {
    public var modules: [CoreJavaModule]
}

public struct CoreLegacyDraftCandidate: Codable, Sendable {
    public var directory: String
    public var path: String
    public var value: String
}

public struct CoreProjectContext: Codable, Sendable {
    public var directory: String?
    public var projectId: String?
    public var revision: String
    public var worktreeId: String?
}

public struct CorePythonCandidate: Codable, Sendable {
    public var mode: String
    public var target: String
    public var working_directory: String
}

public struct CorePythonConfiguration: Codable, Sendable {
    public var configured: Bool
    public var project: CorePythonRunConfig
    public var revision: String
}

public struct CorePythonInterpreter: Codable, Sendable {
    public var path: String
    public var version: String
    public var virtual_environment: Bool
}

public struct CorePythonProjectInfo: Codable, Sendable {
    public var candidates: [CorePythonCandidate]
    public var truncated: Bool
}

public struct CorePythonRunConfig: Codable, Sendable {
    public var arguments: [String]?
    public var host: String?
    public var interpreter: String?
    public var mode: String?
    public var port: UInt16?
    public var reload: Bool?
    public var target: String?
    public var working_directory: String?
}

public struct CoreRedisOperation: Codable, Sendable {
    public var error: String?
    public var generation: String
    public var id: String
    public var kind: String
    public var result: JSONValue?
    public var state: String
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

public struct CoreRollbackArchive: Codable, Sendable {
    public var automaticRestoreAllowed: Bool
    public var editor: CoreEditorDraftSnapshot?
    public var legacyDraftCandidates: [CoreLegacyDraftCandidate]
    public var legacyRequiresDraftChoice: Bool
    public var legacyValues: [String: String]
    public var schemaVersion: UInt32
    public var snapshot: CoreSnapshot
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

public struct CoreSshInfo: Codable, Sendable {
    public var aliases: [String]
    public var available: Bool
}

public struct CoreSshOperation: Codable, Sendable {
    public var error: String?
    public var generation: String
    public var id: String
    public var kind: String
    public var progress: CoreSshProgress?
    public var result: JSONValue?
    public var state: String
}

public struct CoreSshProgress: Codable, Sendable {
    public var completed: String
    public var name: String
    public var total: String
}

public struct CoreSshResolution: Codable, Sendable {
    public var hostname: String
    public var port: String
    public var proxy: Bool
    public var username: String
}

public struct CoreSshTrustPrompt: Codable, Sendable {
    public var id: String
    public var message: String
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
    public var input_control: CoreInputControl?
    public var reset: Bool
    public var rows: UInt16
    public var sequence: UInt64
}

public struct CoreViewSnapshot: Codable, Sendable {
    public var layout: JSONValue
    public var sessions: [CoreSessionEntry]
    public var snapshot: CoreSnapshot
}
