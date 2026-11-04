import Foundation
import XCTest
@testable import UTermBridge

final class TerminalPacketTests: XCTestCase {
    private struct Fixture: Decodable { let sequence: String; let header: String }

    private func fixtures() throws -> [Fixture] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: root.appendingPathComponent("shared/fixtures/terminal-precision.json")))
    }

    private func frame(_ header: String, payload: Data = Data([0, 255])) -> Data {
        let bytes = Data(header.utf8)
        var size = UInt32(bytes.count).littleEndian
        var result = withUnsafeBytes(of: &size) { Data($0) }
        result.append(bytes)
        result.append(payload)
        return result
    }

    func testRustFramesAndAcknowledgementsKeepEveryUInt64Digit() throws {
        for fixture in try fixtures() {
            let packet = try TerminalPacket(frame(fixture.header))
            let expected = try XCTUnwrap(UInt64(fixture.sequence))
            XCTAssertEqual(packet.header.sequence, expected)
            XCTAssertEqual(packet.header.agent_events?.first?.sequence, expected)
            let metadata = try JSONSerialization.jsonObject(with: Data(fixture.header.utf8)) as? [String: Any]
            let control = metadata?["input_control"] as? [String: Any]
            XCTAssertEqual(packet.header.input_control?.owned, control?["owned"] as? Bool)
            XCTAssertEqual(packet.header.input_control?.owner, control?["owner"] as? String)
            XCTAssertEqual(packet.bytes, Data([0, 255]))
            let encoded = try JSONEncoder().encode(JSONValue.object(["sequence": .unsigned(packet.header.sequence)]))
            XCTAssertEqual(String(decoding: encoded, as: UTF8.self), "{\"sequence\":\(fixture.sequence)}")
        }
    }

    func testMalformedInputControlCannotEnterTheNativeStream() throws {
        let header = try XCTUnwrap(try fixtures().first).header
        for control in ["false", "[]", "{}", "{\"owned\":\"true\"}", "{\"owned\":false,\"owner\":42}"] {
            let malformed = String(header.dropLast()) + ",\"input_control\":" + control + "}"
            XCTAssertThrowsError(try TerminalPacket(frame(malformed)))
        }
    }

    func testMalformedFramesDoNotConsumeTheQueueBudgetOrEndOtherAttachments() throws {
        let stream = AsyncThrowingStream<TerminalPacket, Error>.makeStream(bufferingPolicy: .bufferingOldest(1))
        let failures = AsyncStream<TerminalFailure>.makeStream(bufferingPolicy: .bufferingOldest(8))
        let sink = TerminalSink(stream.continuation, failures: failures.continuation)
        let valid = frame(try XCTUnwrap(try fixtures().first).header)
        func receive(_ data: Data) -> UInt32 {
            data.withUnsafeBytes { sink.receive($0.bindMemory(to: UInt8.self).baseAddress!, data.count) }
        }
        XCTAssertEqual(receive(Data([1, 2])), 0)
        XCTAssertEqual(receive(valid), 1)
        XCTAssertEqual(receive(valid), 0)
        stream.continuation.finish()
        failures.continuation.finish()
    }

    func testConsumptionResumesDeliveryAfterBoundedQueueRejection() async throws {
        let stream = AsyncThrowingStream<TerminalPacket, Error>.makeStream(bufferingPolicy: .bufferingOldest(1))
        let failures = AsyncStream<TerminalFailure>.makeStream(bufferingPolicy: .bufferingOldest(8))
        let sink = TerminalSink(stream.continuation, failures: failures.continuation)
        let valid = frame(try XCTUnwrap(try fixtures().first).header)
        func receive() -> UInt32 { valid.withUnsafeBytes { sink.receive($0.bindMemory(to: UInt8.self).baseAddress!, valid.count) } }
        XCTAssertEqual(receive(), 1)
        XCTAssertEqual(receive(), 0)
        var iterator = stream.stream.makeAsyncIterator()
        let packet = try await iterator.next()
        sink.release(try XCTUnwrap(packet).allocationSize)
        XCTAssertEqual(receive(), 1)
        var errors = failures.stream.makeAsyncIterator()
        let failure = await errors.next()
        XCTAssertEqual(failure?.attachment, "precision")
        XCTAssertEqual(failure?.code, "TERMINAL_BACKPRESSURE")
        stream.continuation.finish()
        failures.continuation.finish()
    }
}
