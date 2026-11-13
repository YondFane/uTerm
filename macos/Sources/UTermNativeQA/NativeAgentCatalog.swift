import AppKit
import SwiftUI

@MainActor
struct NativeAgentSearch: NSViewRepresentable {
    @ObservedObject var model: AgentSettingsModel
    func makeCoordinator() -> Coordinator { Coordinator(model) }
    func makeNSView(context: Context) -> NSSearchField {
        let field = NSSearchField()
        field.identifier = .init("native-agent-search"); field.delegate = context.coordinator
        field.sendsSearchStringImmediately = true
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }
    func updateNSView(_ field: NSSearchField, context: Context) {
        field.placeholderString = localized("Search Agents", "搜索 Agent"); field.setAccessibilityLabel(field.placeholderString)
        field.isEnabled = context.environment.isEnabled && !model.busy && !model.frozen
        if field.currentEditor() == nil && field.stringValue != model.query { field.stringValue = model.query }
    }
    @MainActor final class Coordinator: NSObject, NSSearchFieldDelegate {
        let model: AgentSettingsModel
        init(_ model: AgentSettingsModel) { self.model = model }
        func controlTextDidChange(_ notification: Notification) {
            if let field = notification.object as? NSSearchField { model.query = field.stringValue }
        }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard NSStringFromSelector(selector) == "cancelOperation:", !model.query.isEmpty else { return false }
            control.stringValue = ""; model.query = ""; return true
        }
    }
}

@MainActor
struct NativeAgentCatalogPicker: NSViewRepresentable {
    enum Kind: Equatable { case filter, agent }
    @ObservedObject var model: AgentSettingsModel
    let kind: Kind
    func makeCoordinator() -> Coordinator { Coordinator(model, kind: kind) }
    func makeNSView(context: Context) -> NSPopUpButton {
        let picker = NSPopUpButton(frame: .zero, pullsDown: false)
        picker.target = context.coordinator; picker.action = #selector(Coordinator.choose(_:))
        picker.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return picker
    }
    func updateNSView(_ picker: NSPopUpButton, context: Context) {
        let isFilter = kind == .filter
        picker.identifier = .init(isFilter ? "native-agent-filter" : "native-agent-selection")
        picker.setAccessibilityLabel(isFilter ? localized("Filter Agents", "筛选 Agent") : "Agent")
        picker.removeAllItems()
        let items: [(String, String)] = isFilter ? [
            ("all", localized("All Agents", "全部 Agent")),
            ("available", localized("Available", "可用")),
            ("enabled", localized("Enabled", "已启用"))
        ] : model.visibleIdentifiers.map { ($0, model.displayName($0)) }
        for (id, title) in items { picker.addItem(withTitle: title); picker.lastItem?.representedObject = id }
        let selected = isFilter ? model.filter : model.selected
        if let item = picker.itemArray.first(where: { $0.representedObject as? String == selected }) { picker.select(item) }
        else {
            // Filtering never selects another command or discards its existing draft.
            // 筛选不会选择另一条命令，也不会丢弃已有草稿。
            picker.insertItem(withTitle: items.isEmpty ? localized("No matching entries.", "没有匹配的条目。") : localized("Choose an Agent", "选择 Agent"), at: 0)
            picker.item(at: 0)?.isEnabled = false; picker.selectItem(at: 0)
        }
        picker.isEnabled = context.environment.isEnabled && !model.busy && !model.frozen && !items.isEmpty
    }
    @MainActor final class Coordinator: NSObject {
        let model: AgentSettingsModel
        let kind: Kind
        init(_ model: AgentSettingsModel, kind: Kind) { self.model = model; self.kind = kind }
        @objc func choose(_ picker: NSPopUpButton) {
            guard picker.isEnabled, !model.busy, !model.frozen, let id = picker.selectedItem?.representedObject as? String else { return }
            if kind == .filter {
                guard ["all", "available", "enabled"].contains(id) else { return }; model.filter = id
            } else if model.visibleIdentifiers.contains(id) { model.select(id) }
        }
    }
}
