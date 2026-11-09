import Foundation

public struct NativeApplicationProfile: Sendable {
    public enum Mode: Sendable, Equatable { case qa, personal }
    public static let personalIdentifier = "sh.uterm.desktop.personal"
    public static var compiledMode: Mode {
        #if UTERM_PERSONAL
        return .personal
        #else
        return .qa
        #endif
    }
    public let mode: Mode
    public let identifier: String
    public let embeddedQARoot: String?
    public var personalFixture: Bool { mode == .personal && identifier.hasPrefix("sh.uterm.desktop.qa.native.personal.") && embeddedQARoot != nil }
    public var networkUpdatesAllowed: Bool { mode == .qa || identifier == Self.personalIdentifier || personalFixture }
    public var displayName: String { mode == .personal ? "uTerm Personal" : "uTerm Native QA" }

    public init(mode: Mode, identifier: String, embeddedQARoot: String? = nil) {
        self.mode = mode; self.identifier = identifier; self.embeddedQARoot = embeddedQARoot
    }

    public func dataRoot(applicationSupport: URL, temporaryDirectory: URL, qaOverride: String? = nil) throws -> URL {
        if mode == .personal && identifier == Self.personalIdentifier {
            guard qaOverride == nil, embeddedQARoot == nil else { throw BridgeFailure(code: "PERSONAL_DIRECTORY", message: "Personal builds do not accept QA data overrides") }
            let parent = applicationSupport.standardizedFileURL.resolvingSymlinksInPath()
            let profile = parent.appendingPathComponent(identifier, isDirectory: true)
            let store = profile.appendingPathComponent("shared-state-v1", isDirectory: true)
            guard profile.resolvingSymlinksInPath().path == profile.path, store.resolvingSymlinksInPath().path == store.path else {
                throw BridgeFailure(code: "PERSONAL_DIRECTORY", message: "Personal data cannot redirect into another profile")
            }
            return store
        }
        let packagedFixture = identifier.hasPrefix("sh.uterm.desktop.qa.native.update.") || identifier.hasPrefix("sh.uterm.desktop.qa.native.transition.") || personalFixture
        guard (mode == .qa && identifier == "sh.uterm.desktop.qa.native") || (packagedFixture && embeddedQARoot != nil && (mode == .qa || personalFixture)) else {
            throw BridgeFailure(code: "QA_IDENTITY", message: "Application requires its own isolated bundle identity")
        }
        if let path = qaOverride ?? (packagedFixture ? embeddedQARoot : nil) {
            let root = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
            let temporary = temporaryDirectory.standardizedFileURL.resolvingSymlinksInPath()
            guard root.path.hasPrefix(temporary.path + "/"), root.lastPathComponent.hasPrefix("uterm-native-qa-") else {
                throw BridgeFailure(code: "QA_DIRECTORY", message: "QA override must be a private temporary test directory")
            }
            if packagedFixture, let embeddedQARoot, root != URL(fileURLWithPath: embeddedQARoot).standardizedFileURL.resolvingSymlinksInPath() {
                throw BridgeFailure(code: "QA_DIRECTORY", message: "Packaged fixture cannot select another data root")
            }
            return root.appendingPathComponent("shared-state-v1", isDirectory: true)
        }
        return applicationSupport.appendingPathComponent("sh.uterm.desktop.qa.native/shared-state-v1", isDirectory: true)
    }
}
