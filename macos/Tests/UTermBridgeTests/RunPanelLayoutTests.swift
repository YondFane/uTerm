import XCTest
@testable import UTermBridge

final class RunPanelLayoutTests: XCTestCase {
    func testRunDefaultsAndKeyboardStepsKeepSpaceForTheTerminal() {
        for (kind, expected) in [("java", 380.0), ("python", 470.0)] {
            let layout = RunPanelLayout(kind: kind, available: 676, viewport: 720, requested: nil)
            XCTAssertEqual(layout.height, expected); XCTAssertEqual(layout.maximum, 588)
            XCTAssertEqual(layout.minimum, 240); XCTAssertEqual(layout.expandedTop, 80)
            XCTAssertEqual(RunPanelLayout(kind: kind, available: 676, viewport: 720, requested: expected + CoreChrome.runPanelResizeStep).height, expected + 24)
        }
    }

    func testShortAndShrinkingWindowsBoundThePanelWithoutNegativeFrames() {
        XCTAssertEqual(RunPanelLayout(kind: "java", available: 460, viewport: 520, requested: 0).minimum, 200)
        XCTAssertEqual(RunPanelLayout(kind: "python", available: 460, viewport: 520, requested: 0).minimum, 240)
        for available in [0.0, 40, 88, 89, 200, 300, 676] {
            for request in [-500.0, 0, 470, 10_000, .nan, .infinity] {
                let layout = RunPanelLayout(kind: "python", available: available, viewport: 520, requested: request)
                XCTAssertGreaterThanOrEqual(layout.height, 0)
                XCTAssertLessThanOrEqual(layout.height, max(0, available - 88))
                XCTAssertLessThanOrEqual(layout.minimum, layout.maximum)
                XCTAssertGreaterThanOrEqual(layout.expandedTop, 0); XCTAssertLessThanOrEqual(layout.expandedTop, available)
            }
        }
        XCTAssertEqual(RunPanelLayout(kind: "java", available: .nan, viewport: 720, requested: nil).height, 0)
    }
}
