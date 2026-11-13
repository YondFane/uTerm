import XCTest
@testable import UTermBridge

final class PythonRunDraftTests: XCTestCase {
    private func project() throws -> CorePythonRunConfig {
        try JSONDecoder().decode(CorePythonRunConfig.self, from: Data(#"{"mode":"script","target":"saved.py","working_directory":"saved","interpreter":"/saved/python","port":9000,"host":"127.0.0.1","reload":false,"arguments":["literal value"]}"#.utf8))
    }
    private func candidate(_ mode: String, _ target: String, directory: String = ".") -> JSONValue {
        .object(["mode": .string(mode), "target": .string(target), "working_directory": .string(directory)])
    }
    func testServiceLinksAcceptNumericHttpEndpointsAndRejectCredentialsOrNavigationPayloads() {
        func task(_ url: String) -> JSONValue { .object(["task": .object(["action": .string("python|" + url)])]) }
        for value in ["http://127.0.0.1:8000", "http://[::1]:5000/"] { XCTAssertNotNil(PythonRunDraft.serviceURL(task: task(value))) }
        for value in ["", "https://127.0.0.1:8000", "http://example.com", "http://user:password@127.0.0.1", "http://127.0.0.1/path", "http://127.0.0.1/?query", "http://127.0.0.1/#fragment", "file:///tmp/project", "http://127.0.0.1:65536"] {
            XCTAssertNil(PythonRunDraft.serviceURL(task: task(value)), value)
        }
    }
    func testSavedSelectionIsNeverReplacedByDetection() throws {
        let saved = try project()
        let draft = PythonRunDraft.make(project: saved, configured: true, candidates: [candidate("flask", "app:app")], interpreters: [.object(["path": .string("/other/python")])])
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        XCTAssertEqual(try encoder.encode(draft), try encoder.encode(saved))
    }
    func testUnconfiguredDraftPrefersOneFrameworkAndUsesExistingInterpreter() throws {
        let saved = try project()
        let draft = PythonRunDraft.make(project: saved, configured: false, candidates: [candidate("script", "main.py"), candidate("flask", "app:app", directory: "src")], interpreters: [.object(["path": .string("/existing/python")])])
        XCTAssertEqual(draft.mode, "flask"); XCTAssertEqual(draft.target, "app:app"); XCTAssertEqual(draft.working_directory, "src")
        XCTAssertEqual(draft.interpreter, "/existing/python"); XCTAssertEqual(draft.port, 5000)
        XCTAssertEqual(draft.arguments, saved.arguments); XCTAssertEqual(draft.host, saved.host)
        XCTAssertEqual(saved.target, "saved.py")
    }
    func testMainScriptPriorityAndAmbiguousEntriesDoNotChooseAnArbitraryTarget() throws {
        let saved = try project()
        let main = PythonRunDraft.make(project: saved, configured: false, candidates: [candidate("script", "helper.py"), candidate("script", "src/main.py")], interpreters: [])
        XCTAssertEqual(main.target, "src/main.py"); XCTAssertEqual(main.interpreter, ""); XCTAssertEqual(main.port, 8000)
        let ambiguous = PythonRunDraft.make(project: saved, configured: false, candidates: [candidate("fastapi", "one:app"), candidate("fastapi", "two:app")], interpreters: [])
        XCTAssertEqual(ambiguous.target, saved.target); XCTAssertEqual(ambiguous.mode, saved.mode)
    }
    func testModeSwitchClearsAnIncompatibleTargetAndRetainsLiteralArguments() throws {
        let saved = try project()
        let draft = PythonRunDraft.changingMode(saved, to: "flask", candidates: [candidate("flask", "one:app"), candidate("flask", "two:app")])
        XCTAssertEqual(draft.mode, "flask"); XCTAssertEqual(draft.target, ""); XCTAssertEqual(draft.working_directory, "."); XCTAssertEqual(draft.port, 5000)
        XCTAssertEqual(draft.arguments, saved.arguments); XCTAssertEqual(draft.interpreter, saved.interpreter)
        let unique = PythonRunDraft.changingMode(saved, to: "module", candidates: [candidate("module", "package.main", directory: "src")])
        XCTAssertEqual(unique.target, "package.main"); XCTAssertEqual(unique.working_directory, "src"); XCTAssertEqual(unique.port, 8000)
    }
}
