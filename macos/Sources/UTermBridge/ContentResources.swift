import Foundation

public struct ContentResources: Sendable {
    public static let scheme = "uterm-content"
    public let root: URL
    private let allowed: Set<String>

    public init(root: URL) throws {
        self.root = root.standardizedFileURL.resolvingSymlinksInPath()
        let manifest = self.root.appendingPathComponent("content-manifest.json")
        let values = try manifest.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              (values.fileSize ?? Int.max) <= 1024 * 1024 else {
            throw BridgeFailure(code: "RESOURCE_MANIFEST", message: "Invalid bundled content manifest")
        }
        let paths = try JSONDecoder().decode([String].self, from: Data(contentsOf: manifest))
        guard !paths.isEmpty, paths.count <= 10000, paths.allSatisfy(Self.validPath),
              paths.contains("native-content.html") else {
            throw BridgeFailure(code: "RESOURCE_MANIFEST", message: "Content manifest contains an unapproved resource")
        }
        allowed = Set(paths)
    }

    private static func validPath(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return (path == "native-content.html" || path.hasPrefix("assets/") || path.hasPrefix("pdf-assets/"))
            && parts.count <= 12 && parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
            && path.unicodeScalars.allSatisfy { CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._/").contains($0) }
    }

    public func data(for url: URL) throws -> (Data, String) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == Self.scheme, components.host == "bundle", components.port == nil,
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              components.percentEncodedPath.hasPrefix("/"), !components.percentEncodedPath.contains("%") else {
            throw BridgeFailure(code: "RESOURCE_DENIED", message: "Content resource origin is not allowed")
        }
        let path = String(components.percentEncodedPath.dropFirst())
        guard Self.validPath(path), allowed.contains(path) else {
            throw BridgeFailure(code: "RESOURCE_DENIED", message: "Content resource is not in the bundle manifest")
        }
        var file = root
        for component in path.split(separator: "/") {
            file.appendPathComponent(String(component))
            let values = try file.resourceValues(forKeys: [.isSymbolicLinkKey])
            guard values.isSymbolicLink != true else {
                throw BridgeFailure(code: "RESOURCE_DENIED", message: "Content resources cannot follow symbolic links")
            }
        }
        let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, (values.fileSize ?? Int.max) <= 16 * 1024 * 1024 else {
            throw BridgeFailure(code: "RESOURCE_DENIED", message: "Content resource type or size is invalid")
        }
        let bytes = try Data(contentsOf: file)
        guard bytes.count <= 16 * 1024 * 1024 else {
            throw BridgeFailure(code: "RESOURCE_DENIED", message: "Content resource exceeds the bounded limit")
        }
        let mime = ["html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css", "wasm": "application/wasm", "ttf": "font/ttf", "json": "application/json", "png": "image/png", "svg": "image/svg+xml"][file.pathExtension] ?? "application/octet-stream"
        return (bytes, mime)
    }
}
