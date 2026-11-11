import AppKit
import Combine
import SwiftUI
import SwiftTerm
import UTermBridge

@MainActor
final class NativeTerminalSearch: ObservableObject {
    private weak var session: TerminalSession?
    @Published var visible = false
    @Published var query = ""
    @Published var matchCase = false
    @Published private(set) var focusRequest = 0
    @Published private(set) var index = 0
    @Published private(set) var total = 0
    private var refresh: Task<Void, Never>?
    private var navigation: Task<Void, Never>?
    private var navigationRevision = 0
    init(session: TerminalSession) { self.session = session }
    func open() { visible = true; focusRequest += 1; if !query.isEmpty { find(reset: true) } }
    func close() {
        visible = false; refresh?.cancel(); refresh = nil
        navigationRevision += 1; navigation?.cancel(); navigation = nil
        session?.view.clearSearch()
        if let view = session?.view { view.window?.makeFirstResponder(view) }
    }
    func find(previous: Bool = false, reset: Bool = false) {
        guard let view = session?.view else { return }
        navigationRevision += 1; navigation?.cancel(); navigation = nil
        let previousIndex = index
        if reset { view.clearSearch() }
        guard !query.isEmpty else { view.clearSearch(); index = 0; total = 0; return }
        let options = SearchOptions(caseSensitive: matchCase)
        if previous { view.findPrevious(query, options: options) } else { view.findNext(query, options: options) }
        count()
        if previous && total > 0 {
            let target = previousIndex > 1 ? previousIndex - 1 : total
            if index != target { selectMatch(target, view: view, options: options) }
        }
    }
    private func selectMatch(_ target: Int, view: NativeTerminalView, options: SearchOptions) {
        let revision = navigationRevision, term = query
        // Recover missing reverse selections through bounded forward navigation without blocking input.
        // 反向选择缺失时，通过有界的正向导航恢复匹配，并让出执行时间避免阻塞输入。
        navigation = Task { @MainActor [weak self, weak view] in
            guard let self, let view, !Task.isCancelled, self.visible, revision == self.navigationRevision else { return }
            view.clearSearch()
            for match in 1...min(target, 1000) {
                guard !Task.isCancelled, self.visible, revision == self.navigationRevision else { return }
                guard view.findNext(term, options: options, scrollToResult: match == target) else { break }
                if match % 16 == 0 { await Task.yield() }
            }
            guard !Task.isCancelled, revision == self.navigationRevision else { return }
            self.navigation = nil; self.count()
        }
    }
    private func count() {
        guard let view = session?.view, !query.isEmpty else { index = 0; total = 0; return }
        let summary = view.searchMatchSummary(query, options: SearchOptions(caseSensitive: matchCase), limit: 1000)
        index = summary.index; total = summary.total
    }
    func outputChanged() {
        guard visible, refresh == nil, let view = session?.view, view.window?.isVisible == true, !view.isHiddenOrHasHiddenAncestor else { return }
        refresh = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled, let self else { return }
            self.refresh = nil
            if self.visible { self.count() }
        }
    }
}

