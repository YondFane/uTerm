import AppKit
import SwiftUI

@MainActor
struct NativeSettingsSearch: NSViewRepresentable {
    @ObservedObject var model: NativeSettingsModel
    func makeNSView(context: Context) -> Field {
        let field = Field(); field.identifier = .init("native-settings-search")
        field.delegate = context.coordinator; field.sendsSearchStringImmediately = true
        field.clearRequested = { [weak model] in model?.query = "" }
        return field
    }
    func updateNSView(_ field: Field, context: Context) {
        field.placeholderString = localized("Search settings", "搜索设置"); field.setAccessibilityLabel(field.placeholderString)
        field.isEnabled = !model.busy && !model.frozen
        if field.currentEditor() == nil && field.stringValue != model.query { field.stringValue = model.query }
    }
    func makeCoordinator() -> Coordinator { Coordinator(model) }
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
