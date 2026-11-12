import CoreGraphics
import Foundation

public enum WindowCaptureAlpha {
    public static func nontransparentPixels(image: CGImage, windowFrame: CGRect, targetFrame: CGRect) throws -> Int {
        let overlap = windowFrame.intersection(targetFrame)
        guard windowFrame.width > 0, windowFrame.height > 0, !overlap.isNull, !overlap.isEmpty else {
            throw NSError(domain: "UTermWindowCaptureAlpha", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid desktop-surface intersection"])
        }
        let scaleX = CGFloat(image.width) / windowFrame.width, scaleY = CGFloat(image.height) / windowFrame.height
        let pixels = CGRect(x: (overlap.minX - windowFrame.minX) * scaleX, y: (overlap.minY - windowFrame.minY) * scaleY,
                            width: overlap.width * scaleX, height: overlap.height * scaleY).integral
        guard let crop = image.cropping(to: pixels), crop.width > 0, crop.height > 0,
              crop.width <= 16384, crop.height <= 16384, crop.width * crop.height <= 20_000_000 else {
            throw NSError(domain: "UTermWindowCaptureAlpha", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not inspect the captured desktop surface"])
        }
        var bytes = [UInt8](repeating: 0, count: crop.width * crop.height * 4)
        return try bytes.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: crop.width, height: crop.height, bitsPerComponent: 8,
                                          bytesPerRow: crop.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
                throw NSError(domain: "UTermWindowCaptureAlpha", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not decode desktop-surface alpha"])
            }
            context.draw(crop, in: CGRect(x: 0, y: 0, width: CGFloat(crop.width), height: CGFloat(crop.height)))
            return stride(from: 3, to: buffer.count, by: 4).reduce(0) { $0 + (buffer[$1] == 0 ? 0 : 1) }
        }
    }
}
