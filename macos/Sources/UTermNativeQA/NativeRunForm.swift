import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct NativeRunViewport: NSViewRepresentable {
    @Binding var width: CGFloat
    func makeNSView(context: Context) -> Reader { Reader() }
    func updateNSView(_ view: Reader, context: Context) { view.changed = { width = $0 }; view.refresh() }
    static func dismantleNSView(_ view: Reader, coordinator: ()) { view.stopObserving() }
    @MainActor final class Reader: NSView {
        var changed: ((CGFloat) -> Void)?
        private var observer: NSObjectProtocol?
        private var previous: CGFloat?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow(); stopObserving(); previous = nil
            if let window {
                observer = NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak self] _ in
                    Task { @MainActor [weak self] in self?.refresh() }
                }
            }
            refresh()
        }
        func stopObserving() { if let observer { NotificationCenter.default.removeObserver(observer) }; observer = nil }
        func refresh() {
            guard let value = window?.contentView?.bounds.width, value > 0, value != previous else { return }
            previous = value
            Task { @MainActor [weak self] in
                guard let self, self.window?.contentView?.bounds.width == value else { return }
                self.changed?(value)
            }
        }
    }
}

struct NativeRunToolbarSpace: LayoutValueKey { static let defaultValue = false }

struct NativeRunToolbarLayout: Layout {
    private func items(_ subviews: Subviews) -> [CoreChromeLayout.HeaderItem] {
        subviews.enumerated().map { index, view in
            let size = view.sizeThatFits(.unspecified)
            return .init(view[NativeRunToolbarSpace.self] ? "spacer" : String(index), width: Double(size.width), height: Double(size.height))
        }
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let values = items(subviews), width = proposal.width ?? CGFloat(values.reduce(0) { $0 + $1.width } + Double(max(0, values.count - 1)) * 6)
        return CGSize(width: width, height: CGFloat(RunPanelLayout.toolbar(width: Double(width), items: values).height))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let flow = RunPanelLayout.toolbar(width: Double(bounds.width), items: items(subviews))
        for (view, frame) in zip(subviews, flow.frames) {
            view.place(at: CGPoint(x: bounds.minX + CGFloat(frame.x), y: bounds.minY + CGFloat(frame.y)), anchor: .topLeading,
                       proposal: ProposedViewSize(width: CGFloat(frame.width), height: CGFloat(frame.height)))
        }
    }
}

@MainActor
struct NativeRunFormField<Content: View>: View {
    let title: String
    let id: String?
    let content: Content
    init(_ title: String, id: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title; self.id = id; self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 11)).foregroundStyle(.secondary)
            content
        }.frame(maxWidth: .infinity, alignment: .topLeading)
            .background { if let id { NativeRunPanelFrame(identifier: id) } }
    }
}

@MainActor
struct NativeRunDisclosure<Content: View>: View {
    let title: String
    let id: String
    @Binding var expanded: Bool
    let content: Content
    init(_ title: String, id: String, expanded: Binding<Bool>, @ViewBuilder content: () -> Content) {
        self.title = title; self.id = id; self._expanded = expanded; self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            NativeRunDisclosureButton(title: title, id: id, expanded: $expanded).fixedSize()
                .frame(maxWidth: .infinity, alignment: .leading)
            if expanded { content }
        }
    }
}

@MainActor
private struct NativeRunDisclosureButton: NSViewRepresentable {
    let title: String
    let id: String
    @Binding var expanded: Bool
    func makeCoordinator() -> NativeRunAction.Coordinator { NativeRunAction.Coordinator { expanded.toggle() } }
    func makeNSView(context: Context) -> NSButton {
        let button = DisclosureButton(title: "", target: context.coordinator, action: #selector(NativeRunAction.Coordinator.activate))
        button.isBordered = false; button.font = .systemFont(ofSize: 11)
        button.identifier = .init(id); button.setAccessibilityIdentifier(id)
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.action = { expanded.toggle() }; button.title = title
        button.isEnabled = context.environment.isEnabled; button.contentTintColor = .secondaryLabelColor
        let image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
        image?.size = NSSize(width: 7, height: 7); button.image = image; button.imagePosition = .imageLeading
        button.setAccessibilityLabel(title); button.setAccessibilityValue(expanded)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSButton, context: Context) -> CGSize? {
        CGSize(width: ceil((title as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 11)]).width) + 15, height: 14)
    }
    @MainActor private final class DisclosureButton: NSButton {
        override var acceptsFirstResponder: Bool { isEnabled }
    }
}