@MainActor
struct NativeTerminalHeader: View {
    @ObservedObject var model: WorkspaceModel
    let session: TerminalSession
    @ObservedObject var search: NativeTerminalSearch
    let compact: Bool
    private var palette: JSONValue { NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog) }
    private var fontSize: Int { Int(model.settings["fontSize"].number ?? 14) }
    private var tint: NSColor { NativePreferences.color(palette["text"], fallback: .labelColor) }
    private var visibleError: String { session.error.isEmpty ? session.activityUnavailable ? localized("Agent activity is unavailable. Reconnect to retry.", "Agent 活动暂不可用，请重新连接后重试。") : "" : session.error }
    var body: some View {
        VStack(spacing: 0) {
            Group {
                if compact {
                    VStack(spacing: 8) { labels; HStack(spacing: 8) { Spacer(minLength: 0); controls } }
                } else { HStack(spacing: 8) { labels; controls } }
            }
            .frame(height: compact ? 58 : 26)
            .padding(.bottom, 8)
            .overlay(alignment: .bottom) { Color(nsColor: NativePreferences.color(palette["border"], fallback: .separatorColor)).frame(height: 1) }
            if search.visible {
                HStack(spacing: 5) {
                    NativeTerminalSearchField(search: search, id: session.id, tint: tint).frame(minWidth: 40, maxWidth: .infinity).frame(height: 24)
                    control("Aa", "match-case", localized("Match case", "区分大小写"), bordered: true, active: search.matchCase) { search.matchCase.toggle(); search.find(reset: true) }.frame(width: 28)
                    Text(search.query.isEmpty ? "" : "\(search.index) / \(search.total)").font(.system(size: 10)).fixedSize()
                    control("↑", "previous", localized("Previous match", "上一个匹配")) { search.find(previous: true) }.frame(width: 20)
                    control("↓", "next", localized("Next match", "下一个匹配")) { search.find() }.frame(width: 20)
                    icon(.close, "close-search", localized("Close search", "关闭搜索")) { search.close() }
                }.frame(height: 32)
            }
            if !visibleError.isEmpty { Text(visibleError).font(.system(size: 11)).foregroundStyle(.red).textSelection(.enabled).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading).frame(height: 32).help(visibleError) }
        }
        .font(.custom(NativePreferences.font(model.settings["interfaceFont"].string ?? "", size: 11).fontName, size: 11))
        .foregroundStyle(Color(nsColor: tint))
        .background(Color(nsColor: NativePreferences.color(NativePreferences.terminalTheme(model.settings, catalog: model.settingsCatalog)["background"], fallback: .textBackgroundColor)))
        .accessibilityIdentifier("native-terminal-header-" + session.id)
    }
    private var labels: some View {
        HStack(spacing: 8) {
            Text(session.name).font(.system(size: 11, design: .monospaced)).lineLimit(1).frame(minWidth: 45, maxWidth: 90, alignment: .leading)
                .onTapGesture { Task { await model.selectSession(session.id) } }
            Text(session.directory).foregroundStyle(Color(nsColor: NativePreferences.color(palette["muted"], fallback: .secondaryLabelColor)))
                .lineLimit(1).truncationMode(.middle).frame(minWidth: 60, maxWidth: .infinity, alignment: .leading).help(session.directory)
        }
    }
    @ViewBuilder private var controls: some View {
        if session.inputControl?.owned == false {
            Text(localized("Read-only attachment", "只读连接")).font(.system(size: 10))
            InputControlButton(session: session)
        }
        HStack(spacing: 4) {
            control("A−", "font-smaller", localized("Decrease terminal font size", "减小终端字号"), enabled: fontSize > 10, bordered: true) { adjustFont(-1) }.frame(width: 28)
            Text("\(fontSize) px").font(.system(size: 10)).fixedSize()
            control("A+", "font-larger", localized("Increase terminal font size", "增大终端字号"), enabled: fontSize < 32, bordered: true) { adjustFont(1) }.frame(width: 28)
        }
        icon(.search, "search", localized("Search terminal", "搜索终端")) {
            Task { await model.selectSession(session.id); if search.visible { search.close() } else { search.open() } }
        }
        Circle().fill(session.exited ? Color.gray : session.error.isEmpty && session.generation != nil ? Color(red: 0.49, green: 0.74, blue: 0.58) : Color.red).frame(width: 5, height: 5)
            .help(session.activityLabel.isEmpty ? session.exited ? localized("Exited", "已退出") : session.generation == nil ? localized("Starting", "正在启动") : localized("Running", "运行中") : session.activityLabel)
        if session.exited && session.supportsRestart {
            icon(.restart, "restart", localized("Restart", "重新启动")) { Task { await session.restart() } }
        } else if !session.error.isEmpty || session.activityUnavailable { icon(.restart, "reconnect", localized("Reconnect", "重新连接")) { Task { await session.reconnect() } } }
    }
    private func adjustFont(_ delta: Double) { Task { await model.mutate("settings.font.adjust", ["key": .string("fontSize"), "delta": .number(delta)]) } }
    private func control(_ title: String, _ id: String, _ help: String, enabled: Bool = true, bordered: Bool = false, active: Bool = false, action: @escaping () -> Void) -> some View {
        NativeTerminalControl(title: title, image: nil, id: "native-terminal-" + id + "-" + session.id, help: help, enabled: enabled && !model.busy && !model.gitFavoritesRecoveryPresented, bordered: bordered, active: active, tint: tint, border: NativePreferences.color(palette["border"], fallback: .separatorColor), font: NativePreferences.font(model.settings["interfaceFont"].string ?? "", size: 11), action: action).frame(height: 24)
    }
    private func icon(_ icon: CoreToolbarIcon, _ id: String, _ help: String, action: @escaping () -> Void) -> some View {
        NativeTerminalControl(title: "", image: NativeChromeImages.toolbar(icon), id: "native-terminal-" + id + "-" + session.id, help: help, enabled: !model.busy && !model.gitFavoritesRecoveryPresented, bordered: false, active: false, tint: tint, border: .clear, font: NativePreferences.font(model.settings["interfaceFont"].string ?? "", size: 11), action: action).frame(width: 26, height: 26)
    }
}

