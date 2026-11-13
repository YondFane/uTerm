import Foundation
import Darwin
import XCTest
import UTermTestSupport
@testable import UTermBridge

final class CoreBridgeTests: XCTestCase {
    func testRollbackArchiveDecodesLatestMultipleDraftsAcrossActualCABI() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("shared-state-v1")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let core = try await CoreBridge.open(root: root)
        let defaults = try await core.call("state.defaults")
        let snapshot = try await core.call("migration.import", params: .object(["workspace": defaults["workspace"], "settings": defaults["settings"], "legacy": .object([:])]))
        let initial = try await core.call("rollback.export", params: .object(["expectedRevision": snapshot["revision"]]))
        let initialArchive = try JSONDecoder().decode(CoreRollbackArchive.self, from: JSONEncoder().encode(initial))
        XCTAssertNil(initialArchive.editor)
        XCTAssertFalse(initialArchive.automaticRestoreAllowed)
        _ = try await core.call("editor.drafts.import", params: .object([:]))
        for (path, text) in [("a.txt", "LATEST 中文 é\r\n"), ("b.txt", "SECOND 🧪\r\n")] {
            _ = try await core.call("editor.drafts.putDocument", params: .object(["expectedDraftRevision": .null, "draft": .object([
                "directory": .string(root.path), "path": .string(path), "kind": .string("text"), "text": .string(text),
                "saved": .string("saved\r\n"), "version": .string(String(repeating: "a", count: 64)), "line_ending": .string("\r\n"), "bom": .bool(true)
            ])]))
        }
        let drafts = try await core.call("editor.drafts.read")
        let value = try await core.call("rollback.export", params: .object(["expectedRevision": snapshot["revision"], "expectedDraftRevision": drafts["revision"]]))
        let archive = try JSONDecoder().decode(CoreRollbackArchive.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(archive.schemaVersion, 1)
        XCTAssertEqual(archive.snapshot.revision, snapshot["revision"].string)
        XCTAssertEqual(archive.editor?.revision, drafts["revision"].string)
        XCTAssertTrue(archive.legacyRequiresDraftChoice)
        XCTAssertNil(archive.legacyValues["uterm.desktop.editorDraft.v1"])
        XCTAssertEqual(archive.legacyDraftCandidates.count, 2)
        let latest = try JSONDecoder().decode(CoreEditorDraft.self, from: Data(archive.legacyDraftCandidates[0].value.utf8))
        XCTAssertEqual(latest.text, "LATEST 中文 é\r\n")
        XCTAssertTrue(latest.bom)
        do {
            _ = try await core.call("rollback.export", params: .object(["expectedRevision": snapshot["revision"], "expectedDraftRevision": .string("stale")]))
            XCTFail("A stale draft archive must fail")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "CONFLICT") }
        await core.close()
    }
    func testGithubPrivateArgumentsKeepTypedFailuresAcrossDetachedCABIRequests() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("shared-state-v1")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let core = try await CoreBridge.open(root: root)
        let cases: [(String, JSONValue)] = [
            ("github.repositories", .object(["directory": .string("."), "executable": .string("other")])),
            ("github.read", .object(["directory": .string("."), "repository": .string("fixture-owner/fixture-repo"), "kind": .string("issue"), "token": .string("not-a-secret")]))
        ]
        for (method, params) in cases {
            do {
                _ = try await Task.detached { try await core.call(method, params: params) }.value
                XCTFail("Private GitHub parameters must fail before running a CLI")
            } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "GITHUB_ARGUMENT") }
        }
        await core.close()
    }

    func testSnapshotReadWaitsForShortWriterContentionWithoutRetryingMutations() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("shared-state-v1")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let core = try await CoreBridge.open(root: root)
        let defaults = try await core.call("state.defaults")
        let initial = try await core.call("migration.import", params: .object(["workspace": defaults["workspace"], "settings": defaults["settings"], "legacy": .object([:])]))
        let descriptor = Darwin.open(root.appendingPathComponent("writer.lock").path, O_RDWR)
        guard descriptor >= 0 else { XCTFail("Could not open the actual canonical writer lock"); return }
        defer { _ = uterm_test_flock(descriptor, LOCK_UN); _ = Darwin.close(descriptor) }
        XCTAssertEqual(uterm_test_flock(descriptor, LOCK_EX | LOCK_NB), 0)
        do {
            _ = try await core.call("snapshot.read")
            XCTFail("The actual writer must block a raw snapshot read")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "WRITER_BUSY") }
        do {
            _ = try await core.call("settings.patch", params: .object(["expectedRevision": initial["revision"], "patch": .object(["language": .string("en")])]))
            XCTFail("A mutation must report busy without replaying itself")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "WRITER_BUSY") }
        let read = Task { try await core.snapshot() }
        let export = Task { try await core.legacyExport() }
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(uterm_test_flock(descriptor, LOCK_UN), 0)
        let value = try await read.value
        XCTAssertEqual(value.revision, initial["revision"].string)
        let exported = try await export.value
        XCTAssertEqual(exported["revision"], initial["revision"])
        let settings = try XCTUnwrap(exported["values"]["uterm.desktop.settings.v1"].string)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: Data(settings.utf8)), defaults["settings"])
        let unchanged = try await core.snapshot()
        XCTAssertEqual(unchanged.revision, initial["revision"].string)
        await core.close()
    }

    func testLegacyExportContentionIsBoundedAndCancellationDoesNotWrite() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("shared-state-v1")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let core = try await CoreBridge.open(root: root)
        let defaults = try await core.call("state.defaults")
        _ = try await core.call("migration.import", params: .object(["workspace": defaults["workspace"], "settings": defaults["settings"], "legacy": .object([:])]))
        let file = root.appendingPathComponent("snapshot-v1.json"), before = try Data(contentsOf: file)
        let descriptor = Darwin.open(root.appendingPathComponent("writer.lock").path, O_RDWR)
        guard descriptor >= 0 else { XCTFail("Could not open the actual canonical writer lock"); return }
        defer { _ = uterm_test_flock(descriptor, LOCK_UN); _ = Darwin.close(descriptor) }
        XCTAssertEqual(uterm_test_flock(descriptor, LOCK_EX | LOCK_NB), 0)
        do {
            _ = try await core.legacyExport()
            XCTFail("A retained writer must exhaust the bounded read attempts")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "WRITER_BUSY") }
        let cancelled = Task { try await core.legacyExport() }
        try await Task.sleep(for: .milliseconds(20)); cancelled.cancel()
        do { _ = try await cancelled.value; XCTFail("A cancelled export must stop") }
        catch is CancellationError { }
        XCTAssertEqual(try Data(contentsOf: file), before)
        XCTAssertEqual(uterm_test_flock(descriptor, LOCK_UN), 0)
        let exported = try await core.legacyExport()
        XCTAssertNotNil(exported["revision"].string)
        XCTAssertEqual(try Data(contentsOf: file), before)
        await core.close()
    }

    func testRedisBinaryAndExactTextAcrossSwiftAndGuardThroughCABI() async throws {
        var repository = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { repository.deleteLastPathComponent() }
        let data = try Data(contentsOf: repository.appendingPathComponent("shared/contracts/redis-values-v1.json"))
        let value = try JSONDecoder().decode(CoreRedisOperation.self, from: data)
        let result = try XCTUnwrap(value.result)
        XCTAssertEqual(result["text"], .string("9223372036854775807 中文🚀"))
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(result["binary"]["data"].string)), Data([0, 255, 127]))
        XCTAssertEqual(result["binary"]["text"], .null)
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(result["member"].string)), Data([255, 0]))
        let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(encoded["result"], result)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let core = try await CoreBridge.open(root: root.appendingPathComponent("shared-state-v1"))
        _ = try await core.call("redis.configure", params: .object(["identifier": .string("sh.uterm.qa.redis-bridge")]))
        let job = try await core.call("redis.operation.start", params: .object(["kind": .string("guard"), "id": .string(UUID().uuidString), "active": .bool(true)]))
        let operation = try JSONDecoder().decode(CoreRedisOperation.self, from: JSONEncoder().encode(job))
        var completed = false
        for _ in 0..<200 {
            let response = try await core.call("redis.operation.read", params: .object(["id": .string(operation.id), "generation": .string(operation.generation), "consume": .bool(true)]))
            if response["state"] == .string("completed") { completed = true; break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(completed)
        let status = try await core.call("redis.status")
        XCTAssertEqual(status["dirty"], .bool(true))
        do {
            _ = try await core.call("redis.operation.read", params: .object(["id": .string(operation.id), "generation": .string("stale"), "consume": .bool(true)]))
            XCTFail("A stale Redis generation must not consume a result")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "REDIS_OPERATION_CHANGED") }
        await core.close()
    }

    func testDatabaseValuesKeepExactTextAcrossSwiftEncoding() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("shared/contracts/database-values-v1.json"))
        let operation = try JSONDecoder().decode(CoreDatabaseOperation.self, from: data)
        let result = try XCTUnwrap(operation.result)
        guard case .array(let rows) = result["rows"], let row = rows.first, case .array(let cells) = row else {
            XCTFail("Database rows must survive the shared contract"); return
        }
        XCTAssertEqual(cells, [.string("9223372036854775807"), .string("12345678901234567890.1234567890"), .object(["binary": .string("AP9/"), "truncated": .bool(false)]), .null, .string("中文🚀")])
        let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(operation))
        XCTAssertEqual(encoded["result"], result)
    }

    func testDatabaseAsynchronousGuardsAndGenerationThroughCABI() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let core = try await CoreBridge.open(root: root.appendingPathComponent("shared-state-v1"))
        _ = try await core.call("database.configure", params: .object(["identifier": .string("sh.uterm.qa.database-bridge")]))
        let started = try await core.call("database.operation.start", params: .object(["kind": .string("guard"), "id": .string("draft"), "dirty": .bool(true)]))
        let operation = try JSONDecoder().decode(CoreDatabaseOperation.self, from: JSONEncoder().encode(started))
        var completed = false
        for _ in 0..<200 {
            let value = try await core.call("database.operation.read", params: .object(["id": .string(operation.id), "generation": .string(operation.generation), "consume": .bool(true)]))
            if value["state"] == .string("completed") { completed = true; break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(completed)
        let status = try await core.call("database.status")
        XCTAssertEqual(status["dirty"], .bool(true))
        do {
            _ = try await core.call("database.operation.read", params: .object(["id": .string(operation.id), "generation": .string("stale"), "consume": .bool(true)]))
            XCTFail("A stale generation must not read another operation")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "DB_OPERATION_CHANGED") }
        await core.close()
    }

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

    func testDatabaseProfileSavePublishesItsActualRevisionThroughCABI() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let core = try await CoreBridge.open(root: root.appendingPathComponent("shared-state-v1"))
        let defaults = try await core.call("state.defaults")
        let initial = try await core.call("migration.import", params: .object(["workspace": defaults["workspace"], "settings": defaults["settings"], "legacy": .object([:])]))
        let delivered = expectation(description: "Database profile save invalidates its Core subscriber")
        let event = Task<CoreEvent?, Never> {
            for await value in core.events where value.revision != initial["revision"].string {
                delivered.fulfill(); return value
            }
            return nil
        }
        let saved = try await core.call("database.profile.save", params: .object([
            "expectedRevision": initial["revision"], "workspaceId": initial["document"]["workspace"]["selectedWorkspace"],
            "config": .object(["id": .string(UUID().uuidString), "name": .string("QA 中文"), "kind": .string("postgresql"), "host": .string("127.0.0.1"), "port": .number(5432), "database": .string("qa"), "username": .string("qa"), "tls": .bool(true), "ca_file": .string(""), "credential_id": .null])
        ]))
        await fulfillment(of: [delivered], timeout: 5)
        event.cancel()
        let received = await event.value
        XCTAssertEqual(received?.kind, "snapshot.changed")
        XCTAssertEqual(received?.revision, saved["revision"].string)
        await core.close()
    }

    func testRedisProfileSavePublishesItsActualRevisionThroughCABI() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let core = try await CoreBridge.open(root: root.appendingPathComponent("shared-state-v1"))
        let defaults = try await core.call("state.defaults")
        let initial = try await core.call("migration.import", params: .object(["workspace": defaults["workspace"], "settings": defaults["settings"], "legacy": .object([:])]))
        let delivered = expectation(description: "Redis profile save invalidates its Core subscriber")
        let event = Task<CoreEvent?, Never> {
            for await value in core.events where value.revision != initial["revision"].string {
                delivered.fulfill(); return value
            }
            return nil
        }
        let profile: JSONValue = .object([
            "id": .string(UUID().uuidString), "name": .string("QA 中文"), "host": .string("127.0.0.1"),
            "port": .number(6379), "db": .number(0), "username": .string("qa"), "tls": .bool(false),
            "ca_file": .string(""), "server_name": .string(""), "ssh_host": .string(""), "credential_id": .null
        ])
        let saved = try await core.call("redis.profile.save", params: .object([
            "expectedRevision": initial["revision"], "workspaceId": initial["document"]["workspace"]["selectedWorkspace"], "config": profile
        ]))
        await fulfillment(of: [delivered], timeout: 5)
        event.cancel()
        let received = await event.value
        XCTAssertEqual(received?.kind, "snapshot.changed")
        XCTAssertEqual(received?.revision, saved["revision"].string)
        await core.close()
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
