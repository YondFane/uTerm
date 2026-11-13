import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct NativeSettingsOverlay: View {
    @ObservedObject var model: NativeSettingsModel
    @ObservedObject var workspace: WorkspaceModel
    let close: () -> Void
    private var palette: JSONValue { NativePreferences.interfacePalette(workspace.settings, catalog: model.catalog) }
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                SettingsBackdrop().ignoresSafeArea()
                Color.black.opacity(0.45).ignoresSafeArea().onTapGesture(perform: close)
                VStack(spacing: 0) {
                    HStack {
                        Text(localized("Settings", "设置")).font(.system(size: 17, weight: .semibold))
                        Spacer()
                        SettingsCloseButton(enabled: !model.busy && !model.automaticSaving && !model.agentSettings.busy && !model.frozen && !model.login.busy && !model.maven.busy && !model.databaseComponents.working && !model.javaComponents.pending && !model.javaComponents.mutating, palette: palette, action: close).frame(width: 32, height: 32)
                    }.padding(.horizontal, 24).padding(.vertical, 20)
                    Color(nsColor: NativePreferences.color(palette["border"], fallback: .separatorColor)).frame(height: 1)
                    NativeSettingsView(model: model, workspace: workspace)
                        .frame(height: max(0, min(520, min(geometry.size.height * 0.72, geometry.size.height * 0.88 - 75))))
                }
                .padding(1)
                .frame(width: min(760, geometry.size.width * 0.94), height: min(geometry.size.height * 0.88, 75 + min(520, geometry.size.height * 0.72)))
                .background(GeometryReader { card in
                    Color.clear.onAppear { model.presentationCardFrame = card.frame(in: .named("native-settings-overlay")) }
                        .onChange(of: card.frame(in: .named("native-settings-overlay"))) { _, frame in model.presentationCardFrame = frame }
                })
                .foregroundStyle(Color(nsColor: NativePreferences.color(palette["text"])))
                .background(Color(nsColor: NativePreferences.color(palette["surface"], fallback: .windowBackgroundColor)), in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color(nsColor: NativePreferences.color(palette["border"], fallback: .separatorColor)), lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 9))
                .shadow(color: .black.opacity(0.5), radius: 24, y: 12)
                .contentShape(Rectangle()).onTapGesture {}
            }.coordinateSpace(name: "native-settings-overlay")
            .onAppear { model.presentationWidth = geometry.size.width }
            .onChange(of: geometry.size.width) { _, width in model.presentationWidth = width }
        }
    }
}

@MainActor
private struct SettingsBackdrop: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView(); view.material = .underWindowBackground
        view.blendingMode = .behindWindow; view.state = .active
        return view
    }
    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

@MainActor
private struct SettingsCloseButton: NSViewRepresentable {
    let enabled: Bool
    let palette: JSONValue
    let action: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(action) }
    func makeNSView(context: Context) -> CloseButton {
        let button = CloseButton(title: "", target: context.coordinator, action: #selector(Coordinator.close))
        button.identifier = .init("native-settings-close")
        button.isBordered = false
        return button
    }
    func updateNSView(_ button: CloseButton, context: Context) {
        context.coordinator.action = action; button.isEnabled = enabled
        button.setAccessibilityLabel(localized("Close settings", "关闭设置"))
        button.palette = palette; button.needsDisplay = true
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: CloseButton, context: Context) -> CGSize? { CGSize(width: 32, height: 32) }
    @MainActor final class CloseButton: NSButton {
        var palette: JSONValue = .null
        private var hovered = false
        private var pointerTracking: NSTrackingArea?
        override var acceptsFirstResponder: Bool { isEnabled }
        override func becomeFirstResponder() -> Bool { needsDisplay = true; return super.becomeFirstResponder() }
        override func resignFirstResponder() -> Bool { needsDisplay = true; return super.resignFirstResponder() }
        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let pointerTracking { removeTrackingArea(pointerTracking) }
            let tracking = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
            addTrackingArea(tracking); pointerTracking = tracking
        }
        override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
        override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }
        override func draw(_ dirtyRect: NSRect) {
            let circle = NSRect(x: bounds.midX - 8, y: bounds.midY - 8, width: 16, height: 16)
            NativePreferences.color(.string(isEnabled && (hovered || isHighlighted) ? "#b44e53" : "#707070")).withAlphaComponent(isEnabled ? 1 : 0.45).setFill()
            NSBezierPath(ovalIn: circle).fill()
            NSColor(calibratedWhite: 242.0 / 255, alpha: isEnabled ? 1 : 0.45).setStroke()
            let cross = NSBezierPath(); cross.lineWidth = 2; cross.lineCapStyle = .round
            cross.move(to: NSPoint(x: circle.minX + 5, y: circle.minY + 5)); cross.line(to: NSPoint(x: circle.maxX - 5, y: circle.maxY - 5))
            cross.move(to: NSPoint(x: circle.minX + 5, y: circle.maxY - 5)); cross.line(to: NSPoint(x: circle.maxX - 5, y: circle.minY + 5)); cross.stroke()
            if window?.firstResponder === self { NativePreferences.color(palette["accent"], fallback: .controlAccentColor).setStroke(); let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 4, yRadius: 4); ring.lineWidth = 2; ring.stroke() }
        }
    }
    @MainActor final class Coordinator: NSObject {
        var action: () -> Void
        init(_ action: @escaping () -> Void) { self.action = action }
        @objc func close() { action() }
    }
}

@MainActor
final class NativeSettingsOverlayWindow: NSWindow {
    var closeRequested: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func performClose(_ sender: Any?) { closeRequested?() }
    override func cancelOperation(_ sender: Any?) { closeRequested?() }
}
