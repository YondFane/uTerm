import Foundation
import XCTest
@testable import UTermBridge

final class CoreBridgeTests: XCTestCase {
    func testImportEventsConflictAndReopen() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let core = try await CoreBridge.open(root: root)
        let defaults = try await core.call("state.defaults")
        let delivered = expectation(description: "Snapshot invalidation crosses the C ABI")
        let event = Task<CoreEvent?, Never> { for await event in core.events { delivered.fulfill(); return event }; return nil }
        let initial = try await core.call("migration.import", params: .object([
            "workspace": defaults["workspace"], "settings": defaults["settings"], "legacy": .object([:])
        ]))
        await fulfillment(of: [delivered], timeout: 5)
        event.cancel()
        let received = await event.value
        XCTAssertEqual(received?.revision, initial["revision"].string)
        let changed = try await core.call("settings.patch", params: .object([
            "expectedRevision": initial["revision"], "patch": .object(["fontSize": .number(18)])
        ]))
        XCTAssertNotEqual(changed["revision"], initial["revision"])
        do {
            _ = try await core.call("settings.patch", params: .object([
                "expectedRevision": initial["revision"], "patch": .object(["fontSize": .number(19)])
            ]))
            XCTFail("A stale revision must fail")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "CONFLICT") }
        await core.close()
        let reopened = try await CoreBridge.open(root: root)
        let snapshot = try await reopened.call("snapshot.read")
        XCTAssertEqual(snapshot["document"]["settings"]["fontSize"], .number(18))
        await reopened.close()
    }

    func testNullAndEmptyValuesRoundTrip() throws {
        let value: JSONValue = .object(["null": .null, "empty": .string(""), "array": .array([])])
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)), value)
    }

    func testDraftBackupPreviewAndExplicitMissingRestoreThroughCABI() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let core = try await CoreBridge.open(root: root)
        let text = "recovery 中文 e\u{301} 𝄞\u{0}\r\n"
        let draft: JSONValue = .object([
            "directory": .string("/qa/editor"), "path": .string("recovery.txt"), "kind": .string("text"),
            "text": .string(text), "saved": .string("disk\r\n"), "version": .string(String(repeating: "a", count: 64)),
            "line_ending": .string("\r\n"), "bom": .bool(true)
        ])
        let raw = String(decoding: try JSONEncoder().encode(draft), as: UTF8.self)
        let first = try await core.call("editor.drafts.import", params: .object(["legacy": .string(raw)]))
        _ = try await core.call("editor.drafts.remove", params: .object([
            "expectedRevision": first["revision"], "directory": .string("/qa/editor"), "path": .string("recovery.txt")
        ]))
        try FileManager.default.removeItem(at: root.appendingPathComponent("editor-drafts-v1.json"))
        let catalog = try await core.editorRecoveryCatalog()
        XCTAssertNil(catalog.currentRevision)
        XCTAssertTrue(catalog.backups.contains(first["revision"].string!))
        XCTAssertTrue(catalog.sources.contains(first["document"]["sourceDigest"].string!))
        do {
            _ = try await core.call("editor.drafts.import", params: .object(["legacy": .null]))
            XCTFail("Missing storage with recovery copies cannot be automatically reimported")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "MISSING_DRAFTS") }
        let typed = try await core.editorRecoveryPreview(revision: first["revision"].string!)
        XCTAssertEqual(Array(typed.document.drafts[0].text.utf8), Array(text.utf8))
        XCTAssertEqual(Array(typed.document.drafts[0].text.utf16), Array(text.utf16))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("editor-drafts-v1.json").path))
        do {
            _ = try await core.call("editor.drafts.recovery.restoreMissing", params: .object(["revision": first["revision"], "expectedMissing": .bool(false)]))
            XCTFail("Missing restore requires acknowledgement")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "INVALID_ARGUMENT") }
        let restored = try await core.call("editor.drafts.recovery.restoreMissing", params: .object(["revision": first["revision"], "expectedMissing": .bool(true)]))
        XCTAssertEqual(restored, first)
        let listed = try await core.editorDrafts()
        XCTAssertEqual(Array(listed.drafts[0].draft.text.utf8), Array(text.utf8))
        do {
            _ = try await core.call("editor.drafts.recovery.restoreMissing", params: .object(["revision": first["revision"], "expectedMissing": .bool(true)]))
            XCTFail("A replacement store cannot be overwritten")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "CONFLICT") }
        await core.close()
    }

    func testEditorDraftBytesMetadataStaleWritesAndReopenThroughCABI() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let core = try await CoreBridge.open(root: root)
        let text = "中文 e\u{301} 𝄞\u{0}\r\n"
        let draft: JSONValue = .object([
            "directory": .string("/qa/editor"), "path": .string("中文.md"), "kind": .string("text"),
            "text": .string(text), "saved": .string("saved\r\n"), "version": .string(String(repeating: "a", count: 64)),
            "line_ending": .string("\r\n"), "bom": .bool(true)
        ])
        let raw = " \n" + String(decoding: try JSONEncoder().encode(draft), as: UTF8.self) + "\n"
        let imported = try await core.call("editor.drafts.import", params: .object(["legacy": .string(raw)]))
        let initial = try JSONDecoder().decode(CoreEditorDraftSnapshot.self, from: JSONEncoder().encode(imported))
        XCTAssertEqual(initial.document.schemaVersion, 1)
        XCTAssertEqual(initial.document.drafts.count, 1)
        XCTAssertEqual(Array(initial.document.drafts[0].text.utf8), Array(text.utf8))
        XCTAssertEqual(Array(initial.document.drafts[0].text.utf16), Array(text.utf16))
        XCTAssertEqual(initial.document.drafts[0].line_ending, "\r\n")
        XCTAssertTrue(initial.document.drafts[0].bom)
        guard case .object(var second) = draft else { return XCTFail("Missing typed draft") }
        second["path"] = .string("second.md")
        let written = try await core.call("editor.drafts.put", params: .object([
            "expectedRevision": .string(initial.revision), "draft": .object(second)
        ]))
        let updated = try JSONDecoder().decode(CoreEditorDraftSnapshot.self, from: JSONEncoder().encode(written))
        XCTAssertEqual(updated.document.drafts.count, 2)
        do {
            _ = try await core.call("editor.drafts.remove", params: .object([
                "expectedRevision": .string(initial.revision), "directory": .string("/qa/editor"), "path": .string("中文.md")
            ]))
            XCTFail("A stale removal must retain both documents")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "CONFLICT") }
        await core.close()
        let reopened = try await CoreBridge.open(root: root)
        let current = try await reopened.call("editor.drafts.read")
        let snapshot = try JSONDecoder().decode(CoreEditorDraftSnapshot.self, from: JSONEncoder().encode(current))
        XCTAssertEqual(snapshot.revision, updated.revision)
        XCTAssertEqual(snapshot.document.drafts.count, 2)
        XCTAssertTrue(snapshot.document.drafts.allSatisfy { Array($0.text.utf8) == Array(text.utf8) })
        await reopened.close()
    }
}
