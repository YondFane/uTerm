import XCTest
@testable import UTermBridge

final class ProjectRunRootsTests: XCTestCase {
    private func task(_ root: String, _ action: String = "run", running: Bool = true) -> JSONValue {
        .object(["running": .bool(running), "task": .object(["root": .string(root), "action": .string(action)])])
    }
    func testRunningRootsExcludeBuildHistoryAndUnrelatedDirectories() {
        let roots = ProjectRunRoots.languages([task("/project"), task("/project/tree", "python:run|server"), task("/history", running: false), task("/build", "install"), task("", "run")])
        XCTAssertEqual(roots, ["/project": "java", "/project/tree": "python"])
        XCTAssertNil(roots["/project-other"])
    }
    func testPythonPrecedenceDoesNotDependOnTaskCreationOrder() {
        let tasks = [task("/same/", "python:run"), task("/same", "run")]
        XCTAssertEqual(ProjectRunRoots.languages(tasks), ["/same": "python"])
        XCTAssertEqual(ProjectRunRoots.languages(Array(tasks.reversed())), ["/same": "python"])
        XCTAssertEqual(ProjectRunRoots.languages([task("/same", running: false)]), [:])
    }
    func testMacRootsRetainCaseUnicodeAndLiteralBytes() {
        XCTAssertEqual(ProjectRunRoots.key("/Project 中文 & %/"), "/Project 中文 & %")
        XCTAssertNotEqual(ProjectRunRoots.key("/Project"), ProjectRunRoots.key("/project"))
        XCTAssertNotEqual(Array(ProjectRunRoots.key("/é").utf8), Array(ProjectRunRoots.key("/e\u{301}").utf8))
    }
    func testWindowsDriveUncAndExtendedPathsMatchOrdinaryKeys() {
        for path in ["C:/Work/中文/", #"c:\Work\中文\"#, #"\\?\C:\Work\中文\"#] {
            XCTAssertEqual(ProjectRunRoots.key(path), #"c:\work\中文"#)
        }
        XCTAssertEqual(ProjectRunRoots.key(#"\\?\UNC\Server\Share\"#), #"\\server\share"#)
    }
}
