import XCTest
@testable import UTermBridge

final class RunPanelLayoutTests: XCTestCase {
    func testMeasuredGridAcceptsOnlyRasterizedContainerColumns() {
        let grid = CGRect(x: 12, y: 20, width: 515, height: 180)
        let fields = [CGRect(x: 12, y: 27, width: 164, height: 46), CGRect(x: 188, y: 27, width: 163, height: 46), CGRect(x: 363, y: 27, width: 164, height: 64)]
        XCTAssertTrue(RunPanelLayout.formGridMatches(grid, fields: fields, columns: 3, interpreterFullRow: false, scale: 1))
        for change in 0..<4 {
            var wrong = fields
            if change == 0 { wrong[1].size.width -= 2 }
            if change == 1 { wrong[1].origin.x -= 2 }
            if change == 2 { wrong[2].origin.y += 2 }
            if change == 3 { wrong[2].size.width -= 1 }
            XCTAssertFalse(RunPanelLayout.formGridMatches(grid, fields: wrong, columns: 3, interpreterFullRow: false, scale: 1))
        }
        XCTAssertFalse(RunPanelLayout.formGridMatches(grid, fields: fields, columns: 2, interpreterFullRow: false, scale: 1))
        XCTAssertFalse(RunPanelLayout.formGridMatches(grid, fields: fields, columns: 3, interpreterFullRow: false, scale: .nan))
        let retina = [CGRect(x: 12, y: 27, width: 164, height: 46), CGRect(x: 188, y: 27, width: 163.5, height: 46), CGRect(x: 363.5, y: 27, width: 164, height: 64)]
        XCTAssertTrue(RunPanelLayout.formGridMatches(CGRect(x: 12, y: 20, width: 515.5, height: 180), fields: retina, columns: 3, interpreterFullRow: false, scale: 2))
    }

    func testNarrowInterpreterUsesMeasuredWidthAndRejectsOverlap() {
        let grid = CGRect(x: 12, y: 20, width: 515, height: 180)
        var fields = [CGRect(x: 12, y: 20, width: 515, height: 60), CGRect(x: 12, y: 88, width: 252, height: 40), CGRect(x: 276, y: 88, width: 251, height: 40)]
        XCTAssertTrue(RunPanelLayout.formGridMatches(grid, fields: fields, columns: 2, interpreterFullRow: true, scale: 1))
        fields[1].origin.y = 70; fields[2].origin.y = 70
        XCTAssertFalse(RunPanelLayout.formGridMatches(grid, fields: fields, columns: 2, interpreterFullRow: true, scale: 1))
        fields = [CGRect(x: 12, y: 20, width: 252, height: 40), CGRect(x: 276, y: 20, width: 251, height: 40), CGRect(x: 12, y: 68, width: 252, height: 40)]
        XCTAssertTrue(RunPanelLayout.formGridMatches(grid, fields: fields, columns: 2, interpreterFullRow: false, scale: 1))
    }

    func testWindowBreakpointsMatchWideAndNarrowOrdinaryRunForms() {
        for (width, columns, interpreterRow) in [(640.0, 2, true), (850, 2, true), (851, 2, false), (900, 2, false), (901, 3, false), (1100, 3, false)] {
            XCTAssertEqual(RunPanelLayout.formColumns(viewportWidth: width), columns)
            XCTAssertEqual(RunPanelLayout.interpreterFillsRow(viewportWidth: width), interpreterRow)
        }
    }

    func testTaskActionsWrapWithinTheNarrowPanelAndKeepTheirOrder() {
        let items = [CoreChromeLayout.HeaderItem("state", width: 80, height: 14), .init("spacer", width: 0, height: 0),
                     .init("more", width: 22, height: 20), .init("goal", width: 82, height: 28), .init("build", width: 55, height: 34),
                     .init("run-again", width: 100, height: 34), .init("stop", width: 48, height: 34)]
        let wide = RunPanelLayout.toolbar(width: 530, items: items)
        XCTAssertEqual(wide.height, 34)
        let narrow = RunPanelLayout.toolbar(width: 296, items: items)
        XCTAssertGreaterThan(narrow.height, wide.height)
        for width in [0.0, 40, 128, 296, 530, .nan] {
            let flow = RunPanelLayout.toolbar(width: width, items: items)
            XCTAssertEqual(flow.frames.count, items.count)
            let limit = width.isFinite ? width : 0
            for frame in flow.frames {
                XCTAssertGreaterThanOrEqual(frame.x, 0); XCTAssertLessThanOrEqual(frame.x + frame.width, limit)
                XCTAssertGreaterThanOrEqual(frame.y, 0); XCTAssertLessThanOrEqual(frame.y + frame.height, flow.height)
            }
            for (before, after) in zip(flow.frames, flow.frames.dropFirst()) {
                XCTAssertTrue(after.y >= before.y + before.height || after.x >= before.x + before.width)
            }
        }
    }

    func testExpandedPanelCountsTheTitlebarInsetOnce() {
        for kind in ["java", "python"] {
            let regular = RunPanelLayout(kind: kind, available: 676, viewport: 720, requested: nil)
            XCTAssertEqual(regular.expandedHeight, 640)
            XCTAssertEqual(CoreChrome.titlebarHeight + 676 - regular.expandedHeight, regular.expandedTop)
            let compact = RunPanelLayout(kind: kind, available: 476, viewport: 520, requested: nil)
            XCTAssertEqual(compact.expandedHeight, 476)
            XCTAssertEqual(CoreChrome.titlebarHeight + 476 - compact.expandedHeight, CoreChrome.titlebarHeight)
        }
    }

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
                XCTAssertGreaterThanOrEqual(layout.expandedHeight, 0); XCTAssertLessThanOrEqual(layout.expandedHeight, available)
            }
        }
        XCTAssertEqual(RunPanelLayout(kind: "java", available: .nan, viewport: 720, requested: nil).height, 0)
    }
}
