import Foundation
import XCTest
@testable import UTermBridge

final class JavaComponentContractTests: XCTestCase {
    func testActualCABIJavaCatalogAndStaleOperationPreserveWorkspace() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("shared-state-v1")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let core = try await CoreBridge.open(root: root)
        let defaults = try await core.call("state.defaults")
        let before = try await core.call("migration.import", params: .object(["workspace": defaults["workspace"], "settings": defaults["settings"], "legacy": .object([:])]))
        let response = try await core.call("java.components.status")
        let catalog = try JSONDecoder().decode(CoreJavaComponentCatalog.self, from: JSONEncoder().encode(response["catalog"]))
        XCTAssertEqual(catalog.items.map(\.id).sorted(), ["jdk-11", "jdk-17", "jdk-21", "jdk-8", "maven"])
        XCTAssertFalse(catalog.busy)
        XCTAssertEqual(response["operation"], .null)
        XCTAssertEqual(response["progress"], .null)
        for item in catalog.items {
            XCTAssertGreaterThan(item.size, 1_000_000)
            XCTAssertLessThan(item.size, 400_000_000)
            XCTAssertEqual(item.downloaded, 0)
            XCTAssertFalse(item.installed)
        }
        do {
            _ = try await core.call("java.components.cancel", params: .object(["id": .string("stale"), "generation": .string("stale")]))
            XCTFail("Stale Java cancellation must fail")
        } catch let failure as BridgeFailure { XCTAssertEqual(failure.code, "JAVA_OPERATION_STALE") }
        let after = try await core.call("snapshot.read")
        XCTAssertEqual(after, before)
        await core.close()
    }

    func testGeneratedByteCountsRetainNumericBoundsAndRejectOverflow() throws {
        let bytes = Data(#"{"id":"maven","received":4294967295,"total":4294967295}"#.utf8)
        let progress = try JSONDecoder().decode(CoreJavaComponentProgress.self, from: bytes)
        XCTAssertEqual(progress.received, UInt32.max)
        XCTAssertEqual(progress.total, UInt32.max)
        let roundTrip = try JSONDecoder().decode(CoreJavaComponentProgress.self, from: JSONEncoder().encode(progress))
        XCTAssertEqual(roundTrip.received, progress.received)
        XCTAssertThrowsError(try JSONDecoder().decode(CoreJavaComponentProgress.self, from: Data(#"{"id":"maven","received":4294967296,"total":4294967296}"#.utf8)))
    }
}