@MainActor
private struct NativeTerminalControl: NSViewRepresentable {
    let title: String
    let image: NSImage?
    let id: String
    let help: String
    let enabled: Bool
    let bordered: Bool
    let active: Bool
    let tint: NSColor
    let border: NSColor
    let font: NSFont
    let action: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(action: action) }
    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(title: "", target: context.coordinator, action: #selector(Coordinator.handleClick))
        button.isBordered = false; button.wantsLayer = true; button.font = NSFont.systemFont(ofSize: 11)
        button.identifier = NSUserInterfaceItemIdentifier(id); button.setAccessibilityIdentifier(id)
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.action = action
        button.font = font
        button.title = title; button.toolTip = help; button.setAccessibilityLabel(help)
        let fitted = image?.copy() as? NSImage; fitted?.size = NSSize(width: 15, height: 15)
        button.image = fitted; button.imagePosition = image == nil ? .noImage : .imageOnly; button.imageScaling = .scaleProportionallyDown
        button.contentTintColor = tint; button.isEnabled = enabled && context.environment.isEnabled
        button.layer?.cornerRadius = 4; button.layer?.borderWidth = bordered ? 1 : 0; button.layer?.borderColor = border.cgColor
        button.layer?.backgroundColor = active ? tint.withAlphaComponent(0.12).cgColor : NSColor.clear.cgColor
        button.state = active ? .on : .off
    }
    @MainActor final class Coordinator: NSObject {
        var action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func handleClick() { action() }
    }
}

@MainActor
private struct NativeTerminalSearchField: NSViewRepresentable {
    @ObservedObject var search: NativeTerminalSearch
    let id: String
    let tint: NSColor
    func makeCoordinator() -> Coordinator { Coordinator(search: search) }
    func makeNSView(context: Context) -> Field {
        let field = Field(); field.isBezeled = true; field.bezelStyle = .roundedBezel
        field.font = .systemFont(ofSize: 12); field.delegate = context.coordinator
        field.identifier = NSUserInterfaceItemIdentifier("native-terminal-query-" + id)
        field.setAccessibilityIdentifier("native-terminal-query-" + id)
        return field
    }
    func updateNSView(_ field: Field, context: Context) {
        if field.stringValue != search.query { field.stringValue = search.query }
        field.placeholderString = localized("Search terminal", "搜索终端"); field.setAccessibilityLabel(localized("Search terminal", "搜索终端"))
        field.textColor = tint
        if context.coordinator.focusRequest != search.focusRequest {
            context.coordinator.focusRequest = search.focusRequest
            DispatchQueue.main.async { [weak field, weak search] in
                guard let field, let search, search.visible, let window = field.window, window.isKeyWindow else { return }
                window.makeFirstResponder(field)
            }
        }
    }
    @MainActor final class Field: NSTextField {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            DispatchQueue.main.async { [weak self] in guard let self, let window = self.window, window.isKeyWindow else { return }; window.makeFirstResponder(self) }
        }
    }
    @MainActor final class Coordinator: NSObject, NSTextFieldDelegate {
        let search: NativeTerminalSearch
        var focusRequest = -1
        init(search: NativeTerminalSearch) { self.search = search }
        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField else { return }
            search.query = field.stringValue; search.find(reset: true)
        }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if commandSelector == NSSelectorFromString("cancelOperation:") { search.close(); return true }
            if ["insertNewline:", "insertLineBreak:", "insertNewlineIgnoringFieldEditor:"].contains(NSStringFromSelector(commandSelector)) {
                search.find(previous: NSApp.currentEvent?.modifierFlags.contains(.shift) == true); return true
            }
            return false
        }
    }
}

