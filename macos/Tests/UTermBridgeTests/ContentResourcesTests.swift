import Foundation
import XCTest
@testable import UTermBridge

final class ContentResourcesTests: XCTestCase {
    func testOnlyManifestResourcesLoadAndOriginsPathsQueriesAndLinksAreRejected() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("assets"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("<html>trusted</html>".utf8).write(to: directory.appendingPathComponent("native-content.html"))
        try Data("export const ready = true;".utf8).write(to: directory.appendingPathComponent("assets/entry.js"))
        try Data("outside".utf8).write(to: directory.appendingPathComponent("outside.txt"))
        try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent("assets/linked.js"), withDestinationURL: directory.appendingPathComponent("outside.txt"))
        let paths = ["native-content.html", "assets/entry.js", "assets/linked.js"]
        try JSONEncoder().encode(paths).write(to: directory.appendingPathComponent("content-manifest.json"))
        let resources = try ContentResources(root: directory)
        let (bytes, mime) = try resources.data(for: URL(string: "uterm-content://bundle/assets/entry.js")!)
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), "export const ready = true;")
        XCTAssertEqual(mime, "text/javascript")
        for path in ["https://bundle/assets/entry.js", "file:///etc/passwd", "uterm-content://other/assets/entry.js", "uterm-content://bundle:80/assets/entry.js", "uterm-content://user@bundle/assets/entry.js", "uterm-content://bundle/assets/entry.js?root=/", "uterm-content://bundle/assets/entry.js#fragment", "uterm-content://bundle/outside.txt", "uterm-content://bundle/assets/%2e%2e/outside.txt", "uterm-content://bundle/assets/linked.js", "uterm-content://bundle/assets/absent.js"] {
            XCTAssertThrowsError(try resources.data(for: URL(string: path)! ), path)
        }
    }

    func testManifestCannotAuthorizeHostFilesOrNonregularAndOversizedResources() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("assets"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let manifest = directory.appendingPathComponent("content-manifest.json")
        for paths in [["native-content.html", "../secret"], ["native-content.html", "assets/../secret"], ["native-content.html", "/assets/entry.js"], ["index.html"], ["native-content.html", "assets//entry.js"]] {
            try JSONEncoder().encode(paths).write(to: manifest)
            XCTAssertThrowsError(try ContentResources(root: directory))
        }
        try JSONEncoder().encode(["native-content.html", "assets/folder", "assets/large.js"]).write(to: manifest)
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("assets/folder"), withIntermediateDirectories: true)
        let large = directory.appendingPathComponent("assets/large.js")
        XCTAssertTrue(FileManager.default.createFile(atPath: large.path, contents: nil))
        let handle = try FileHandle(forWritingTo: large)
        try handle.truncate(atOffset: UInt64(16 * 1024 * 1024 + 1)); try handle.close()
        let resources = try ContentResources(root: directory)
        XCTAssertThrowsError(try resources.data(for: URL(string: "uterm-content://bundle/assets/folder")!))
        XCTAssertThrowsError(try resources.data(for: URL(string: "uterm-content://bundle/assets/large.js")!))
    }
}
