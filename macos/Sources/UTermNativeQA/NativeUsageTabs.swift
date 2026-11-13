import AppKit
import SwiftUI

@MainActor
struct NativeUsageTabs: NSViewRepresentable {
    @ObservedObject var model: AgentSettingsModel
    func makeCoordinator() -> Coordinator { Coordinator(model) }
    func makeNSView(context: Context) -> NSSegmentedControl {
        let tabs = NSSegmentedControl(labels: AgentSettingsModel.usageAgents, trackingMode: .selectOne, target: context.coordinator, action: #selector(Coordinator.select(_:)))
        tabs.identifier = .init("native-agent-usage-tabs")
        tabs.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return tabs
    }
    func updateNSView(_ tabs: NSSegmentedControl, context: Context) {
        for (index, id) in AgentSettingsModel.usageAgents.enumerated() {
            tabs.setLabel(model.definitions.first { $0["id"].string == id }?["name"].string ?? id.capitalized, forSegment: index)
            tabs.setWidth(0, forSegment: index)
        }
        tabs.selectedSegment = AgentSettingsModel.usageAgents.firstIndex(of: model.usageSelected) ?? 0
        tabs.isEnabled = context.environment.isEnabled && !model.busy && !model.frozen
        tabs.setAccessibilityLabel(localized("Usage", "用量"))
    }
    @MainActor final class Coordinator: NSObject {
        let model: AgentSettingsModel
        init(_ model: AgentSettingsModel) { self.model = model }
        @objc func select(_ tabs: NSSegmentedControl) {
            guard tabs.isEnabled, AgentSettingsModel.usageAgents.indices.contains(tabs.selectedSegment) else { return }
            model.usageSelected = AgentSettingsModel.usageAgents[tabs.selectedSegment]
            model.updateUsagePolling()
        }
    }
}
