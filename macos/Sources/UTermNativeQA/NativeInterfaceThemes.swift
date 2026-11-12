import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct NativeInterfaceThemes: View {
    @ObservedObject var model: NativeSettingsModel
    private func grid(_ count: Int) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: count), spacing: 10) {
            ForEach(Array(model.catalog["interfaceThemes"].array.enumerated()), id: \.offset) { _, theme in
                NativeInterfaceThemeButton(model: model, theme: theme).frame(height: 150)
            }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(localized("Interface theme", "界面主题")).fontWeight(.semibold)
            ViewThatFits(in: .horizontal) { grid(3).frame(minWidth: 435); grid(1) }
            Text(localized("Applies and saves immediately. Terminal colors stay unchanged.", "即时生效并自动保存，不改变终端配色。")).font(.caption).foregroundStyle(.secondary)
        }
    }
}

@MainActor
private struct NativeInterfaceThemeButton: NSViewRepresentable {
    @ObservedObject var model: NativeSettingsModel
    let theme: JSONValue
    func makeCoordinator() -> Coordinator { Coordinator(model) }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ThemeButton, context: Context) -> CGSize? { CGSize(width: proposal.width ?? 160, height: 150) }
    func makeNSView(context: Context) -> ThemeButton {
        let button = ThemeButton(frame: .zero)
        button.target = context.coordinator; button.action = #selector(Coordinator.select(_:))
        button.setButtonType(.momentaryPushIn); button.isBordered = false
        return button
    }
    func updateNSView(_ button: ThemeButton, context: Context) {
        button.theme = theme; button.title = model.title(theme)
        button.palette = theme[NativePreferences.light(model.workspace.settings) ? "light" : "dark"]
        button.chrome = NativePreferences.interfacePalette(model.workspace.settings, catalog: model.catalog)
        button.selected = model.values["interfaceTheme"]?.string == theme["id"].string
        button.descriptionText = localized(theme["descriptions"]["en"].string ?? "", theme["descriptions"]["zh-Hans"].string ?? "")
        button.identifier = .init("native-settings-theme-" + (theme["id"].string ?? ""))
        button.isEnabled = context.environment.isEnabled && !model.busy && !model.frozen
        button.alphaValue = button.isEnabled ? 1 : 0.5
        button.setAccessibilityLabel(button.title + ". " + button.descriptionText)
        button.setAccessibilityValue(button.selected ? localized("Selected", "已选择") : "")
        button.needsDisplay = true
    }
    @MainActor final class Coordinator: NSObject {
        let model: NativeSettingsModel
        init(_ model: NativeSettingsModel) { self.model = model }
        @objc func select(_ button: ThemeButton) {
            guard !model.busy, !model.frozen, let id = button.theme["id"].string else { return }
            model.values["interfaceTheme"] = .string(id); model.saveAutomatically(["interfaceTheme"])
        }
    }
    @MainActor final class ThemeButton: NSButton {
        var theme: JSONValue = .null
        var palette: JSONValue = .null
        var chrome: JSONValue = .null
        var selected = false
        var descriptionText = ""
        override var isFlipped: Bool { true }
        override var acceptsFirstResponder: Bool { isEnabled }
        override func becomeFirstResponder() -> Bool { needsDisplay = true; return super.becomeFirstResponder() }
        override func resignFirstResponder() -> Bool { needsDisplay = true; return super.resignFirstResponder() }
        override func draw(_ dirtyRect: NSRect) {
            let outer = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 4, yRadius: 4)
            NativePreferences.color(chrome[isHighlighted ? "hover" : "surface"], fallback: .controlBackgroundColor).setFill(); outer.fill()
            NativePreferences.color(chrome[selected || window?.firstResponder === self ? "accent" : "border"], fallback: .separatorColor).setStroke()
            outer.lineWidth = selected || window?.firstResponder === self ? 2 : 1; outer.stroke()
            let preview = NSRect(x: 9, y: 9, width: max(0, bounds.width - 18), height: 70)
            let shape = NSBezierPath(roundedRect: preview, xRadius: 3, yRadius: 3)
            NSGraphicsContext.saveGraphicsState(); shape.addClip()
            NativePreferences.color(palette["canvas"]).setFill(); preview.fill()
            let side = NSRect(x: preview.minX, y: preview.minY, width: preview.width * 0.28, height: preview.height)
            NativePreferences.color(palette["sidebar"]).setFill(); side.fill()
            NativePreferences.color(palette["border"]).setFill(); NSRect(x: side.maxX, y: side.minY, width: 1, height: side.height).fill()
            let lineWidth = max(0, preview.width - side.width - 16)
            for (index, ratio) in [CGFloat(0.5), 0.75, 0.4].enumerated() {
                NativePreferences.color(palette[index == 0 ? "accent" : "text"]).withAlphaComponent(index == 0 ? 1 : 0.5).setFill()
                NSRect(x: side.maxX + 8, y: preview.minY + 12 + CGFloat(index) * 11, width: lineWidth * ratio, height: 3).fill()
            }
            NSGraphicsContext.restoreGraphicsState()
            NativePreferences.color(palette["border"]).setStroke(); shape.lineWidth = 1; shape.stroke()
            let text = NativePreferences.color(chrome["text"]), muted = NativePreferences.color(chrome["muted"])
            ((title + (selected ? " ✓" : "")) as NSString).draw(in: NSRect(x: 9, y: 89, width: bounds.width - 18, height: 16), withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: text])
            let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byWordWrapping
            (descriptionText as NSString).draw(in: NSRect(x: 9, y: 110, width: bounds.width - 18, height: 34), withAttributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: muted, .paragraphStyle: paragraph])
        }
    }
}
