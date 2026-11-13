import XCTest
@testable import UTermBridge

final class RunPanelInputTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Arguments: Decodable { let name: String; let text: String; let expected: [String] }
        struct Environment: Decodable { let name: String; let text: String; let expected: [String: String] }
        let validArguments: [Arguments]
        let invalidArguments: [String]
        let roundTrips: [[String]]
        let validEnvironment: [Environment]
        let invalidEnvironment: [String]
    }
    private func fixture() throws -> Fixture {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: root.appendingPathComponent("shared/fixtures/run-panel-input.json")))
    }
    func testSharedArgumentsPreserveEveryUtf8ByteAndRejectIncompleteInput() throws {
        let fixture = try fixture()
        for row in fixture.validArguments {
            let result = try RunPanelInput.arguments(row.text)
            XCTAssertEqual(result.map { Array($0.utf8) }, row.expected.map { Array($0.utf8) }, row.name)
        }
        for text in fixture.invalidArguments {
            XCTAssertThrowsError(try RunPanelInput.arguments(text)) { XCTAssertEqual($0 as? RunPanelInput.Invalid, .arguments) }
        }
    }
    func testArgumentFormattingRoundTripsLiteralControlsAndQuotes() throws {
        for values in try fixture().roundTrips {
            let result = try RunPanelInput.arguments(RunPanelInput.formatArguments(values))
            XCTAssertEqual(result.map { Array($0.utf8) }, values.map { Array($0.utf8) })
        }
    }
    func testValidDraftFormattingIsRetainedOnlyForExactlySavedBytes() throws {
        let raw = "  'hello world' '' C:\\tools\\run.exe  "
        let values = try RunPanelInput.arguments(raw)
        XCTAssertEqual(RunPanelInput.formatArguments(values, retaining: raw), raw)
        XCTAssertNotEqual(RunPanelInput.formatArguments(["changed"], retaining: raw), raw)
        XCTAssertNotEqual(Array(RunPanelInput.formatArguments(["é"], retaining: "e\u{301}").utf8), Array("e\u{301}".utf8))
        XCTAssertEqual(RunPanelInput.formatArguments(["safe"], retaining: "'unfinished"), "safe")
    }
    func testSharedEnvironmentPreservesLiteralValuesAndRejectsDuplicateOrControlNames() throws {
        let fixture = try fixture()
        for row in fixture.validEnvironment { XCTAssertEqual(try RunPanelInput.environment(row.text), row.expected, row.name) }
        for text in fixture.invalidEnvironment {
            XCTAssertThrowsError(try RunPanelInput.environment(text)) { XCTAssertEqual($0 as? RunPanelInput.Invalid, .environment) }
        }
    }
}
