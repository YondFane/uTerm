import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct WorkspaceView: View {
    @ObservedObject var model: WorkspaceModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceToolbar(model: model)
            Divider()
            HSplitView {
                if model.sidebarVisible {
                VStack(spacing: 0) {
                    NativeSidebarNavigation(model: model)
                    NativeSidebar(model: model).frame(maxHeight: .infinity)
                    HStack {
                        Button { model.newWorkspace() } label: { Label(localized("New workspace", "新建工作区"), systemImage: "plus") }
                        Button { model.renameWorkspace() } label: { Label(localized("Rename workspace", "重命名工作区"), systemImage: "pencil") }
                        Spacer()
                    }.labelStyle(.iconOnly).buttonStyle(.borderless).padding(12).disabled(model.busy || !model.ready || model.gitFavoritesRecoveryPresented)
                }
                .frame(minWidth: 176, idealWidth: 220, maxWidth: 320)
                }
                if model.inspectorVisible && model.settings["inspectorPosition"].string == "left" { inspector }
                VStack(spacing: 0) {
                    if !model.terminalError.isEmpty {
                        HStack { Text(model.terminalError).font(.caption).textSelection(.enabled); Spacer(); Button(localized("Reconnect", "重新连接")) { Task { await model.reconnectTransport() } } }.padding(8)
                    }

                    if !model.error.isEmpty {
                        HStack {
                            Text(model.error).font(.caption).textSelection(.enabled).lineLimit(3)
                            Spacer()
                            Button(localized("Reload", "重新读取")) { Task { await model.reload() } }
                            Button(localized("Recovery copies", "恢复副本")) { model.recover() }
                        }.padding(8)
                    }
                    NativeSessionTabs(model: model)
                    if let session = model.selectedTerminal {
                        HStack {
                            Text(model.state?.sessions.first { $0.sessionID == session.id }?.session["name"].string ?? "")
                            if !session.activityLabel.isEmpty { Text(session.activityLabel).foregroundStyle(.secondary) }
                            Spacer()
                            if session.exited { Text(localized("Exited", "已退出")).foregroundStyle(.secondary) }
                            if session.inputControl?.owned == false {
                                Text(localized("Read-only attachment", "只读连接")).foregroundStyle(.secondary)
                                InputControlButton(session: session)
                            }
                            Button(localized("Reconnect", "重新连接")) { Task { await session.reconnect() } }
                            Button(localized("Close session", "关闭会话")) { Task { await model.closeSession() } }
                                .disabled(model.busy || model.gitFavoritesRecoveryPresented)
                        }.font(.caption).padding(.horizontal, 10).frame(height: 30)
                        if !session.error.isEmpty { Text(session.error).font(.caption).foregroundStyle(.red).textSelection(.enabled).padding(6) }
                        if session.activityUnavailable { Text(localized("Agent activity is unavailable. Reconnect to retry.", "Agent 活动暂不可用，请重新连接后重试。")).font(.caption).foregroundStyle(.red).padding(6) }
                    }
                    TerminalCanvas(model: model).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .frame(minWidth: 220)
                if model.inspectorVisible && model.settings["inspectorPosition"].string != "left" { inspector }
            }
            .padding(CGFloat(model.settings["windowPadding"].number ?? 10))
        }
        .font(.custom(NativePreferences.font(model.settings["interfaceFont"].string ?? "", size: CGFloat(model.settings["interfaceSize"].number ?? 13)).fontName, size: CGFloat(model.settings["interfaceSize"].number ?? 13)))
        .foregroundStyle(Color(nsColor: NativePreferences.color(NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog)["text"], fallback: .labelColor)))
        .background(Color(nsColor: NativePreferences.color(NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog)["canvas"], fallback: .windowBackgroundColor)).opacity(model.settings["opacity"].number ?? 1))
        .background(NativeWindowMaterial(enabled: model.settings["blur"].bool == true))
        .ignoresSafeArea(.container, edges: .top)
        .overlay(alignment: .bottomTrailing) {
            if model.breakReminderVisible {
                VStack(alignment: .leading, spacing: 8) {
                    Text(localized("Break reminder", "休息提醒")).font(.headline)
                    Text(localized("Time for a break. Get up and move around.", "该休息一下了，起来活动活动吧。"))
                    Text(localized("Closes in 10 seconds. You can keep working.", "10 秒后自动关闭，不影响继续使用。")).font(.caption)
                    BreakDismissButton(model: model)
                }.padding(16).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10)).padding(20)
            }
        }
        .onChange(of: colorScheme) { _, _ in if model.settings["appearance"].string == "system" { Task { await model.reload() } } }
        .sheet(item: Binding(get: { model.nameDraftOwner == .workspace ? model.nameDraft : nil }, set: { if model.nameDraftOwner == .workspace { model.nameDraft = $0 } })) { _ in NameEditorView(model: model) }
    }
    private var inspector: some View { InspectorHost(model: model).frame(minWidth: 220, idealWidth: 300, maxWidth: 420) }
}

