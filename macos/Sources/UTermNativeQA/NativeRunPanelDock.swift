import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct NativeDockedRunPanel: View {
    @ObservedObject var model: WorkspaceModel
    @ObservedObject var panels: NativeWorkspacePanels
    let panel: NativeWorkspacePanels.Panel
    let layout: RunPanelLayout
    let available: Double
    let viewport: Double
    private var expanded: Bool { panels.runExpanded(panel.id) }
    private var palette: JSONValue { NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog) }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(panel.runKind == "python" ? localized("Python run", "Python 运行") : localized("Build and run", "构建与运行")).bold()
                Text(directory).font(.caption).lineLimit(1).truncationMode(.middle).help(directory)
                Spacer(minLength: 0)
                NativeDocumentAction(title: expanded ? localized("Restore run panel", "还原运行面板") : localized("Expand run panel", "展开运行面板"), identifier: "native-run-panel-expand-" + panel.id, image: NativeChromeImages.toolbar(expanded ? .restore : .maximize), iconOnly: true, active: expanded, tint: tint) { panels.toggleRunExpanded(panel.id) }.frame(width: 28, height: 28)
                NativeDocumentAction(title: localized("Hide run panel", "隐藏运行面板"), identifier: "native-run-panel-hide-" + panel.id, image: NativeChromeImages.toolbar(.close), iconOnly: true, active: false, tint: tint) { panels.close(panel.id) }.frame(width: 28, height: 28)
            }
            .padding(.horizontal, 8).frame(height: CGFloat(CoreChrome.runPanelHeaderHeight))
            NativeHostedPanel(panel: panel).id(panel.id)
        }
        .background(Color(nsColor: NativePreferences.color(palette["canvas"], fallback: .windowBackgroundColor)))
        .background(NativeRunPanelFrame(identifier: "native-run-panel-frame-" + panel.id))
        .overlay(alignment: .top) { Color(nsColor: NativePreferences.color(palette["border"], fallback: .separatorColor)).frame(height: 1) }
        .overlay(alignment: .top) {
            if !expanded {
                NativeRunPanelResizer(identifier: "native-run-panel-resize-" + panel.id, layout: layout) { requested in
                    guard model.inspectorContextKey == panel.scope else { return }
                    panels.resizeRun(panel.id, requested: requested, available: available, viewport: viewport)
                }.frame(height: 8).offset(y: -4)
            }
        }
        .disabled(model.workspaceModalPresented)
        .accessibilityIdentifier("native-run-panel-dock-" + panel.id)
    }
    private var tint: NSColor { NativePreferences.color(palette["muted"], fallback: .secondaryLabelColor) }
    private var directory: String { (panel.controller as? JavaWindow)?.model.directory ?? (panel.controller as? PythonWindow)?.model.directory ?? "" }
}

@MainActor
private struct NativeRunPanelResizer: NSViewRepresentable {
    let identifier: String
    let layout: RunPanelLayout
    let resize: (Double?) -> Void
    func makeNSView(context: Context) -> RunPanelResizeView { RunPanelResizeView() }
    func updateNSView(_ view: RunPanelResizeView, context: Context) {
        view.identifier = .init(identifier); view.setAccessibilityIdentifier(identifier)
        view.layout = layout; view.resize = resize; view.enabled = context.environment.isEnabled
        view.setAccessibilityRole(.splitter); view.setAccessibilityOrientation(.horizontal)
        view.setAccessibilityLabel(localized("Resize run panel height", "调整运行面板高度"))
        view.setAccessibilityValue(layout.height); view.setAccessibilityMinValue(layout.minimum); view.setAccessibilityMaxValue(layout.maximum)
    }
}

@MainActor
private final class RunPanelResizeView: NSView {
    var layout = RunPanelLayout(kind: "java", available: 0, viewport: 0, requested: nil)
    var resize: ((Double?) -> Void)?
    var enabled = true { didSet { if !enabled { cancelOperation(nil) } } }
    private var drag: (y: CGFloat, height: Double)?
    override var acceptsFirstResponder: Bool { enabled }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { enabled }
    override func resetCursorRects() { if enabled { addCursorRect(bounds, cursor: .resizeUpDown) } }
    override func mouseDown(with event: NSEvent) {
        guard enabled else { return }
        window?.makeFirstResponder(self)
        if event.clickCount == 2 { drag = nil; resize?(nil); return }
        drag = (NSEvent.mouseLocation.y, layout.height)
    }
    override func mouseDragged(with event: NSEvent) {
        guard enabled, let drag else { return }
        resize?(drag.height + Double(NSEvent.mouseLocation.y - drag.y))
    }
    override func mouseUp(with event: NSEvent) {
        if drag != nil { mouseDragged(with: event) }; drag = nil
    }
    override func cancelOperation(_ sender: Any?) {
        if let drag { resize?(drag.height) }; drag = nil
    }
    override func keyDown(with event: NSEvent) {
        guard enabled, event.modifierFlags.intersection([.command, .option, .control]).isEmpty else { super.keyDown(with: event); return }
        switch event.keyCode {
        case 126: resize?(layout.height + CoreChrome.runPanelResizeStep)
        case 125: resize?(layout.height - CoreChrome.runPanelResizeStep)
        case 115: resize?(layout.minimum)
        case 119: resize?(layout.maximum)
        case 53: cancelOperation(nil)
        default: super.keyDown(with: event)
        }
    }
    override func accessibilityPerformIncrement() -> Bool { guard enabled else { return false }; resize?(layout.height + CoreChrome.runPanelResizeStep); return true }
    override func accessibilityPerformDecrement() -> Bool { guard enabled else { return false }; resize?(layout.height - CoreChrome.runPanelResizeStep); return true }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); if window == nil { cancelOperation(nil) } }
}

@MainActor
private struct NativeRunPanelFrame: NSViewRepresentable {
    let identifier: String
    final class FrameView: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
    func makeNSView(context: Context) -> FrameView { FrameView() }
    func updateNSView(_ view: FrameView, context: Context) { view.identifier = .init(identifier) }
}
