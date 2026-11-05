import Foundation
import XCTest
@testable import UTermBridge

final class CoreBridgeTests: XCTestCase {
    func testSSHProgressKeepsExactUnsignedCounts() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("shared/contracts/ssh-progress-v1.json"))) as? [String: Any]
        let values = try XCTUnwrap(fixture?["progress"] as? [[String: String]])
        XCTAssertEqual(values.map { $0["completed"] ?? "" }, ["9007199254740993", "18446744073709551615"])
        for row in values {
            let value = try JSONDecoder().decode(CoreSshProgress.self, from: JSONSerialization.data(withJSONObject: row))
            XCTAssertEqual(String(try XCTUnwrap(UInt64(value.completed))), row["completed"])
            XCTAssertEqual(UInt64(value.total), UInt64.max)
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: String]
            XCTAssertEqual(encoded, row)
        }
    }

    func testSharedSSHConfigurationContractsThroughCABI() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let core = try await CoreBridge.open(root: root)
        let info = try await core.call("ssh.info")
        let typedInfo = try JSONDecoder().decode(CoreSshInfo.self, from: JSONEncoder().encode(info))
        XCTAssertTrue(typedInfo.available)
        let resolved = try await core.call("ssh.resolve", params: .object(["connection": .object([
            "connection_id": .string("qa"), "workspace_id": .string("local"),
            "name": .string("QA"), "host": .string("127.0.0.1"), "os": .string("posix"),
            "root": .string(""), "mode": .string("direct"), "port": .number(2222),
            "username": .string("qa-user")
        ])]))
        let typed = try JSONDecoder().decode(CoreSshResolution.self, from: JSONEncoder().encode(resolved))
        XCTAssertEqual(typed.hostname, "127.0.0.1")
        XCTAssertEqual(typed.username, "qa-user")
        XCTAssertEqual(typed.port, "2222")
        await core.close()
    }
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

    func testSharedGitAndWorktreeContractsThroughCABI() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let repository = root.appendingPathComponent("repository")
        try FileManager.default.createDirectory(at: repository, withIntermediateDirectories: true)
        func git(_ arguments: [String]) throws {
            let process = Process(), output = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["-c", "core.hooksPath=" + root.appendingPathComponent("no-hooks").path, "-C", repository.path] + arguments
            process.standardOutput = output
            process.standardError = output
            try process.run()
            let bytes = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw BridgeFailure(code: "GIT_FIXTURE", message: String(decoding: bytes, as: UTF8.self)) }
        }
        try git(["init", "--initial-branch=main"])
        let file = repository.appendingPathComponent("中文.txt")
        try Data("before\n".utf8).write(to: file)
        try git(["add", "--all"])
        try git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--no-gpg-sign", "-m", "isolated C ABI Git fixture"])
        let core = try await CoreBridge.open(root: root.appendingPathComponent("store"))
        let defaults = try await core.call("state.defaults")
        let imported = try await core.call("migration.import", params: .object([
            "workspace": defaults["workspace"], "settings": defaults["settings"], "legacy": .object([:])
        ]))
        let project = try await core.call("project.open", params: .object([
            "id": .string("ffi-git-project"), "name": .string("Git QA"), "directory": .string(repository.path),
            "workspaceId": .string("local"), "expectedRevision": imported["revision"]
        ]))
        let context = try await core.projectContext(expectedRevision: project["revision"].string!)
        XCTAssertEqual(context.projectId, "ffi-git-project")
        XCTAssertNil(context.worktreeId)
        XCTAssertEqual(context.directory.map { Data($0.utf8) }, Data(repository.path.utf8))
        let snapshot = try await core.call("git.snapshot", params: .object(["directory": .string(repository.path)]))
        let typed = try JSONDecoder().decode(CoreGitSnapshot.self, from: JSONEncoder().encode(snapshot))
        let head = try XCTUnwrap(typed.head)
        XCTAssertEqual(typed.branch, "main")
        let changed = "after 中文 e\u{301}\n"
        try Data(changed.utf8).write(to: file)
        let reply = try await core.call("git.diff", params: .object([
            "directory": .string(repository.path), "path": .string("中文.txt"), "mode": .string("working"), "reference": .null
        ]))
        let diff = try JSONDecoder().decode(CoreGitDiff.self, from: JSONEncoder().encode(reply))
        XCTAssertNotNil(Data(diff.text.utf8).range(of: Data("after 中文 e\u{301}".utf8)))
        XCTAssertEqual(try Data(contentsOf: file), Data(changed.utf8))
        let worktree = root.appendingPathComponent("worktree-中文")
        let created = try await core.call("git.worktrees.create", params: .object([
            "directory": .string(repository.path), "reference": .string("HEAD"), "branch": .string("qa/worktree"),
            "path": .string(worktree.path), "oid": .string(head)
        ]))
        let entries = try JSONDecoder().decode([CoreGitWorktree].self, from: JSONEncoder().encode(created))
        XCTAssertEqual(entries.first?.branch, "qa/worktree")
        let favoriteName = "refs/heads/中文-e\u{301}-𝄞"
        let favoriteSource = String(decoding: try JSONEncoder().encode([favoriteName]), as: UTF8.self)
        let favoriteResult = try await core.call("git.favorites.import", params: .object(["directory": .string(repository.path), "legacy": .string(favoriteSource)]))
        let typedFavorites = try JSONDecoder().decode(CoreGitFavorites.self, from: JSONEncoder().encode(favoriteResult))
        XCTAssertNotNil(typedFavorites.revision)
        XCTAssertEqual(Array(typedFavorites.references[0].utf8), Array(favoriteName.utf8))
        XCTAssertEqual(Array(typedFavorites.references[0].utf16), Array(favoriteName.utf16))
        let writtenFavorites = try await core.call("git.favorites.write", params: .object(["directory": .string(worktree.path), "expectedRevision": favoriteResult["revision"], "references": .array([])]))
        let readFavorites = try await core.call("git.favorites.read", params: .object(["directory": .string(repository.path)]))
        XCTAssertEqual(writtenFavorites, readFavorites)
        do {
            _ = try await core.call("git.favorites.write", params: .object(["directory": .string(repository.path), "expectedRevision": favoriteResult["revision"], "references": .array([.string(favoriteName)])]))
            XCTFail("A stale favorite write cannot replace newer shared references")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "CONFLICT") }
        let retained = worktree.appendingPathComponent("retained.txt")
        let favoriteCatalog = try await core.gitFavoriteRecoveryCatalog()
        let favoriteBackup = try XCTUnwrap(favoriteCatalog.backups.first)
        let favoritePreview = try await core.gitFavoriteRecoveryPreview(revision: favoriteBackup)
        let previewEntry = try XCTUnwrap(favoritePreview.document.repositories.values.first)
        XCTAssertEqual(Array(previewEntry.references[0].utf8), Array(favoriteName.utf8))
        let oldFavoriteSource = try await core.call("git.favorites.recovery.source", params: .object(["revision": .string(try XCTUnwrap(typedFavorites.sourceDigest))]))
        XCTAssertEqual(Array(try XCTUnwrap(oldFavoriteSource.string).utf8), Array(favoriteSource.utf8))
        let favoriteRestored = try await core.call("git.favorites.recovery.restore", params: .object(["revision": .string(favoriteBackup), "expectedRevision": .string(try XCTUnwrap(favoriteCatalog.currentRevision)), "expectedMissing": .bool(false)]))
        let typedRestored = try JSONDecoder().decode(CoreGitFavoriteRecoverySnapshot.self, from: JSONEncoder().encode(favoriteRestored))
        XCTAssertEqual(typedRestored.revision, favoriteBackup)
        XCTAssertEqual(Array(try XCTUnwrap(typedRestored.document.repositories.values.first).references[0].utf8), Array(favoriteName.utf8))
        try Data(changed.utf8).write(to: retained)
        do {
            _ = try await core.call("git.worktrees.delete", params: .object(["directory": .string(repository.path), "path": .string(worktree.path)]))
            XCTFail("Dirty worktrees cannot be removed")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "GIT_ERROR") }
        XCTAssertEqual(try Data(contentsOf: retained), Data(changed.utf8))
        try FileManager.default.removeItem(at: retained)
        _ = try await core.call("git.worktrees.delete", params: .object(["directory": .string(repository.path), "path": .string(worktree.path)]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: worktree.path))
        await core.close()
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
