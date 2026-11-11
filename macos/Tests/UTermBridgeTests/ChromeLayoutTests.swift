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
}
