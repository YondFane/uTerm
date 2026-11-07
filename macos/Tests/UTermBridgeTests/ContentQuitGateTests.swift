import Foundation
import XCTest
@testable import UTermBridge

final class ContentQuitGateTests: XCTestCase {
    @MainActor
    func testMatchingReadyRefusalAndStaleReply() async throws {
        let gate = ContentQuitGate()
        var old = ""
        let ready = try await gate.prepare { token in
            old = token
            XCTAssertThrowsError(try gate.respond(token: "other", ready: true))
            try gate.respond(token: token, ready: true)
        }
        XCTAssertTrue(ready)
        XCTAssertThrowsError(try gate.respond(token: old, ready: true))
        let refused = try await gate.prepare { token in
            XCTAssertNotEqual(token, old)
            XCTAssertThrowsError(try gate.respond(token: old, ready: true))
            try gate.respond(token: token, ready: false)
        }
        XCTAssertFalse(refused)
    }

    @MainActor
    func testTimeoutReloadAndSendFailureNeverConfirmSaving() async throws {
        let gate = ContentQuitGate()
        do {
            _ = try await gate.prepare(timeout: .milliseconds(10)) { _ in }
            XCTFail("Timeout cannot confirm saving")
        } catch { XCTAssertEqual((error as? BridgeFailure)?.code, "QUIT_TIMEOUT") }
        do {
            _ = try await gate.prepare { _ in gate.invalidate() }
            XCTFail("Reload cannot confirm saving")
        } catch { XCTAssertEqual((error as? BridgeFailure)?.code, "CONTENT_CHANGED") }
        do {
            _ = try await gate.prepare { _ in throw BridgeFailure(code: "SEND_FAILED", message: "Web content failed") }
            XCTFail("Failed delivery cannot confirm saving")
        } catch { XCTAssertEqual((error as? BridgeFailure)?.code, "SEND_FAILED") }
        let recovered = try await gate.prepare { token in try gate.respond(token: token, ready: true) }
        XCTAssertTrue(recovered)
    }

    @MainActor
    func testCancellationCannotCompleteTheNextRequest() async throws {
        let gate = ContentQuitGate()
        var started = false
        let task = Task { @MainActor in try await gate.prepare { _ in started = true } }
        while !started { await Task.yield() }
        do {
            _ = try await gate.prepare { _ in XCTFail("Busy request must not dispatch") }
            XCTFail("Concurrent prepare cannot replace the active request")
        } catch { XCTAssertEqual((error as? BridgeFailure)?.code, "QUIT_BUSY") }
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled request cannot confirm saving") }
        catch { XCTAssertTrue(error is CancellationError) }
        let replacement = try await gate.prepare { token in try gate.respond(token: token, ready: true) }
        XCTAssertTrue(replacement)
    }
}
