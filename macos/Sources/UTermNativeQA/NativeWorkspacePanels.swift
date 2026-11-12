import AppKit
import SwiftUI
import UTermBridge

@MainActor
protocol NativeWorkspacePanelContent: AnyObject {
    var workspacePanelView: NSView? { get }
    func workspaceEmbeddingChanged(_ embedded: Bool)
}

extension NativeWorkspacePanelContent {
    func workspaceEmbeddingChanged(_ embedded: Bool) {}
}

@MainActor
final class NativeWorkspacePanels: ObservableObject {
    struct Panel: Identifiable {
        let id: String
        let title: String
        var scope: String
        let controller: NSWindowController
        let view: NSView
        var runKind: String? { controller is JavaWindow ? "java" : controller is PythonWindow ? "python" : nil }
    }
    var terminalFocusRequested: (() -> Void)?
    @Published private(set) var panels: [Panel] = []
    @Published private var selected: [String: String] = [:]
    @Published private var runHeights: [String: Double] = [:]
    @Published private var expandedRuns: Set<String> = []
    func runLayout(_ panel: Panel, available: Double, viewport: Double) -> RunPanelLayout {
        RunPanelLayout(kind: panel.runKind ?? "", available: available, viewport: viewport, requested: runHeights[panel.id])
    }
    func runExpanded(_ id: String) -> Bool { expandedRuns.contains(id) }
    func toggleRunExpanded(_ id: String) {
        guard let panel = panels.first(where: { $0.id == id && $0.runKind != nil }), active(in: panel.scope)?.id == id else { return }
        if expandedRuns.contains(id) { expandedRuns.remove(id) } else { expandedRuns.insert(id) }
    }
    func resizeRun(_ id: String, requested: Double?, available: Double, viewport: Double) {
        guard let panel = panels.first(where: { $0.id == id && $0.runKind != nil }), active(in: panel.scope)?.id == id else { return }
        let height = RunPanelLayout(kind: panel.runKind ?? "", available: available, viewport: viewport, requested: requested).height
        if runHeights[id] != height { runHeights[id] = height }
    }
    func visible(in scope: String) -> [Panel] { panels.filter { $0.scope == scope } }
    func active(in scope: String) -> Panel? { panels.first { $0.scope == scope && $0.id == selected[scope] } }
    func showTerminal(in scope: String) { selected[scope] = nil }
    func attach(_ controller: NSWindowController, id: String, title: String, scope: String, parent: NSWindow) throws {
        if let index = panels.firstIndex(where: { $0.id == id }) {
            let previous = panels[index].scope
            if previous != scope { selected[previous] = nil; panels[index].scope = scope }
        } else {
            guard controller.window != nil,
                  let view = (controller as? NativeWorkspacePanelContent)?.workspacePanelView ?? controller.window?.contentView else { throw BridgeFailure(code: "PANEL_UNAVAILABLE", message: localized("The panel content is unavailable. Close and reopen the panel.", "面板内容不可用，请关闭后重新打开面板。")) }
            controller.window?.contentView = NSView()
            panels.append(Panel(id: id, title: title, scope: scope, controller: controller, view: view))
        }
        (controller as? NativeWorkspacePanelContent)?.workspaceEmbeddingChanged(true)
        controller.window?.orderOut(nil); selected[scope] = id; parent.makeKeyAndOrderFront(nil)
    }
    func select(_ id: String, scope: String) { if panels.contains(where: { $0.id == id && $0.scope == scope }) { selected[scope] = id } }
    func close(_ id: String) { panels.first { $0.id == id }?.controller.window?.performClose(nil) }
    func remove(_ controller: NSWindowController) {
        (controller as? NativeWorkspacePanelContent)?.workspaceEmbeddingChanged(false)
        let removed = Set(panels.filter { $0.controller === controller }.map(\.id))
        runHeights = runHeights.filter { !removed.contains($0.key) }; expandedRuns.subtract(removed)
        for item in panels where item.controller === controller { if selected[item.scope] == item.id { selected[item.scope] = nil; terminalFocusRequested?() } }
        panels.removeAll { $0.controller === controller }
    }
}

@MainActor
struct NativeHostedPanel: NSViewRepresentable {
    let panel: NativeWorkspacePanels.Panel
    func makeNSView(context: Context) -> NSView {
        let host = NSView(); host.identifier = .init("native-workspace-panel-" + panel.id)
        mount(in: host)
        return host
    }
    private func mount(in host: NSView) {
        guard panel.view.superview !== host else { return }
        host.subviews.forEach { $0.removeFromSuperview() }
        panel.view.removeFromSuperview(); panel.view.translatesAutoresizingMaskIntoConstraints = false; host.addSubview(panel.view)
        NSLayoutConstraint.activate([panel.view.leadingAnchor.constraint(equalTo: host.leadingAnchor), panel.view.trailingAnchor.constraint(equalTo: host.trailingAnchor), panel.view.topAnchor.constraint(equalTo: host.topAnchor), panel.view.bottomAnchor.constraint(equalTo: host.bottomAnchor)])
    }
    func updateNSView(_ host: NSView, context: Context) { mount(in: host) }
    static func dismantleNSView(_ host: NSView, coordinator: ()) { host.subviews.forEach { $0.removeFromSuperview() } }
}