@MainActor
private struct BreakDismissButton: NSViewRepresentable {
    let model: WorkspaceModel
    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(title: "", target: context.coordinator, action: #selector(Coordinator.dismiss))
        button.bezelStyle = .rounded
        button.identifier = NSUserInterfaceItemIdentifier("native-break-dismiss")
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) { button.title = localized("Continue working", "继续使用") }
    @MainActor final class Coordinator: NSObject {
        let model: WorkspaceModel
        init(model: WorkspaceModel) { self.model = model }
        @objc func dismiss() { model.dismissBreakReminder() }
    }
}

@MainActor
private struct NativeWindowMaterial: NSViewRepresentable {
    let enabled: Bool
    func makeNSView(context: Context) -> NSVisualEffectView { NSVisualEffectView() }
    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = .underWindowBackground; view.blendingMode = .behindWindow
        view.state = enabled ? .active : .inactive; view.isHidden = !enabled
    }
}

@MainActor
private struct InputControlButton: NSViewRepresentable {
    let session: TerminalSession
    func makeCoordinator() -> Coordinator { Coordinator(session) }
    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(title: "", target: context.coordinator, action: #selector(Coordinator.takeControl))
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.identifier = NSUserInterfaceItemIdentifier("native-terminal-take-control")
        button.setAccessibilityIdentifier("native-terminal-take-control")
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.session = session
        button.title = localized("Take input control", "接管输入")
        button.isEnabled = context.environment.isEnabled && !session.takingInputControl && !session.exited
    }
    @MainActor final class Coordinator: NSObject {
        var session: TerminalSession
        init(_ session: TerminalSession) { self.session = session }
        @objc func takeControl() { Task { await session.takeInputControl() } }
    }
}

@MainActor
struct NameEditorView: View {
    @ObservedObject var model: WorkspaceModel
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.nameDraft?.target == nil ? localized("New workspace", "新建工作区") : localized("Rename workspace", "重命名工作区")).font(.headline)
            TextField(localized("Name", "名称"), text: Binding(get: { model.nameDraft?.name ?? "" }, set: { model.nameDraft?.name = $0 }))
                .onSubmit { Task { await model.saveNameDraft() } }
            if !model.error.isEmpty {
                Text(model.error).font(.caption).textSelection(.enabled)
                Button(localized("Reload saved data", "重新读取保存数据")) { Task { await model.reloadNameDraft() } }
                if let target = model.nameDraft?.target, let saved = model.groupItems.first(where: { $0.id == target }) { Text(localized("Saved name: ", "已保存名称：") + saved.name).font(.caption) }
            }
            HStack {
                Spacer()
                Button(localized("Cancel", "取消")) { model.nameDraft = nil }.keyboardShortcut(.cancelAction)
                Button(localized("Save", "保存")) { Task { await model.saveNameDraft() } }.keyboardShortcut(.defaultAction)
                    .disabled(model.nameDraft?.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false)
            }
        }.padding(20).frame(width: 380).disabled(model.busy || model.gitFavoritesRecoveryPresented)
    }
}

extension CoreSessionEntry {
    var sessionID: String { session["id"].string ?? "" }
}

@MainActor
struct LocalControlCheckbox: NSViewRepresentable {
    @ObservedObject var model: WorkspaceModel
    func makeCoordinator() -> Coordinator { Coordinator(model) }
    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(checkboxWithTitle: "", target: context.coordinator, action: #selector(Coordinator.changed(_:)))
        button.identifier = NSUserInterfaceItemIdentifier("native-local-control-toggle")
        button.setAccessibilityIdentifier("native-local-control-toggle")
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.model = model
        button.title = localized("Allow local CLI control", "允许本地 CLI 控制")
        button.state = model.controlStatus["enabled"].bool == true ? .on : .off
        button.isEnabled = context.environment.isEnabled && model.controlStatus["enabled"].bool != nil && !model.controlBusy
    }
    @MainActor final class Coordinator: NSObject {
        var model: WorkspaceModel
        init(_ model: WorkspaceModel) { self.model = model }
        @objc func changed(_ sender: NSButton) {
            let enabled = sender.state == .on
            Task { await model.configureControl(enabled) }
        }
    }
}

@MainActor
struct TerminalCanvas: NSViewRepresentable {
    @ObservedObject var model: WorkspaceModel
    func makeNSView(context: Context) -> CanvasHost { CanvasHost() }
    func updateNSView(_ host: CanvasHost, context: Context) { host.render(model) }
}

@MainActor
final class CanvasHost: NSView {
    private var signature = ""
    private var root: NSView?
    private var focusRevision = -1
    private var splits: [String: SessionSplitView] = [:]

