import CoreGraphics
import Foundation
import XCTest
@testable import UTermBridge

final class WindowCaptureAlphaTests: XCTestCase {
    private func image() throws -> CGImage {
        var bytes = [UInt8](repeating: 0, count: 4 * 4 * 4)
        for index in 0..<8 { bytes[index * 4 + 3] = 255 }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(bytes) as CFData))
        return try XCTUnwrap(CGImage(width: 4, height: 4, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 16,
                                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
    }

    func testOnlyTheOverlappingPixelsDetermineDesktopOcclusion() throws {
        let image = try image(), frame = CGRect(x: 100, y: 200, width: 8, height: 8)
        XCTAssertEqual(try WindowCaptureAlpha.nontransparentPixels(image: image, windowFrame: frame, targetFrame: CGRect(x: 100, y: 200, width: 8, height: 4)), 8)
        XCTAssertEqual(try WindowCaptureAlpha.nontransparentPixels(image: image, windowFrame: frame, targetFrame: CGRect(x: 100, y: 204, width: 8, height: 4)), 0)
        XCTAssertEqual(try WindowCaptureAlpha.nontransparentPixels(image: image, windowFrame: frame, targetFrame: CGRect(x: 102, y: 200, width: 2, height: 2)), 1)
    }

    func testMissingOrInvalidPixelRegionsNeverEstablishTransparency() throws {
        let image = try image(), frame = CGRect(x: 0, y: 0, width: 4, height: 4)
        XCTAssertThrowsError(try WindowCaptureAlpha.nontransparentPixels(image: image, windowFrame: .zero, targetFrame: frame))
        XCTAssertThrowsError(try WindowCaptureAlpha.nontransparentPixels(image: image, windowFrame: frame, targetFrame: CGRect(x: 9, y: 9, width: 1, height: 1)))
    }
}
