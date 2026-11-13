import AppKit
import SwiftUI
import UTermBridge

@MainActor
enum NativeChromeImages {
    private static var cache: [String: NSImage] = [:]
    static func sidebar(_ name: CoreSidebarIcon) -> NSImage { image(CoreChrome.sidebar[name.rawValue] ?? "", id: "sidebar." + name.rawValue) }
    static func toolbar(_ name: CoreToolbarIcon) -> NSImage { image(CoreChrome.toolbar[name.rawValue] ?? "", id: "toolbar." + name.rawValue) }
    static func projectRun(_ language: String, running: Bool, light: Bool) -> NSImage {
        let id = "project-run." + language + "." + String(running) + "." + String(light)
        if let cached = cache[id] { return cached }
        let idle = light ? "#82796e" : "#959595"
        var layers: [(String, String)] = [(CoreChrome.toolbar[language] ?? "", running ? (light ? "#4f8b25" : "#6db33f") : idle)]
        if language == "python" && running {
            // Keep the ordinary Python icon's two stroke layers and theme colors.
            // 保留普通版 Python 图标的两层描边及深浅主题颜色。
            layers = [
                ("M12 3H8a3 3 0 0 0-3 3v3h8v2H5a3 3 0 0 0-3 3v1a3 3 0 0 0 3 3h3v-4h8V6a3 3 0 0 0-3-3ZM8 6h.01", light ? "#3776ab" : "#549ed3"),
                ("M12 21h4a3 3 0 0 0 3-3v-3h-8v-2h8a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3h-1v8H8v4a3 3 0 0 0 3 3M16 18h.01", light ? "#a87900" : "#ffd343")
            ]
        }
        guard let paths = try? layers.map({ (try ChromeVectorPath.parse($0.0), NativePreferences.color(.string($0.1))) }) else { return NSImage() }
        let result = NSImage(size: NSSize(width: 24, height: 24), flipped: false) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.saveGState(); defer { context.restoreGState() }
            context.translateBy(x: rect.minX, y: rect.maxY); context.scaleBy(x: rect.width / 24, y: -rect.height / 24)
            context.setLineWidth(2); context.setLineCap(.round); context.setLineJoin(.round)
            for (path, color) in paths { context.setStrokeColor(color.cgColor); context.addPath(path); context.strokePath() }
            return true
        }
        result.isTemplate = false; cache[id] = result; return result
    }
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
final class NativeResourceRing: NSView {
    let light: Bool
    init(light: Bool) { self.light = light; super.init(frame: .zero); setAccessibilityElement(false) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.saveGraphicsState(); defer { NSGraphicsContext.restoreGraphicsState() }
        let shadow = NSShadow(); shadow.shadowOffset = .zero; shadow.shadowBlurRadius = 5
        shadow.shadowColor = NativePreferences.color(.string(light ? "#2aa75b" : "#48c878")).withAlphaComponent(light ? 0.267 : 0.4); shadow.set()
        NativePreferences.color(.string(light ? "#23874b" : "#62d98a")).setStroke()
        let circle = NSBezierPath(ovalIn: NSRect(x: bounds.midX - 11, y: bounds.midY - 11, width: 22, height: 22))
        circle.lineWidth = 1; circle.stroke()
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
