import Foundation
import XCTest
@testable import UTermBridge

final class NativeUpdateConfigurationTests: XCTestCase {
    private let key = Data(repeating: 7, count: 32).base64EncodedString()
    func testLoopbackNeedsQAAndConfigurationRejectsPrivateURLsAndMalformedKeys() throws {
        let local = URL(string: "http://127.0.0.1:12345/stable-arm64.xml")!
        XCTAssertThrowsError(try NativeUpdateConfiguration(feed: local, channel: "stable", architecture: "arm64", publicKey: key, qa: false))
        _ = try NativeUpdateConfiguration(feed: local, channel: "stable", architecture: "arm64", publicKey: key, qa: true)
        for url in ["http://example.invalid/appcast.xml", "https://example.invalid/appcast.xml", "file:///tmp/appcast.xml", "https://user:private@example.invalid/appcast.xml", "https://example.invalid/appcast.xml#private"] {
            XCTAssertThrowsError(try NativeUpdateConfiguration(feed: URL(string: url)!, channel: "stable", architecture: "arm64", publicKey: key, qa: true))
        }
        XCTAssertThrowsError(try NativeUpdateConfiguration(feed: local, channel: "unknown", architecture: "arm64", publicKey: key, qa: true))
        XCTAssertThrowsError(try NativeUpdateConfiguration(feed: local, channel: "stable", architecture: "x64", publicKey: key, qa: true))
        XCTAssertThrowsError(try NativeUpdateConfiguration(feed: local, channel: "stable", architecture: "arm64", publicKey: "bad", qa: true))
    }
    func testArchiveCannotCrossPlatformArchitectureChannelOrOrigin() throws {
        let config = try NativeUpdateConfiguration(feed: URL(string: "https://updates.example.invalid/stable-arm64.xml")!, channel: "stable", architecture: "arm64", publicKey: key, qa: false)
        let archive = URL(string: "https://updates.example.invalid/stable-arm64.zip")!
        try config.validateArchive(archive, platform: "macos", architecture: "arm64", channel: nil)
        for (url, platform, architecture, channel) in [
            (archive, "windows", "arm64", "stable"), (archive, "macos", "x86_64", "stable"),
            (archive, "macos", "arm64", "preview"), (archive, "macos", "", "stable"),
            (URL(string: "https://other.example.invalid/update.zip")!, "macos", "arm64", "stable"),
            (URL(string: "https://updates.example.invalid/update.pkg")!, "macos", "arm64", "stable")
        ] { XCTAssertThrowsError(try config.validateArchive(url, platform: platform, architecture: architecture, channel: channel)) }
    }
}