@MainActor
struct NativeRunConfiguration<Content: View>: View {
    let maximumHeight: CGFloat
    let content: Content
    @State private var contentHeight: CGFloat = 180
    init(maximumHeight: CGFloat, @ViewBuilder content: () -> Content) {
        self.maximumHeight = maximumHeight; self.content = content()
    }
    var body: some View {
        ScrollView {
            content.frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(GeometryReader { geometry in Color.clear.preference(key: RunConfigurationHeight.self, value: geometry.size.height) })
        }
        .frame(height: min(maximumHeight, max(0, contentHeight)))
        .onPreferenceChange(RunConfigurationHeight.self) { value in Task { @MainActor in contentHeight = value } }
    }
}

private struct RunConfigurationHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

@MainActor
struct NativeRunAction: NSViewRepresentable {
    let title: String
    let id: String
    let palette: JSONValue
    var icon: CoreToolbarIcon? = nil
    var iconOnly = false
    var primary = false
    var height: CGFloat = 34
    let action: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(action) }
    func makeNSView(context: Context) -> NSButton {
        let button = ActionButton(title: "", target: context.coordinator, action: #selector(Coordinator.activate))
        button.isBordered = false; button.wantsLayer = true
        button.focusRingType = .exterior
        button.layer?.cornerRadius = 5; button.layer?.borderWidth = 1
        button.identifier = .init(id); button.setAccessibilityIdentifier(id)
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.action = action; button.isEnabled = context.environment.isEnabled
        button.toolTip = title; button.setAccessibilityLabel(title)
        let text = primary ? NSColor.white : NativePreferences.color(palette["text"], fallback: .labelColor)
        button.attributedTitle = NSAttributedString(string: iconOnly ? "" : title, attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: text])
        button.contentTintColor = text
        let image = icon.map { NativeChromeImages.toolbar($0).copy() as! NSImage }; image?.size = NSSize(width: 16, height: 16)
        button.image = image; button.imagePosition = image == nil ? .noImage : iconOnly ? .imageOnly : .imageLeading
        button.layer?.backgroundColor = (primary ? NSColor(calibratedRed: 40.0 / 255, green: 119.0 / 255, blue: 68.0 / 255, alpha: 1) : NativePreferences.color(palette["surface"], fallback: .controlBackgroundColor)).cgColor
        button.layer?.borderColor = (primary ? NSColor(calibratedRed: 74.0 / 255, green: 155.0 / 255, blue: 100.0 / 255, alpha: 1) : NativePreferences.color(palette["border"], fallback: .separatorColor)).cgColor
        button.alphaValue = button.isEnabled ? 1 : 0.45
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSButton, context: Context) -> CGSize? {
        CGSize(width: iconOnly ? height : ceil(nsView.attributedTitle.size().width) + 20 + (icon == nil ? 0 : 24), height: height)
    }
    @MainActor final class Coordinator: NSObject {
        var action: () -> Void
        init(_ action: @escaping () -> Void) { self.action = action }
        @objc func activate() { action() }
    }
    @MainActor private final class ActionButton: NSButton {
        override var acceptsFirstResponder: Bool { isEnabled }
    }
}

