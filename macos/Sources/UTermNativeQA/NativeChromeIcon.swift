import AppKit
import SwiftUI
import UTermBridge

@MainActor
enum NativeChromeImages {
    private static var cache: [String: NSImage] = [:]
    static func sidebar(_ name: CoreSidebarIcon) -> NSImage { image(CoreChrome.sidebar[name.rawValue] ?? "", id: "sidebar." + name.rawValue) }
    static func toolbar(_ name: CoreToolbarIcon) -> NSImage { image(CoreChrome.toolbar[name.rawValue] ?? "", id: "toolbar." + name.rawValue) }
    static func sidebarChevron(expanded: Bool) -> NSImage {
        let source = image(CoreChrome.sidebar["chevron"] ?? "", id: "chevron." + String(expanded), rotation: expanded ? .pi / 2 : 0)
        let scaled = source.copy() as? NSImage ?? source
        scaled.size = NSSize(width: 10, height: 10)
        return scaled
    }
    private static func image(_ source: String, id: String, rotation: CGFloat = 0) -> NSImage {
        if let cached = cache[id] { return cached }
        guard let path = try? ChromeVectorPath.parse(source) else {
            assertionFailure("Invalid generated chrome icon: " + id)
            return NSImage(size: NSSize(width: 24, height: 24))
        }
        let result = NSImage(size: NSSize(width: 24, height: 24), flipped: false) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.saveGState(); defer { context.restoreGState() }
            context.translateBy(x: rect.minX, y: rect.maxY); context.scaleBy(x: rect.width / 24, y: -rect.height / 24)
            context.translateBy(x: 12, y: 12); context.rotate(by: rotation); context.translateBy(x: -12, y: -12)
            context.setStrokeColor(NSColor.black.cgColor); context.setLineWidth(2)
            context.setLineCap(.round); context.setLineJoin(.round)
            context.addPath(path); context.strokePath()
            return true
        }
        result.isTemplate = true; cache[id] = result; return result
    }
}

@MainActor
struct NativeChromeIcon: View {
    let image: NSImage
    let size: CGFloat
    init(sidebar: CoreSidebarIcon, size: CGFloat = CGFloat(CoreChrome.sidebarIconSize)) { image = NativeChromeImages.sidebar(sidebar); self.size = size }
    init(toolbar: CoreToolbarIcon, size: CGFloat = CGFloat(CoreChrome.toolbarIconSize)) { image = NativeChromeImages.toolbar(toolbar); self.size = size }
    var body: some View { Image(nsImage: image).renderingMode(.template).resizable().frame(width: size, height: size).accessibilityHidden(true) }
}
