import CoreGraphics
import XCTest
@testable import UTermBridge

final class ChromeVectorPathTests: XCTestCase {
    func testAllSharedPathsRenderFiniteBoundsInsideTheViewport() throws {
        XCTAssertEqual(Set(CoreSidebarIcon.allCases.map(\.rawValue)), Set(CoreChrome.sidebar.keys))
        XCTAssertEqual(Set(CoreToolbarIcon.allCases.map(\.rawValue)), Set(CoreChrome.toolbar.keys))
        for (name, source) in Array(CoreChrome.sidebar) + Array(CoreChrome.toolbar) {
            let path = try ChromeVectorPath.parse(source)
            XCTAssertFalse(path.isEmpty, name)
            let box = path.boundingBoxOfPath
            XCTAssertTrue(box.minX.isFinite && box.minY.isFinite && box.maxX.isFinite && box.maxY.isFinite, name)
            XCTAssertGreaterThanOrEqual(box.minX, -0.001, name); XCTAssertGreaterThanOrEqual(box.minY, -0.001, name)
            XCTAssertLessThanOrEqual(box.maxX, 24.001, name); XCTAssertLessThanOrEqual(box.maxY, 24.001, name)
        }
    }
    func testRelativeMovesAndImplicitLinePairsRetainSubpathOrigin() throws {
        let path = try ChromeVectorPath.parse("m2 3 4 5 6 -2z m1 1h3v2")
        XCTAssertEqual(path.currentPoint, CGPoint(x: 6, y: 6))
        XCTAssertEqual(path.boundingBoxOfPath, CGRect(x: 2, y: 3, width: 10, height: 5))
    }
    func testSmoothCubicAndQuadraticReflectOnlyMatchingControls() throws {
        let cubic = try ChromeVectorPath.parse("M0 0c0 10 10 10 10 0s10-10 10 0")
        XCTAssertEqual(cubic.currentPoint, CGPoint(x: 20, y: 0))
        XCTAssertEqual(cubic.boundingBoxOfPath.minY, -7.5, accuracy: 0.00001)
        XCTAssertEqual(cubic.boundingBoxOfPath.maxY, 7.5, accuracy: 0.00001)
        let quadratic = try ChromeVectorPath.parse("M0 0q5 10 10 0t10 0")
        XCTAssertEqual(quadratic.boundingBoxOfPath.minY, -5, accuracy: 0.00001)
        XCTAssertEqual(quadratic.boundingBoxOfPath.maxY, 5, accuracy: 0.00001)
        let reset = try ChromeVectorPath.parse("M0 0Q5 10 10 0L11 0T20 0")
        XCTAssertEqual(reset.boundingBoxOfPath.minY, 0, accuracy: 0.00001)
    }
    func testArcSweepRotationAndRadiusExpansionPreserveGeometry() throws {
        let circle = try ChromeVectorPath.parse("M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0")
        let box = circle.boundingBoxOfPath
        XCTAssertEqual(box.minX, 3, accuracy: 0.00001); XCTAssertEqual(box.maxX, 21, accuracy: 0.00001)
        XCTAssertEqual(box.minY, 3, accuracy: 0.00001); XCTAssertEqual(box.maxY, 21, accuracy: 0.00001)
        XCTAssertEqual(circle.currentPoint, CGPoint(x: 3, y: 12))
        let rotated = try ChromeVectorPath.parse("M12 20A8 4 90 0 1 8 12")
        XCTAssertEqual(rotated.boundingBoxOfPath.minX, 8, accuracy: 0.00001)
        XCTAssertEqual(rotated.boundingBoxOfPath.maxY, 20, accuracy: 0.00001)
        let expanded = try ChromeVectorPath.parse("M2 10A1 1 0 0 1 10 10")
        XCTAssertEqual(expanded.boundingBoxOfPath.width, 8, accuracy: 0.00001)
        XCTAssertEqual(expanded.boundingBoxOfPath.height, 4, accuracy: 0.00001)
        XCTAssertEqual(try ChromeVectorPath.parse("M2 3A0 0 0 0 0 10 12").currentPoint, CGPoint(x: 10, y: 12))
    }
    func testMalformedUnsupportedAndNonFiniteInputsAreRejected() {
        for value in ["", "L1 2", "M1", "M0 0L", "M0 0Z1 2", "M0 0R2 2", "M0 0A3 3 0 2 0 1 2", "M1e999 0", "MNaN 0", "M0 0A1e-300 1e6 0 0 1 10 10", String(repeating: "M0 0", count: 10000)] {
            XCTAssertThrowsError(try ChromeVectorPath.parse(value), value)
        }
    }
}