    func render(_ model: WorkspaceModel) {
        let layout = model.paneZoomed && model.selectedID != nil ? JSONValue.object(["kind": .string("leaf"), "session": .string(model.selectedID!)]) : model.state?.layout ?? .null
        func key(_ node: JSONValue) -> String {
            if node["kind"].string == "leaf", let id = node["session"].string {
                // An initially missing view must invalidate the cached placeholder when it arrives.
                // 初始缺失的视图到达时必须使缓存的占位内容失效。
                return id + (model.terminals[id].map { ":" + String(describing: ObjectIdentifier($0.view)) } ?? ":pending")
            }
            if node["kind"].string == "split" { return (node["id"].string ?? "") + key(node["first"]) + key(node["second"]) }
            return "empty"
        }
        let next = key(layout)
        if next != signature || root == nil {
            root?.removeFromSuperview()
            splits.removeAll()
            signature = next
            let view = makePane(layout, model: model)
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
            NSLayoutConstraint.activate([view.leadingAnchor.constraint(equalTo: leadingAnchor), view.trailingAnchor.constraint(equalTo: trailingAnchor), view.topAnchor.constraint(equalTo: topAnchor), view.bottomAnchor.constraint(equalTo: bottomAnchor)])
            root = view
        }
        func apply(_ node: JSONValue) {
            guard node["kind"].string == "split" else { return }
            splits[node["id"].string ?? ""]?.setRatio(node["ratio"].number ?? 0.5)
            apply(node["first"]); apply(node["second"])
        }
        apply(layout)
        if focusRevision != model.focusRevision, let view = model.selectedTerminal?.view {
            focusRevision = model.focusRevision
            DispatchQueue.main.async { [weak self, weak view] in
                guard let self, let view, view.window === self.window else { return }
                self.window?.makeFirstResponder(view)
            }
        }
    }

    private func makePane(_ node: JSONValue, model: WorkspaceModel) -> NSView {
        if node["kind"].string == "leaf", let id = node["session"].string, let view = model.terminals[id]?.view {
            view.removeFromSuperview()
            return view
        }
        if node["kind"].string == "split" {
            let split = SessionSplitView()
            let id = node["id"].string ?? ""
            split.isVertical = node["axis"].string == "horizontal"
            split.addArrangedSubview(makePane(node["first"], model: model))
            split.addArrangedSubview(makePane(node["second"], model: model))
            split.ratio = node["ratio"].number ?? 0.5
            split.changed = { [weak model] ratio in
                guard let model, let roster = model.state?.sessions.first(where: { $0.sessionID == model.selectedID })?.rosterId else { return }
                Task { await model.mutate("session.resize", ["rosterId": .string(roster), "splitId": .string(id), "ratio": .number(ratio)]) }
            }
            splits[id] = split
            return split
        }
        let text = NSTextField(labelWithString: localized("No session is selected.", "尚未选择会话。"))
        text.textColor = .secondaryLabelColor
        text.alignment = .center
        let placeholder = NSView()
        text.translatesAutoresizingMaskIntoConstraints = false
        placeholder.addSubview(text)
        NSLayoutConstraint.activate([text.centerXAnchor.constraint(equalTo: placeholder.centerXAnchor), text.centerYAnchor.constraint(equalTo: placeholder.centerYAnchor)])
        return placeholder
    }
}

@MainActor
final class SessionSplitView: NSSplitView {
    var ratio = 0.5
    var changed: ((Double) -> Void)?
    private var monitor: Any?
    private var lastSize: NSSize = .zero

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        dividerStyle = .thin
        monitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseUp) { [weak self] event in
            guard let self, event.window === self.window, self.arrangedSubviews.count == 2 else { return event }
            let available = (self.isVertical ? self.bounds.width : self.bounds.height) - self.dividerThickness
            let first = self.isVertical ? self.arrangedSubviews[0].frame.width : self.arrangedSubviews[0].frame.height
            guard available > 0 else { return event }
            let next = Double(first / available)
            if abs(next - self.ratio) > 0.005 { self.ratio = next; self.changed?(next) }
            return event
        }
    }
    required init?(coder: NSCoder) { fatalError("Use programmatic construction") }
    override func layout() {
        super.layout()
        if bounds.size != lastSize { lastSize = bounds.size; placeDivider() }
    }
    func setRatio(_ value: Double) {
        guard NSApp.currentEvent?.type != .leftMouseDragged else { return }
        if abs(value - ratio) > 0.001 { ratio = value; placeDivider() }
    }
    private func placeDivider() {
        let available = (isVertical ? bounds.width : bounds.height) - dividerThickness
        if available > 0, arrangedSubviews.count == 2 { setPosition(CGFloat(ratio) * available, ofDividerAt: 0) }
    }
    deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
}
