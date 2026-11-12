import AppKit
import SwiftUI

@MainActor
struct NativeSettingsSearch: NSViewRepresentable {
    @ObservedObject var model: NativeSettingsModel
    func makeNSView(context: Context) -> Container {
        let container = Container(frame: .zero), field = container.field
        field.identifier = .init("native-settings-search")
        field.delegate = context.coordinator; field.sendsSearchStringImmediately = true
        field.clearRequested = { [weak model] in model?.query = "" }
        return container
    }
    func updateNSView(_ container: Container, context: Context) {
        let field = container.field
        field.placeholderString = localized("Search settings", "搜索设置"); field.setAccessibilityLabel(field.placeholderString)
        field.isEnabled = context.environment.isEnabled && !model.busy && !model.frozen
        if field.currentEditor() == nil && field.stringValue != model.query { field.stringValue = model.query }
        let palette = NativePreferences.interfacePalette(model.workspace.settings, catalog: model.catalog)
        container.fill = NativePreferences.color(palette["surface"], fallback: .textBackgroundColor)
        container.border = NativePreferences.color(palette["border"], fallback: .separatorColor)
        field.textColor = NativePreferences.color(palette["text"])
        container.needsDisplay = true
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: Container, context: Context) -> CGSize? { CGSize(width: proposal.width ?? 133, height: 40) }
    func makeCoordinator() -> Coordinator { Coordinator(model) }
    @MainActor final class Container: NSView {
        let field = Field()
        var fill = NSColor.textBackgroundColor
        var border = NSColor.separatorColor
        override init(frame frameRect: NSRect) {
            super.init(frame: frameRect)
            field.isBordered = false; field.isBezeled = false; field.drawsBackground = false
            field.font = .systemFont(ofSize: 13)
            (field.cell as? NSSearchFieldCell)?.searchButtonCell = nil
            field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            addSubview(field)
        }
        required init?(coder: NSCoder) { fatalError("Use programmatic construction") }
        override func layout() { super.layout(); field.frame = NSRect(x: 8, y: (bounds.height - 22) / 2, width: max(0, bounds.width - 16), height: 22) }
        override func draw(_ dirtyRect: NSRect) {
            let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 4, yRadius: 4)
            fill.setFill(); shape.fill(); border.setStroke(); shape.lineWidth = 1; shape.stroke()
        }
    }
    @MainActor final class Field: NSSearchField {
        var clearRequested: (() -> Void)?
        override func cancelOperation(_ sender: Any?) {
            if !stringValue.isEmpty { stringValue = ""; clearRequested?() }
            else { super.cancelOperation(sender) }
        }
    }
    @MainActor final class Coordinator: NSObject, NSSearchFieldDelegate {
        let model: NativeSettingsModel
        init(_ model: NativeSettingsModel) { self.model = model }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard NSStringFromSelector(selector) == "cancelOperation:", !model.query.isEmpty else { return false }
            control.stringValue = ""; model.query = ""; return true
        }
        func controlTextDidChange(_ notification: Notification) { if let field = notification.object as? NSSearchField { model.query = field.stringValue } }
    }
}
