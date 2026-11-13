import AppKit
import SwiftUI

@MainActor
struct NativeAgentField: NSViewRepresentable {
    @ObservedObject var model: AgentSettingsModel
    let key: ReferenceWritableKeyPath<AgentSettingsModel, String>
    let id: String
    let title: String
    func makeCoordinator() -> Coordinator { Coordinator(model: model, key: key) }
    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField()
        field.identifier = .init("native-agent-field-" + id); field.delegate = context.coordinator
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }
    func updateNSView(_ field: NSTextField, context: Context) {
        field.setAccessibilityLabel(title)
        field.isEnabled = context.environment.isEnabled && !model.busy && !model.frozen
        let value = model[keyPath: key]
        if field.currentEditor() == nil && field.stringValue != value { field.stringValue = value }
    }
    @MainActor final class Coordinator: NSObject, NSTextFieldDelegate {
        let model: AgentSettingsModel
        let key: ReferenceWritableKeyPath<AgentSettingsModel, String>
        init(model: AgentSettingsModel, key: ReferenceWritableKeyPath<AgentSettingsModel, String>) { self.model = model; self.key = key }
        func controlTextDidChange(_ notification: Notification) {
            if let field = notification.object as? NSTextField { model[keyPath: key] = field.stringValue }
        }
    }
}
