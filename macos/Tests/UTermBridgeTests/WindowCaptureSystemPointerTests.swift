import Foundation
import XCTest
@testable import UTermBridge

final class WindowCaptureSystemPointerTests: XCTestCase {
    private let system = "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer"
    func testOnlyVerifiedHiddenSystemPointerIsRecognized() {
        XCTAssertTrue(WindowCaptureSystemPointer.isHiddenPointer(hiddenByQA: true, executable: system, layer: 2147483630, width: 10, height: 18))
        XCTAssertTrue(WindowCaptureSystemPointer.isHiddenPointer(hiddenByQA: true, executable: "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer", layer: 2147483630, width: 17, height: 23))
        XCTAssertFalse(WindowCaptureSystemPointer.isHiddenPointer(hiddenByQA: false, executable: system, layer: 2147483630, width: 10, height: 18))
    }
    func testMissingSpoofedOrPrefixExecutableCannotBypassVisibility() {
        for path in [nil, "/tmp/WindowServer", system + ".copy", system + "/other", "Window Server"] {
            XCTAssertFalse(WindowCaptureSystemPointer.isHiddenPointer(hiddenByQA: true, executable: path, layer: 2147483630, width: 10, height: 18))
        }
    }
    func testOtherSystemWindowsAndFullDisplaySurfacesRemainObstructions() {
        for layer in [0, 3, 8, 20, 2147483631] {
            XCTAssertFalse(WindowCaptureSystemPointer.isHiddenPointer(hiddenByQA: true, executable: system, layer: layer, width: 10, height: 18))
        }
        XCTAssertFalse(WindowCaptureSystemPointer.isHiddenPointer(hiddenByQA: true, executable: system, layer: 2147483630, width: 1920, height: 1080))
    }
    func testInvalidOrOversizedGeometryNeverEstablishesPointerIdentity() {
        for value in [0, -1, 129, Double.nan, Double.infinity, -Double.infinity] {
            XCTAssertFalse(WindowCaptureSystemPointer.isHiddenPointer(hiddenByQA: true, executable: system, layer: 2147483630, width: value, height: 18))
            XCTAssertFalse(WindowCaptureSystemPointer.isHiddenPointer(hiddenByQA: true, executable: system, layer: 2147483630, width: 10, height: value))
        }
    }
}
