import Foundation
import XCTest
@testable import UTermBridge

final class WorkspaceRefreshCycleTests: XCTestCase {
    @MainActor private final class Gate {
        private var continuation: CheckedContinuation<Void, Never>?
        private var released = false
        func wait() async {
            if released { return }
            await withCheckedContinuation { continuation = $0 }
        }
        func release() { released = true; continuation?.resume(); continuation = nil }
    }

    @MainActor
    func testOverlappingCallersWaitForTheNewestSnapshotAndCommands() async {
        await overlap(cancelFirst: false)
    }

    @MainActor
    func testCancellingOneCallerDoesNotAbandonTheOtherRead() async {
        await overlap(cancelFirst: true)
    }

    @MainActor
    private func overlap(cancelFirst: Bool) async {
        let cycle = WorkspaceRefreshCycle(), firstGate = Gate(), secondGate = Gate()
        let firstStarted = expectation(description: "first read starts")
        let secondStarted = expectation(description: "newest read starts")
        let firstDone = expectation(description: "first caller finishes")
        let secondDone = expectation(description: "second caller finishes")
        var reads = 0, snapshot = 0, commands = 0, active = 0, maximumActive = 0
        var firstReturned = false, secondReturned = false
        let read: @MainActor () async -> Void = {
            reads += 1; active += 1; maximumActive = max(maximumActive, active)
            let version = reads; snapshot = version
            if version == 1 { firstStarted.fulfill(); await firstGate.wait() }
            else if version == 2 { secondStarted.fulfill(); await secondGate.wait() }
            commands = version; active -= 1
        }
        let first = Task { @MainActor in
            await cycle.run(read); firstReturned = true; firstDone.fulfill()
        }
        await fulfillment(of: [firstStarted], timeout: 2)
        let newest = cycle.enqueue(read)
        let second = Task { @MainActor in
            await newest.value; secondReturned = true; secondDone.fulfill()
        }
        defer { firstGate.release(); secondGate.release(); first.cancel(); second.cancel() }
        if cancelFirst { first.cancel() }
        firstGate.release()
        await fulfillment(of: [secondStarted], timeout: 2)
        XCTAssertEqual(snapshot, 2); XCTAssertEqual(commands, 1)
        XCTAssertFalse(firstReturned); XCTAssertFalse(secondReturned)
        secondGate.release()
        await fulfillment(of: [firstDone, secondDone], timeout: 2)
        XCTAssertEqual(reads, 2); XCTAssertEqual(maximumActive, 1)
        XCTAssertEqual(snapshot, commands); XCTAssertEqual(commands, 2)
        await cycle.run { reads += 1; commands = reads }
        XCTAssertEqual(reads, 3); XCTAssertEqual(commands, 3)
    }
}
