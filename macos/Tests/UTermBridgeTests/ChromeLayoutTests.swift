import XCTest
@testable import UTermBridge

final class ChromeLayoutTests: XCTestCase {
    func testTerminalHeaderMatchesMeasuredCSSWrapBoundariesWithoutDroppingControls() {
        let items = [CoreChromeLayout.HeaderItem("name", width: 66.234375, height: 13),
                     .init("directory", width: 100, height: 12), .init("font", width: 96.75, height: 22),
                     .init("search", width: 26, height: 26), .init("status", width: 18, height: 26)]
        for (pane, expected) in [(554.0, 35.0), (394, 35), (360, 69), (350, 69), (320, 65), (298, 56), (264, 56)] {
            let flow = CoreChromeLayout.terminalHeader(width: pane - 22, items: items)
            XCTAssertEqual(flow.height, expected)
            XCTAssertEqual(flow.frames.count, items.count)
            for frame in flow.frames {
                XCTAssertGreaterThanOrEqual(frame.x, 0); XCTAssertGreaterThanOrEqual(frame.y, 0)
                XCTAssertLessThanOrEqual(frame.x + frame.width, pane - 22 + 0.001)
                XCTAssertLessThanOrEqual(frame.y + frame.height, flow.height - 9)
            }
        }
        let narrow = CoreChromeLayout.terminalHeader(width: 100, items: items)
        let macItems = items.map { CoreChromeLayout.HeaderItem($0.id, width: $0.width, height: $0.id == "font" ? 23 : $0.height) }
        XCTAssertEqual(CoreChromeLayout.terminalHeader(width: 320 - 22, items: macItems).height, 66)
        XCTAssertEqual(CoreChromeLayout.terminalHeader(width: 554 - 22, items: macItems).height, 35)
        XCTAssertEqual(narrow.frames.count, items.count)
        XCTAssertGreaterThan(narrow.height, 56)
        XCTAssertEqual(CoreChromeLayout.terminalHeader(width: 0, items: []).height, 34)
    }
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
