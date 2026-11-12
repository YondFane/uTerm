import Foundation

public struct ContentFileRoot: Sendable {
    public let protocolDirectory: String
    public let resolvedDirectory: URL

    public init(directory: URL) throws {
        guard directory.isFileURL, directory.path.hasPrefix("/") else {
            throw BridgeFailure(code: "ROOT_DENIED", message: "Content cannot select a different project root")
        }
        // Draft keys retain the selected spelling; resolving aliases is only for filesystem boundaries.
        // 草稿键保留选定路径的写法；解析别名仅用于文件系统边界。
        protocolDirectory = directory.path
        resolvedDirectory = directory.standardizedFileURL.resolvingSymlinksInPath()
    }

    public static func normalizingGitRoot(_ value: JSONValue) throws -> JSONValue {
        if value == .null { return value }
        guard case .object(var fields) = value, let path = fields["root"]?.string,
              path.hasPrefix("/"), !path.contains("\0") else {
            throw BridgeFailure(code: "GIT_ROOT", message: "Git did not return a valid repository root")
        }
        // Git and Cocoa can spell temporary-directory aliases differently; use one filesystem namespace.
        // Git 与 Cocoa 对临时目录别名的写法可能不同，读取结果须使用一致的文件系统路径表示。
        fields["root"] = .string(try ContentFileRoot(directory: URL(fileURLWithPath: path)).resolvedDirectory.path)
        return .object(fields)
    }

    public func relativePath(for file: URL) -> String? {
        guard file.isFileURL else { return nil }
        let prefix = resolvedDirectory.path.hasSuffix("/") ? resolvedDirectory.path : resolvedDirectory.path + "/"
        let target = file.standardizedFileURL.resolvingSymlinksInPath().path
        guard target.hasPrefix(prefix) else { return nil }
        let selected = file.standardizedFileURL.path
        for directory in [protocolDirectory, resolvedDirectory.path] {
            let logicalPrefix = directory.hasSuffix("/") ? directory : directory + "/"
            if selected.hasPrefix(logicalPrefix) {
                let relative = String(selected.dropFirst(logicalPrefix.count))
                if !relative.isEmpty { return relative }
            }
        }
        let relative = String(target.dropFirst(prefix.count))
        return relative.isEmpty ? nil : relative
    }
}