@MainActor
final class NativeTerminalPane: NSView {
    private let session: TerminalSession
    private let header: NSHostingView<NativeTerminalHeader>
    private let model: WorkspaceModel
    private var searchChanges: AnyCancellable?
    private var workspaceChanges: AnyCancellable?
    private var compact = false
    private var appliedPadding: CGFloat = -1
    private var appliedPalette: JSONValue = .null
    private var appliedActive = false
    init(model: WorkspaceModel, session: TerminalSession) {
        self.model = model; self.session = session
        header = NSHostingView(rootView: NativeTerminalHeader(model: model, session: session, search: session.search, compact: false))
        header.safeAreaRegions = []
        super.init(frame: .zero)
        wantsLayer = true; layer?.masksToBounds = true; layer?.borderWidth = 1
        addSubview(header); session.view.removeFromSuperview(); addSubview(session.view)
        searchChanges = session.search.objectWillChange.sink { [weak self] in DispatchQueue.main.async { self?.scheduleLayout() } }
        workspaceChanges = model.objectWillChange.sink { [weak self] in DispatchQueue.main.async { self?.scheduleLayout() } }
    }
    required init?(coder: NSCoder) { return nil }
    override var isFlipped: Bool { true }
    override func setFrameSize(_ newSize: NSSize) { super.setFrameSize(newSize); needsLayout = true }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); needsLayout = true }
    private var padding: CGFloat { CGFloat(model.settings["windowPadding"].number ?? 10) }
    private var requiredHeight: CGFloat {
        var height: CGFloat = bounds.width - 2 * padding - 2 < 360 ? 66 : 34
        if session.search.visible { height += 32 }
        if !session.error.isEmpty || session.activityUnavailable { height += 32 }
        return height
    }
    private func scheduleLayout() {
        if abs(header.frame.height - requiredHeight) > 0.1 || appliedPadding != padding { needsLayout = true }
        let palette = NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog)
        let active = model.selectedID == session.id
        if appliedPalette != palette || appliedActive != active {
            appliedPalette = palette; appliedActive = active
            let border = NativePreferences.color(palette["border"], fallback: .separatorColor)
            layer?.borderColor = (active ? border.blended(withFraction: 0.45, of: NativePreferences.color(palette["accent"], fallback: .controlAccentColor)) ?? border : border).cgColor
        }
    }
    override func layout() {
        super.layout()
        let nextCompact = bounds.width - 2 * padding - 2 < 360
        if compact != nextCompact {
            compact = nextCompact
            header.rootView = NativeTerminalHeader(model: model, session: session, search: session.search, compact: compact)
        }
        let height = requiredHeight
        appliedPadding = padding
        let inset = padding + 1
        let width = max(0, bounds.width - 2 * inset)
        header.frame = NSRect(x: inset, y: inset, width: width, height: height)
        session.view.frame = NSRect(x: inset, y: inset + height + 12, width: width, height: max(0, bounds.height - 2 * inset - height - 12))
        scheduleLayout()
    }
}
