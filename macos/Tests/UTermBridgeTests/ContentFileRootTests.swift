import Foundation
import XCTest
@testable import UTermBridge

final class ContentFileRootTests: XCTestCase {
    func testAliasKeepsDraftIdentityWhilePickerRejectsEscapesAndPrefixSiblings() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let actual = base.appendingPathComponent("project 中文")
        let sibling = base.appendingPathComponent("project 中文-other")
        let alias = base.appendingPathComponent("selected link")
        try FileManager.default.createDirectory(at: actual, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        try Data("inside".utf8).write(to: actual.appendingPathComponent("a.txt"))
        let outside = sibling.appendingPathComponent("outside.txt")
        try Data("outside".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: actual)
        try FileManager.default.createSymbolicLink(at: actual.appendingPathComponent("inside-link.txt"), withDestinationURL: actual.appendingPathComponent("a.txt"))
        try FileManager.default.createSymbolicLink(at: actual.appendingPathComponent("escape.txt"), withDestinationURL: outside)
        let root = try ContentFileRoot(directory: alias)
        XCTAssertEqual(root.protocolDirectory, alias.path)
        XCTAssertNotEqual(root.protocolDirectory, root.resolvedDirectory.path)
        XCTAssertEqual(root.resolvedDirectory, actual.standardizedFileURL.resolvingSymlinksInPath())
        XCTAssertEqual(root.relativePath(for: alias.appendingPathComponent("a.txt")), "a.txt")
        XCTAssertEqual(root.relativePath(for: actual.appendingPathComponent("a.txt")), "a.txt")
        XCTAssertEqual(root.relativePath(for: alias.appendingPathComponent("inside-link.txt")), "inside-link.txt")
        XCTAssertNil(root.relativePath(for: outside))
        XCTAssertNil(root.relativePath(for: actual.appendingPathComponent("escape.txt")))
        XCTAssertNil(root.relativePath(for: actual))
        XCTAssertNil(root.relativePath(for: URL(string: "https://qa.invalid/a.txt")!))
        XCTAssertThrowsError(try ContentFileRoot(directory: URL(string: "https://qa.invalid/")!))
    }

    func testPrivateVarTemporaryAliasIsNotRewrittenAsADraftKey() throws {
        let directory = FileManager.default.temporaryDirectory
        let path = directory.path
        let alternate: String
        if path.hasPrefix("/private/var/") { alternate = String(path.dropFirst("/private".count)) }
        else if path.hasPrefix("/var/") { alternate = "/private" + path }
        else { throw XCTSkip("Runner does not use the macOS /var temporary directory alias") }
        let original = try ContentFileRoot(directory: directory)
        let other = try ContentFileRoot(directory: URL(fileURLWithPath: alternate))
        XCTAssertEqual(other.protocolDirectory, alternate)
        XCTAssertNotEqual(original.protocolDirectory, other.protocolDirectory)
        XCTAssertEqual(original.resolvedDirectory, other.resolvedDirectory)
    }

    func testHistoricalAliasDraftIsRecoveredThroughActualCoreABIWithoutChangingFile() async throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let project = base.appendingPathComponent("project")
        let alias = base.appendingPathComponent("legacy-project")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: project)
        let file = project.appendingPathComponent("a.txt")
        let original = Data("\u{feff}ORIGINAL\r\n".utf8)
        let text = "LEGACY_DRAFT 中文 é\r\n"
        try original.write(to: file)
        let core = try await CoreBridge.open(root: base.appendingPathComponent("shared-state-v1"))
        do {
            let defaults = try await core.call("state.defaults")
            _ = try await core.call("migration.import", params: .object(["workspace": defaults["workspace"], "settings": defaults["settings"], "legacy": .object([:])]))
            let disk = try await core.call("files.read", params: .object(["directory": .string(alias.path), "path": .string("a.txt")]))
            let legacy = JSONValue.object(["directory": .string(alias.path), "path": .string("a.txt"), "kind": .string("text"),
                "text": .string(text), "saved": disk["text"], "version": disk["version"], "bom": disk["bom"], "line_ending": disk["line_ending"]])
            _ = try await core.call("editor.drafts.import", params: .object(["legacy": .string(String(data: try JSONEncoder().encode(legacy), encoding: .utf8)!)]))
            let root = try ContentFileRoot(directory: alias)
            let entry = try await core.call("editor.drafts.document", params: .object(["directory": .string(root.protocolDirectory), "path": .string("a.txt")]))
            let restored = try XCTUnwrap(entry["draft"]["text"].string)
            XCTAssertEqual(Data(restored.utf8), Data(text.utf8))
            XCTAssertEqual(entry["draft"]["directory"].string, alias.path)
            let rewritten = try await core.call("editor.drafts.document", params: .object(["directory": .string(root.resolvedDirectory.path), "path": .string("a.txt")]))
            XCTAssertEqual(rewritten, .null)
            XCTAssertEqual(try Data(contentsOf: file), original)
            let replacement = base.appendingPathComponent("replacement")
            try FileManager.default.createDirectory(at: replacement, withIntermediateDirectories: true)
            let external = Data("EXTERNAL\r\n".utf8)
            try external.write(to: replacement.appendingPathComponent("a.txt"))
            try FileManager.default.removeItem(at: alias)
            try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: replacement)
            let pinned = try await core.call("files.read", params: .object(["directory": .string(root.resolvedDirectory.path), "path": .string("a.txt")]))
            XCTAssertEqual(pinned["text"], disk["text"])
            XCTAssertNil(root.relativePath(for: alias.appendingPathComponent("a.txt")))
            XCTAssertEqual(try Data(contentsOf: replacement.appendingPathComponent("a.txt")), external)
            await core.close()
        } catch { await core.close(); throw error }
    }
}
