import Foundation
import XCTest
@testable import UTermBridge

final class NativeApplicationProfileTests: XCTestCase {
    private let support = URL(fileURLWithPath: "/Users/test/Library/Application Support")
    private let temporary = FileManager.default.temporaryDirectory
    func testPersonalIdentityHasSeparateStoreAndNoNetworkUpdates() throws {
        let profile = NativeApplicationProfile(mode: .personal, identifier: NativeApplicationProfile.personalIdentifier)
        XCTAssertEqual(try profile.dataRoot(applicationSupport: support, temporaryDirectory: temporary).path, support.appendingPathComponent("sh.uterm.desktop.personal/shared-state-v1").path)
        XCTAssertFalse(profile.networkUpdatesAllowed)
        XCTAssertFalse(profile.personalFixture)
        XCTAssertThrowsError(try profile.dataRoot(applicationSupport: support, temporaryDirectory: temporary, qaOverride: temporary.appendingPathComponent("uterm-native-qa-wrong").path))
        let poisoned = NativeApplicationProfile(mode: .personal, identifier: NativeApplicationProfile.personalIdentifier, embeddedQARoot: "/tmp/uterm-native-qa-wrong")
        XCTAssertThrowsError(try poisoned.dataRoot(applicationSupport: support, temporaryDirectory: temporary))
    }
    func testCannotTurnPersonalExecutableIntoOrdinaryQAOrStableClient() {
        for identifier in ["sh.uterm.desktop", "sh.uterm.desktop.qa.native", "unknown"] {
            XCTAssertThrowsError(try NativeApplicationProfile(mode: .personal, identifier: identifier).dataRoot(applicationSupport: support, temporaryDirectory: temporary))
        }
        XCTAssertThrowsError(try NativeApplicationProfile(mode: .qa, identifier: NativeApplicationProfile.personalIdentifier).dataRoot(applicationSupport: support, temporaryDirectory: temporary))
    }
    func testPersonalProfileCannotFollowSymlinksIntoStableData() throws {
        let folder = temporary.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let stable = folder.appendingPathComponent("stable")
        try FileManager.default.createDirectory(at: stable, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: folder.appendingPathComponent(NativeApplicationProfile.personalIdentifier), withDestinationURL: stable)
        XCTAssertThrowsError(try NativeApplicationProfile(mode: .personal, identifier: NativeApplicationProfile.personalIdentifier).dataRoot(applicationSupport: folder, temporaryDirectory: temporary))
    }
    func testPackagedPersonalFixtureStaysInsideEmbeddedTemporaryRoot() throws {
        let root = temporary.appendingPathComponent("uterm-native-qa-personal-" + UUID().uuidString)
        let profile = NativeApplicationProfile(mode: .personal, identifier: "sh.uterm.desktop.qa.native.personal." + UUID().uuidString, embeddedQARoot: root.path)
        XCTAssertTrue(profile.personalFixture)
        XCTAssertEqual(try profile.dataRoot(applicationSupport: support, temporaryDirectory: temporary), root.resolvingSymlinksInPath().appendingPathComponent("shared-state-v1", isDirectory: true))
        XCTAssertThrowsError(try profile.dataRoot(applicationSupport: support, temporaryDirectory: temporary, qaOverride: root.appendingPathComponent("other").path))
        let escaped = NativeApplicationProfile(mode: .personal, identifier: profile.identifier, embeddedQARoot: "/Users/test/uterm-native-qa-escape")
        XCTAssertThrowsError(try escaped.dataRoot(applicationSupport: support, temporaryDirectory: temporary))
    }
    func testExistingQARulesAndUpdateFixturesRemainIsolated() throws {
        let qa = NativeApplicationProfile(mode: .qa, identifier: "sh.uterm.desktop.qa.native")
        XCTAssertTrue(qa.networkUpdatesAllowed)
        XCTAssertEqual(try qa.dataRoot(applicationSupport: support, temporaryDirectory: temporary), support.appendingPathComponent("sh.uterm.desktop.qa.native/shared-state-v1", isDirectory: true))
        XCTAssertThrowsError(try qa.dataRoot(applicationSupport: support, temporaryDirectory: temporary, qaOverride: support.path))
        let fixture = NativeApplicationProfile(mode: .qa, identifier: "sh.uterm.desktop.qa.native.update.test", embeddedQARoot: temporary.appendingPathComponent("uterm-native-qa-update").path)
        XCTAssertNoThrow(try fixture.dataRoot(applicationSupport: support, temporaryDirectory: temporary))
        XCTAssertThrowsError(try fixture.dataRoot(applicationSupport: support, temporaryDirectory: temporary, qaOverride: temporary.appendingPathComponent("uterm-native-qa-other").path))
    }
}
