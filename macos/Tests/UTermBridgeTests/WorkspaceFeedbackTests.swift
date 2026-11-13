import XCTest
@testable import UTermBridge

final class WorkspaceFeedbackTests: XCTestCase {
    func testReadRecoveryRetainsAnIdenticalOperationError() {
        var feedback = WorkspaceFeedback()
        feedback.snapshotFailed("WRITER_BUSY: Another writer")
        feedback.operation("WRITER_BUSY: Another writer")
        feedback.snapshotSucceeded()
        XCTAssertEqual(feedback.message, "WRITER_BUSY: Another writer")
    }

    func testBackgroundReadFailureDoesNotReplaceAConflict() {
        var feedback = WorkspaceFeedback()
        feedback.operation("CONFLICT: Changed revision")
        feedback.snapshotFailed("WRITER_BUSY: Another writer")
        feedback.snapshotSucceeded()
        XCTAssertEqual(feedback.message, "CONFLICT: Changed revision")
    }

    func testReadOnlyFailureClearsAfterRecovery() {
        var feedback = WorkspaceFeedback()
        feedback.snapshotFailed("WRITER_BUSY")
        feedback.snapshotFailed("IO_ERROR")
        XCTAssertEqual(feedback.message, "IO_ERROR")
        feedback.snapshotSucceeded()
        XCTAssertEqual(feedback.message, "")
    }

    func testExplicitClearAllowsLaterReadFeedback() {
        var feedback = WorkspaceFeedback()
        feedback.operation("CONFLICT")
        feedback.operation("")
        feedback.snapshotFailed("WRITER_BUSY")
        XCTAssertEqual(feedback.message, "WRITER_BUSY")
        feedback.snapshotSucceeded()
        XCTAssertEqual(feedback.message, "")
    }
}
