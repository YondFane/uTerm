import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct WorkspaceView: View {
    @ObservedObject var model: WorkspaceModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var requestedSidebarWidth = CoreChrome.sidebarDefaultWidth
    @State private var resizeStart: Double?
    @State private var inspectorRatio = CoreChrome.inspectorDefaultRatio
    @State private var inspectorResizeStart: Double?

    var body: some View {
        GeometryReader { geometry in
            let sidebar = CoreChromeLayout.sidebar(available: Double(geometry.size.width), requested: requestedSidebarWidth)
            let sidebarWidth = model.sidebarVisible ? sidebar.width : CoreChrome.sidebarRailWidth
            let tools = CoreChromeLayout.inspector(available: Double(geometry.size.width) - sidebarWidth, ratio: inspectorRatio)
            let regions = model.settings["inspectorPosition"].string == "left" ? ["tools", "main"] : ["main", "tools"]
            HStack(spacing: 0) {
                HStack(spacing: 0) {
                    NativeSidebarRail(model: model)
                    if model.sidebarVisible {
                        VStack(spacing: 0) {
                            NativeSidebarNavigation(model: model)
                            NativeSidebar(model: model).padding(.horizontal, 2).padding(.top, CGFloat(CoreChrome.sidebarListTop)).padding(.bottom, 10).frame(maxHeight: .infinity)
                        }.padding(.horizontal, 10)
                            .frame(width: max(0, CGFloat(sidebarWidth - CoreChrome.sidebarRailWidth)), alignment: .leading)
                    }
                }
                .frame(width: CGFloat(sidebarWidth), alignment: .leading)
                .background(GeometryReader { geometry in
                    Color.clear.onAppear { model.measureSidebar(geometry.size.width) }
                        .onChange(of: geometry.size.width) { _, width in model.measureSidebar(width) }
                })
                .background(Color(nsColor: NativePreferences.color(NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog)["sidebar"], fallback: .windowBackgroundColor)))
                .overlay(alignment: .trailing) {
                    Color(nsColor: .separatorColor).frame(width: 1)

                        .focusable()
                        .accessibilityLabel(localized("Resize sidebar", "调整侧栏宽度"))
                        .accessibilityValue(Text(String(Int(sidebarWidth.rounded()))))
                        .accessibilityAdjustableAction { direction in
                            switch direction {
                            case .increment: resizeSidebar(sidebarWidth + 24, available: Double(geometry.size.width))
                            case .decrement: resizeSidebar(sidebarWidth - 24, available: Double(geometry.size.width))
                            @unknown default: break
                            }
                        }
                        .onKeyPress(.leftArrow) { resizeSidebar(sidebarWidth - 24, available: Double(geometry.size.width)); return .handled }
                        .onKeyPress(.rightArrow) { resizeSidebar(model.sidebarVisible ? sidebarWidth + 24 : CoreChromeLayout.sidebarCollapseWidth + 24, available: Double(geometry.size.width)); return .handled }
                        .onKeyPress(.home) { resizeSidebar(CoreChromeLayout.sidebarCollapseWidth, available: Double(geometry.size.width)); return .handled }
                        .onKeyPress(.end) { resizeSidebar(sidebar.maximum, available: Double(geometry.size.width)); return .handled }
                        .onKeyPress(.return) { resizeSidebar(CoreChrome.sidebarDefaultWidth, available: Double(geometry.size.width)); return .handled }
                        .overlay(Color.clear.frame(width: 8).contentShape(Rectangle()).gesture(
                            DragGesture(minimumDistance: 0).onChanged { value in
                                if resizeStart == nil { resizeStart = sidebarWidth }
                                let requested = (resizeStart ?? sidebarWidth) + Double(value.translation.width)
                                let next = CoreChromeLayout.sidebar(available: Double(geometry.size.width), requested: requested)
                                requestedSidebarWidth = next.width
                                model.sidebarVisible = !next.hidden
                            }.onEnded { _ in resizeStart = nil }
                        ))
                }
                HStack(spacing: 0) {
                    // Moving stable regions retains the WebKit document instead of mounting competing hosts.
                    // 移动稳定标识的区域以保留 WebKit 文档，避免接入相互争用的宿主。
                    ForEach(regions, id: \.self) { region in
                        if region == "tools" {
                            if model.inspectorVisible { inspector(width: tools.width, available: tools.available, height: geometry.size.height) }
                        } else {
                            VStack(spacing: 0) {
                                NativeWorkspaceToolbar(model: model, sidebarWidth: CGFloat(sidebarWidth))
                                if !model.terminalError.isEmpty {
                                    HStack { Text(model.terminalError).font(.caption).textSelection(.enabled); Spacer(); Button(localized("Reconnect", "重新连接")) { Task { await model.reconnectTransport() } } }.padding(8)
                                }

                                if !model.error.isEmpty {
                                    HStack {
                                        Text(model.error).font(.caption).textSelection(.enabled).lineLimit(3)
                                        Spacer()
                                        Button(localized("Reload", "重新读取")) { model.branchPicker.clearOperationError(); Task { await model.reload(clearOperationError: true) } }
                                        Button(localized("Recovery copies", "恢复副本")) { model.recover() }
                                    }.padding(8)
                                }
                                NativeWorkspaceDocumentSurface(model: model, documents: model.documents, panels: model.panels).frame(maxWidth: .infinity, maxHeight: .infinity)
                            }
                            .frame(minWidth: CGFloat(CoreChrome.mainMinimumWidth), maxWidth: .infinity)
                        }
                    }
                }
            }
            .onChange(of: geometry.size.width, initial: true) { _, width in model.measureViewport(width) }
            .onChange(of: model.inspectorVisible) { _, visible in
                inspectorResizeStart = nil
                if visible && tools.width <= CoreChrome.panelCollapseWidth + 1 { inspectorRatio = CoreChrome.inspectorDefaultRatio }
            }
        }
        .font(.custom(NativePreferences.font(model.settings["interfaceFont"].string ?? "", size: CGFloat(model.settings["interfaceSize"].number ?? 13)).fontName, size: CGFloat(model.settings["interfaceSize"].number ?? 13)))
        .foregroundStyle(Color(nsColor: NativePreferences.color(NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog)["text"], fallback: .labelColor)))
        .background(Color(nsColor: NativePreferences.color(NativePreferences.terminalTheme(model.settings, catalog: model.settingsCatalog)["background"], fallback: .textBackgroundColor)).opacity(model.settings["opacity"].number ?? 1))
        .background(NativeWindowMaterial(enabled: model.settings["blur"].bool == true))
        .ignoresSafeArea(.container, edges: .top)
        .blur(radius: model.githubPRContent == nil ? 0 : 4)
        .disabled(model.workspaceModalPresented)
        .overlay {
            if let content = model.workspaceModalContent {
                let pr = content.workbenchHost is GitHubPRHost
                GeometryReader { geometry in
                    ZStack {
                        // WebKit still paints its page canvas; limit it to the form and dim native views separately.
                        // WebKit 仍会绘制页面底色，因此只让它覆盖表单，原生视图另行绘制遮罩。
                        Color.black.opacity((pr ? 119.0 : 136.0) / 255).contentShape(Rectangle())
                            .onTapGesture { if !pr { content.window?.performClose(nil) } }
                        NativeEmbeddedDocument(content: content, modal: true)
                            .id(ObjectIdentifier(content))
                            .frame(width: (pr ? min(640, geometry.size.width * 0.92) : min(540, max(0, geometry.size.width - 32))), height: min(CGFloat(pr ? model.githubPRHeight : model.quickSSHHeight), max(0, geometry.size.height - 48)))
                            .clipShape(RoundedRectangle(cornerRadius: pr ? 9 : 12))
                            .shadow(color: Color(nsColor: NativePreferences.light(model.settings) ? NSColor(srgbRed: 48.0 / 255, green: 43.0 / 255, blue: 37.0 / 255, alpha: 0.125) : .black.withAlphaComponent(0.4)).opacity(pr ? 1 : 0), radius: 30, x: 0, y: 18)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }.ignoresSafeArea(.container, edges: .top)
            }
        }
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
        .onChange(of: model.sidebarVisible) { _, visible in
            if visible && requestedSidebarWidth <= CoreChromeLayout.sidebarCollapseWidth { requestedSidebarWidth = CoreChrome.sidebarDefaultWidth }
        }
        .onChange(of: colorScheme) { _, _ in if model.settings["appearance"].string == "system" { Task { await model.reload() } } }
        .sheet(item: Binding(get: { model.nameDraftOwner == .workspace ? model.nameDraft : nil }, set: { if model.nameDraftOwner == .workspace { model.nameDraft = $0 } })) { _ in NameEditorView(model: model) }
    }
    private func resizeSidebar(_ requested: Double, available: Double) {
        let next = CoreChromeLayout.sidebar(available: available, requested: requested)
        requestedSidebarWidth = next.width
        model.sidebarVisible = !next.hidden
    }
    private func resizeInspector(_ requested: Double, available: Double) {
        inspectorRatio = CoreChromeLayout.inspector(available: available, ratio: requested / available).ratio
        if requested <= CoreChrome.panelCollapseWidth { model.hideInspector() }
    }
    private func inspector(width: Double, available: Double, height: CGFloat) -> some View {
        let left = model.settings["inspectorPosition"].string == "left"
        return InspectorHost(model: model).frame(width: CGFloat(width), height: height).clipped()
            .background(NativeChromeMeasurement { frame in model.measureInspector(frame.width) }.allowsHitTesting(false))
            .overlay(alignment: left ? .trailing : .leading) {
                Color(nsColor: .separatorColor).frame(width: 1)

                    .focusable()
                    .accessibilityLabel(localized("Resize tools", "调整工具面板宽度"))
                    .accessibilityValue(Text(String(Int((width / available * 100).rounded())) + "%"))
                    .accessibilityAdjustableAction { direction in
                        switch direction {
                        case .increment: resizeInspector(width + 24, available: available)
                        case .decrement: resizeInspector(width - 24, available: available)
                        @unknown default: break
                        }
                    }
                    .onKeyPress(.leftArrow) { resizeInspector(width + (left ? -24 : 24), available: available); return .handled }
                    .onKeyPress(.rightArrow) { resizeInspector(width + (left ? 24 : -24), available: available); return .handled }
                    .onKeyPress(.home) { model.hideInspector(); return .handled }
                    .onKeyPress(.end) { inspectorRatio = CoreChrome.inspectorMaximumRatio; return .handled }
                    .onKeyPress(.return) { inspectorRatio = CoreChrome.inspectorDefaultRatio; return .handled }
                    .overlay(Color.clear.frame(width: 8).contentShape(Rectangle()).gesture(
                        DragGesture(minimumDistance: 0).onChanged { value in
                            if inspectorResizeStart == nil { inspectorResizeStart = width }
                            let next = (inspectorResizeStart ?? width) + Double(value.translation.width) * (left ? 1 : -1)
                            inspectorRatio = CoreChromeLayout.inspector(available: available, ratio: next / available).ratio
                            if next <= CoreChrome.panelCollapseWidth { model.hideInspector() }
                        }.onEnded { _ in inspectorResizeStart = nil }
                    ))
            }
    }
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
struct InputControlButton: NSViewRepresentable {
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
    var hidden = false
    func makeNSView(context: Context) -> CanvasHost { CanvasHost() }
    func updateNSView(_ host: CanvasHost, context: Context) { host.isHidden = hidden; host.render(model) }
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
        for session in model.terminals.values { session.search.outputChanged() }
        if !isHidden, focusRevision != model.focusRevision, let view = model.selectedTerminal?.view {
            focusRevision = model.focusRevision
            let requested = focusRevision
            let previousResponder = window?.firstResponder
            DispatchQueue.main.async { [weak self, weak view, weak model, weak previousResponder] in
                guard let self, let view, let model, let window = self.window, view.window === window,
                      requested == model.focusRevision, !model.inspectorOwnsFocus else { return }
                // A later explicit click or search focus takes precedence over queued pane focus.
                // 后发生的明确点击或搜索焦点优先于排队中的窗格聚焦。
                let fallback = window.firstResponder === window || window.firstResponder === window.contentView
                let previousWasRemoved = (previousResponder as? NSView)?.window !== window
                guard window.firstResponder === previousResponder || (fallback && previousWasRemoved) else { return }
                window.makeFirstResponder(view)
            }
        }
    }

    private func makePane(_ node: JSONValue, model: WorkspaceModel) -> NSView {
        if node["kind"].string == "leaf", let id = node["session"].string, let session = model.terminals[id] {
            return NativeTerminalPane(model: model, session: session)
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
