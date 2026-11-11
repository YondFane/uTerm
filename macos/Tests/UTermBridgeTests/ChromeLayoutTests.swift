import XCTest
@testable import UTermBridge

final class ChromeLayoutTests: XCTestCase {
    func testSidebarKeepsTheRailAndBoundsForWideAndNarrowWindows() {
        XCTAssertEqual(CoreChromeLayout.sidebar(available: 1100, requested: 248).width, 248)
        XCTAssertEqual(CoreChromeLayout.sidebar(available: 640, requested: 248).width, 192)
        XCTAssertEqual(CoreChromeLayout.sidebar(available: 2000, requested: 800).width, 320)
        XCTAssertEqual(CoreChromeLayout.sidebar(available: 400, requested: 800).width, 180)
        XCTAssertEqual(CoreChromeLayout.sidebar(available: 1100, requested: -20).width, 48)
    }
    func testCollapseBoundaryRetainsNavigationAndCanReopenAtTheSavedWidth() {
        XCTAssertTrue(CoreChromeLayout.sidebar(available: 640, requested: 78).hidden)
        XCTAssertFalse(CoreChromeLayout.sidebar(available: 640, requested: 79).hidden)
        let narrow = CoreChromeLayout.sidebar(available: 640, requested: CoreChrome.sidebarDefaultWidth)
        let wide = CoreChromeLayout.sidebar(available: 1100, requested: CoreChrome.sidebarDefaultWidth)
        XCTAssertEqual(narrow.width, 192)
        XCTAssertEqual(wide.width, 248)
        XCTAssertFalse(wide.hidden)
    }
    func testInspectorUsesActualRemainingWidthWithoutClippingTheNarrowWindow() {
        let narrow = CoreChromeLayout.inspector(available: 640 - 192, ratio: 0.35)
        XCTAssertEqual(narrow.width, 128)
        XCTAssertEqual(narrow.available - narrow.width, 320)
        XCTAssertEqual(CoreChromeLayout.inspector(available: 1100 - 248, ratio: 0.35).width, 298.2, accuracy: 0.0001)
        for available in [392.0, 448, 560, 852, 2200] {
            for ratio in [-2.0, 0, 0.35, 0.6, 4] {
                let result = CoreChromeLayout.inspector(available: available, ratio: ratio)
                XCTAssertGreaterThanOrEqual(result.width, 30)
                XCTAssertGreaterThanOrEqual(result.available - result.width, 320)
                XCTAssertLessThanOrEqual(result.ratio, 0.6)
            }
        }
    }
}
