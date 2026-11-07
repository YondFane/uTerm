import Foundation

public struct NativeUpdateConfiguration: Sendable {
    public let feed: URL
    public let channel: String
    public let architecture: String
    public let qa: Bool

    public init(feed: URL, channel: String, architecture: String, publicKey: String, qa: Bool) throws {
        guard ["stable", "preview"].contains(channel), ["arm64", "x86_64"].contains(architecture),
              Data(base64Encoded: publicKey)?.count == 32,
              Self.allowed(feed, qa: qa) else { throw BridgeFailure(code: "UPDATE_CONFIGURATION", message: "Invalid update channel, architecture, public key or feed URL") }
        self.feed = feed; self.channel = channel; self.architecture = architecture; self.qa = qa
    }
    private static func allowed(_ url: URL, qa: Bool) -> Bool {
        guard url.user == nil, url.password == nil, url.fragment == nil, let host = url.host, !host.isEmpty else { return false }
        if qa { return ["http", "https"].contains(url.scheme ?? "") && ["127.0.0.1", "[::1]", "::1"].contains(host) }
        return url.scheme == "https"
    }
    public func validateArchive(_ url: URL, platform: String?, architecture: String?, channel: String?) throws {
        guard platform == "macos", architecture == self.architecture, (channel ?? "stable") == self.channel,
              Self.allowed(url, qa: qa), url.host == feed.host, url.port == feed.port,
              url.pathExtension.lowercased() == "zip" else { throw BridgeFailure(code: "UPDATE_TARGET", message: "Update does not match the selected macOS architecture, channel or archive origin") }
    }
}
