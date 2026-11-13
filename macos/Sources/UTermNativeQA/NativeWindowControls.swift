import AppKit

@MainActor
enum NativeWindowControls {
    static func align(_ window: NSWindow) {
        guard !window.styleMask.contains(.fullScreen), !window.isMiniaturized,
              let close = window.standardWindowButton(.closeButton),
              let minimize = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton),
              let container = close.superview?.superview else { return }
        // Use the ordinary client's 16/24 traffic-light inset with the actual AppKit button height.
        // 使用普通版的 16/24 窗口按钮内缩值，并按实际 AppKit 按钮高度定位。
        let spacing = minimize.frame.minX - close.frame.minX
        let height = close.frame.height + 24
        var frame = container.frame
        frame.size.height = height; frame.origin.y = window.frame.height - height
        if container.frame != frame { container.frame = frame }
        for (index, button) in [close, minimize, zoom].enumerated() {
            let origin = NSPoint(x: 16 + CGFloat(index) * spacing, y: button.frame.minY)
            if button.frame.origin != origin { button.setFrameOrigin(origin) }
        }
    }
    static func metrics(_ window: NSWindow) -> [[String: Double]] {
        guard let content = window.contentView else { return [] }
        return [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap { type in
            guard let button = window.standardWindowButton(type) else { return nil }
            let frame = content.convert(button.bounds, from: button)
            return ["x": Double(frame.minX), "y": Double(content.isFlipped ? frame.minY : content.bounds.height - frame.maxY), "width": Double(frame.width), "height": Double(frame.height)]
        }
    }
}
