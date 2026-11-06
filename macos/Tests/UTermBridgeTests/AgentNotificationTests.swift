import Foundation
import XCTest
@testable import UTermBridge

final class AgentNotificationTests: XCTestCase {
    private func event(_ id: String, _ sequence: UInt64, _ kind: String) throws -> CoreActivityEvent {
        try JSONDecoder().decode(CoreActivityEvent.self, from: Data("{\"id\":\"\(id)\",\"sequence\":\(sequence),\"kind\":\"\(kind)\",\"source\":\"hook\"}".utf8))
    }
    func testReplayDuplicateAndEveryUInt64Digit() throws {
        var gate = AgentNotificationGate()
        let first = try event("historical", 9_007_199_254_740_992, "done")
        XCTAssertNil(gate.consume(session: "a", generation: "g", state: "done", events: [first], replay: true))
        let next = try event("new-turn", 9_007_199_254_740_993, "done")
        let ticket = try XCTUnwrap(gate.consume(session: "a", generation: "g", state: "done", events: [next], replay: false))
        XCTAssertTrue(gate.current(ticket))
        XCTAssertNil(gate.consume(session: "a", generation: "g", state: "done", events: [next], replay: false))
        XCTAssertTrue(gate.current(ticket))
        let maximum = try event("last-turn", UInt64.max, "waiting")
        let last = try XCTUnwrap(gate.consume(session: "a", generation: "g", state: "waiting", events: [maximum], replay: false))
        XCTAssertFalse(gate.current(ticket)); XCTAssertTrue(gate.current(last))
        XCTAssertNil(gate.consume(session: "a", generation: "g", state: "waiting", events: [next], replay: false))
    }
    func testNewerWorkGenerationClosureAndSessionIsolationInvalidatePermissionResults() throws {
        var gate = AgentNotificationGate()
        let done = try event("done", 1, "done")
        let a = try XCTUnwrap(gate.consume(session: "a", generation: "g", state: "done", events: [done], replay: false))
        let b = try XCTUnwrap(gate.consume(session: "b", generation: "g", state: "done", events: [done], replay: false))
        XCTAssertNil(gate.consume(session: "a", generation: "g", state: "working", events: [], replay: false))
        XCTAssertFalse(gate.current(a)); XCTAssertTrue(gate.current(b))
        XCTAssertNil(gate.consume(session: "b", generation: "replacement", state: "idle", events: [], replay: true))
        XCTAssertFalse(gate.current(b))
        let c = try XCTUnwrap(gate.consume(session: "c", generation: "g", state: "done", events: [done], replay: false))
        gate.retain(["a", "b"]); XCTAssertFalse(gate.current(c))
        let d = try XCTUnwrap(gate.consume(session: "d", generation: "g", state: "done", events: [done], replay: false))
        gate.cancel("d"); XCTAssertFalse(gate.current(d))
        XCTAssertNil(gate.consume(session: "a", generation: "g", state: "working", events: [try event("old-completion", 2, "done")], replay: false))
    }
}
