import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct NativeSettingsField: NSViewRepresentable {
    @ObservedObject var model: NativeSettingsModel
    let key: String
    let numeric: Bool
    let label: String
    func makeCoordinator() -> Coordinator { Coordinator(model: model, key: key, numeric: numeric) }
    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField()
        field.identifier = .init("native-settings-field-" + key)
        field.delegate = context.coordinator
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }
    func updateNSView(_ field: NSTextField, context: Context) {
        field.setAccessibilityLabel(label)
        field.isEnabled = context.environment.isEnabled && !model.busy && !model.frozen
        let value = numeric ? model.numbers[key] ?? "" : model.values[key]?.string ?? ""
        if field.currentEditor() == nil && field.stringValue != value { field.stringValue = value }
    }
    @MainActor final class Coordinator: NSObject, NSTextFieldDelegate {
        let model: NativeSettingsModel
        let key: String
        let numeric: Bool
        init(model: NativeSettingsModel, key: String, numeric: Bool) { self.model = model; self.key = key; self.numeric = numeric }
        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField else { return }
            if numeric { model.numbers[key] = field.stringValue }
            else { model.values[key] = .string(field.stringValue) }
        }
        func controlTextDidEndEditing(_ notification: Notification) { model.saveAutomatically([key]) }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard NSStringFromSelector(selector) == "insertNewline:" else { return false }
            control.window?.makeFirstResponder(nil)
            return true
        }
    }
}
