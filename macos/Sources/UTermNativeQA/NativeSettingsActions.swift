import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct NativeLegacyExportButton: NSViewRepresentable {
    @ObservedObject var model: NativeSettingsModel
    func makeCoordinator() -> Coordinator { Coordinator(model) }
    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(title: "", target: context.coordinator, action: #selector(Coordinator.export(_:)))
        button.identifier = .init("native-settings-legacy-export"); button.bezelStyle = .rounded
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) {
        button.title = localized("Export legacy-compatible data", "导出旧版兼容数据")
        button.font = .systemFont(ofSize: 11)
        button.isEnabled = context.environment.isEnabled && !model.busy && !model.automaticSaving && !model.frozen
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSButton, context: Context) -> CGSize? { CGSize(width: nsView.intrinsicContentSize.width, height: 28) }
    @MainActor final class Coordinator: NSObject {
        let model: NativeSettingsModel
        init(_ model: NativeSettingsModel) { self.model = model }
        @objc func export(_ button: NSButton) { if let window = button.window { model.chooseLegacyExport(over: window) } }
    }
}

@MainActor
struct NativeDefaultAgentPicker: View {
    @ObservedObject var model: NativeSettingsModel
    var body: some View {
        HStack {
            Text(localized("New chat Agent", "新聊天 Agent")); Spacer()
            AgentChoice(model: model).frame(minWidth: 140, idealWidth: 230, maxWidth: 260, minHeight: 24)
        }
    }
    @MainActor private struct AgentChoice: NSViewRepresentable {
        @ObservedObject var model: NativeSettingsModel
        func makeCoordinator() -> Coordinator { Coordinator(model) }
        func makeNSView(context: Context) -> NSPopUpButton {
            let picker = NSPopUpButton(frame: .zero, pullsDown: false)
            picker.identifier = .init("native-settings-default-agent"); picker.target = context.coordinator; picker.action = #selector(Coordinator.select(_:))
            picker.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            return picker
        }
        func updateNSView(_ picker: NSPopUpButton, context: Context) {
            let available = model.agentIDs, stored = model.values["defaultAgent"]?.string ?? ""
            let selected = available.contains(stored) ? stored : available.first ?? ""
            picker.removeAllItems()
            if available.isEmpty { picker.addItem(withTitle: localized("Enable an Agent first", "请先启用 Agent")); picker.lastItem?.representedObject = "" }
            for id in available {
                picker.addItem(withTitle: model.agents["definitions"].array.first { $0["id"].string == id }?["name"].string ?? id)
                picker.lastItem?.representedObject = id
            }
            if let item = picker.itemArray.first(where: { $0.representedObject as? String == selected }) { picker.select(item) }
            picker.isEnabled = context.environment.isEnabled && !model.busy && !model.automaticSaving && !model.frozen && !available.isEmpty
            picker.setAccessibilityLabel(localized("New chat Agent", "新聊天 Agent"))
        }
        @MainActor final class Coordinator: NSObject {
            let model: NativeSettingsModel
            init(_ model: NativeSettingsModel) { self.model = model }
            @objc func select(_ picker: NSPopUpButton) {
                guard picker.isEnabled, let id = picker.selectedItem?.representedObject as? String, model.agentIDs.contains(id) else { return }
                model.values["defaultAgent"] = .string(id); model.saveAutomatically(["defaultAgent"])
            }
        }
    }
}