@MainActor
struct NativeRunTextField: NSViewRepresentable {
    @Binding var text: String
    let label: String
    let id: String
    let palette: JSONValue
    var completions: [String]? = nil
    func makeCoordinator() -> Coordinator { Coordinator($text) }
    func makeNSView(context: Context) -> NSTextField {
        let field: NSTextField
        if completions != nil {
            let combo = NSComboBox(); combo.completes = true; combo.hasVerticalScroller = true
            field = combo
        } else { field = NSTextField() }
        field.delegate = context.coordinator; field.identifier = .init(id)
        field.setAccessibilityIdentifier(id); field.setAccessibilityLabel(label)
        field.font = .systemFont(ofSize: 12); field.bezelStyle = .roundedBezel
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }
    func updateNSView(_ field: NSTextField, context: Context) {
        context.coordinator.value = $text; context.coordinator.updating = true
        defer { context.coordinator.updating = false }
        field.isEnabled = context.environment.isEnabled
        field.textColor = NativePreferences.color(palette["text"], fallback: .labelColor)
        field.backgroundColor = NativePreferences.color(palette["surface"], fallback: .textBackgroundColor)
        if let combo = field as? NSComboBox, let completions, combo.objectValues.compactMap({ $0 as? String }) != completions {
            let draft = field.stringValue
            combo.removeAllItems(); combo.addItems(withObjectValues: completions); field.stringValue = draft
        }
        if field.currentEditor() == nil && field.stringValue != text { field.stringValue = text }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSTextField, context: Context) -> CGSize? {
        CGSize(width: max(0, proposal.width ?? 160), height: 28)
    }
    @MainActor final class Coordinator: NSObject, NSComboBoxDelegate {
        var value: Binding<String>
        var updating = false
        init(_ value: Binding<String>) { self.value = value }
        func controlTextDidChange(_ notification: Notification) {
            guard !updating, let field = notification.object as? NSTextField, field.isEnabled else { return }
            value.wrappedValue = field.stringValue
        }
        func comboBoxSelectionDidChange(_ notification: Notification) {
            guard !updating, let field = notification.object as? NSComboBox, field.isEnabled,
                  let selected = field.objectValueOfSelectedItem as? String else { return }
            value.wrappedValue = selected
        }
    }
}

@MainActor
struct NativeRunTaskState: View {
    let running: Bool
    let busy: Bool
    let selected: JSONValue
    var successLabel = false
    private var title: String {
        if running { return localized("Process running", "进程运行中") }
        if busy { return localized("Reading…", "正在读取…") }
        if selected != .null {
            if successLabel && selected["code"].number == 0 { return localized("Task succeeded", "任务成功") }
            return localized("Exited, code ", "已退出，退出码 ") + (selected["code"].number.map { String(Int($0)) } ?? localized("unknown", "未知"))
        }
        return localized("Not running", "未运行")
    }
    var body: some View {
        HStack(spacing: 6) { Circle().fill(running ? Color.green : Color.secondary).frame(width: 6, height: 6); Text(title) }
            .font(.system(size: 11)).accessibilityLabel(title)
    }
}

@MainActor
struct NativeRunLogToolbar: View {
    let terminal: TerminalSession
    @Binding var search: String
    let summary: String
    let taskName: String
    let find: (Bool) -> Void
    let copy: () -> Void
    @State private var searching = false
    @FocusState private var searchFocused: Bool
    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                Text(localized("Run log", "运行日志")).fixedSize()
                if !taskName.isEmpty { Text(taskName).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }
                Spacer(minLength: 0)
                Toggle(localized("Auto follow", "自动跟随"), isOn: Binding(get: { terminal.taskLogFollowsOutput }, set: { terminal.followTaskLog($0) }))
                    .toggleStyle(.checkbox).fixedSize()
                Button(action: copy) { Image(nsImage: NativeChromeImages.toolbar(.copy)).resizable().frame(width: 14, height: 14) }.help(localized("Copy retained output", "复制保留的输出"))
                Button { searching.toggle(); searchFocused = searching } label: { Image(nsImage: NativeChromeImages.toolbar(.search)).resizable().frame(width: 14, height: 14) }.help(localized("Search output", "搜索输出"))
            }
            if searching {
                HStack(spacing: 6) {
                    TextField(localized("Search output", "搜索输出"), text: $search).focused($searchFocused).onSubmit { find(false) }
                        .onExitCommand { searching = false; searchFocused = false }
                        .onChange(of: search) { _, value in if value.isEmpty { find(false) } }
                    Button("↑") { find(true) }.accessibilityLabel(localized("Previous match", "上一个匹配"))
                    Button("↓") { find(false) }.accessibilityLabel(localized("Next match", "下一个匹配"))
                    Text(summary).font(.system(size: 11))
                }
            }
        }.font(.system(size: 11)).buttonStyle(.borderless).padding(8)
    }
}
