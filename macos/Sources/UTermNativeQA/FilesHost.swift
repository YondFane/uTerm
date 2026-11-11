import AppKit
import UTermBridge

@MainActor
final class FilesHost: WorkbenchHost {
    let kind = "files"
    let directory: String
    private let bridge: CoreBridge
    private let root: ContentFileRoot
    private var pending = 0
    private var lastSettings: JSONValue?
    private(set) var prepared = false
    var emit: ((String, JSONValue) -> Void)?
    var validate: (() async throws -> Void)?
    var context: (() -> JSONValue)?
    var changeMode: ((String) throws -> Void)?
    var toolbar: ((String) throws -> Void)?
    var openFile: ((String, Int) async throws -> Void)?
    var sourceRoot: ((String) async throws -> URL)?
    var mutate: ((String, JSONValue, CoreBridge) async throws -> JSONValue)?

    init(bridge: CoreBridge, directory: URL) throws {
        self.bridge = bridge
        root = try ContentFileRoot(directory: directory)
        self.directory = root.resolvedDirectory.path
    }
    func settingsChanged(_ settings: JSONValue) {
        guard settings != lastSettings else { return }
        lastSettings = settings
        emit?("files-settings-changed", .null)
    }
    func modeChanged() { emit?("files-mode-changed", .null) }
    func execute(_ method: String, params: [String: JSONValue]) async throws -> JSONValue {
        guard !prepared else { throw BridgeFailure(code: "FILES_QUITTING", message: localized("Files are preparing to quit.", "文件面板正在准备退出。")) }
        guard let validate else { throw BridgeFailure(code: "CLOSED", message: "File tools are closed") }
        try await validate()
        try Task.checkCancellation()
        switch method {
        case "files_context":
            guard params.isEmpty, let context else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "File context accepts no arguments") }
            return context()
        case "files_mode":
            guard params.count == 1, let mode = params["mode"]?.string, let changeMode else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Missing file mode") }
            try changeMode(mode); return .null
        case "files_toolbar":
            guard params.count == 1, let kind = params["kind"]?.string, let toolbar else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Missing file toolbar action") }
            try toolbar(kind); return .null
        case "content_open_file":
            guard params.count == 2, let path = params["path"]?.string, let number = params["line"]?.number,
                  let line = Int(exactly: number), line >= 0, let openFile else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Missing file path or line") }
            _ = try await bridge.call("files.read", params: .object(["directory": .string(directory), "path": .string(path)]))
            try Task.checkCancellation()
            try await validate()
            try await openFile(path, line); return .null
        default: break
        }
        let methods = ["files_list": "files.list", "files_search": "files.search", "file_mutate": "files.mutate", "file_copy": "files.copy", "git_file_status": "git.fileStatus"]
        guard params["directory"] == .string(directory) else { throw BridgeFailure(code: "ROOT_DENIED", message: "File tools cannot select another project root") }
        if method == "file_reveal" {
            guard params.count == 2, let path = params["path"]?.string else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Missing reveal path") }
            let target = path.isEmpty ? root.resolvedDirectory : root.resolvedDirectory.appendingPathComponent(path)
            guard path.isEmpty || root.relativePath(for: target) != nil,
                  FileManager.default.fileExists(atPath: target.path) else { throw BridgeFailure(code: "ROOT_DENIED", message: "File reveal must stay inside the selected project") }
            NSWorkspace.shared.activateFileViewerSelecting([target]); return .null
        }
        guard let operation = methods[method] else { throw BridgeFailure(code: "METHOD_DENIED", message: "File method is not allowed") }
        if method == "file_mutate" || method == "file_copy" {
            guard pending == 0, let mutate else { throw BridgeFailure(code: "FILES_BUSY", message: localized("Finish the current file operation first.", "请先完成当前文件操作。")) }
            pending += 1; defer { pending -= 1 }
            var scoped = params
            if method == "file_copy" {
                guard let source = scoped.removeValue(forKey: "sourceDirectory")?.string, let sourceRoot else { throw BridgeFailure(code: "ROOT_DENIED", message: "Copy source must be an existing project") }
                scoped["source_directory"] = .string(try await sourceRoot(source).path)
            }
            return try await mutate(operation, .object(scoped), bridge)
        }
        return try await bridge.call(operation, params: .object(params))
    }
    func prepareForQuit() async throws -> Bool {
        guard pending == 0 else { return false }
        prepared = true; emit?("files-frozen", .bool(true)); return true
    }
    func resumeAfterQuit() async { prepared = false; emit?("files-frozen", .bool(false)) }
}
