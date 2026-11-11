import AppKit
import SwiftUI
import UTermBridge
import WebKit

@MainActor
final class NativeWorkspaceDocuments: ObservableObject {
    struct Document: Identifiable {
        let id: UUID
        let scope: String
        let content: ContentWindow
    }
    @Published private(set) var documents: [Document] = []
    var terminalFocusRequested: (() -> Void)?
    @Published private var selected: [String: UUID] = [:]
    func visible(in scope: String) -> [Document] { documents.filter { $0.scope == scope } }
    func active(in scope: String) -> Document? { documents.first { $0.scope == scope && $0.id == selected[scope] } }
    func showTerminal(in scope: String) { selected[scope] = nil }
    func attach(_ content: ContentWindow, id: UUID, scope: String, parent: NSWindow) {
        documents.append(Document(id: id, scope: scope, content: content))
        content.window?.contentView = NSView()
        content.window?.orderOut(nil)
        content.presentEmbedded = { [weak self, weak parent, weak content] in
            guard let self, let parent, let content, self.documents.contains(where: { $0.id == id }) else { return }
            guard let item = self.documents.first(where: { $0.id == id }) else { return }
            self.selected[item.scope] = id
            parent.makeKeyAndOrderFront(nil)
            DispatchQueue.main.async { [weak self, weak parent, weak content] in
                guard let self, let parent, let content, self.active(in: item.scope)?.id == id, content.webView.window === parent, !(parent.firstResponder is WorkspaceTabButton) else { return }
                parent.makeFirstResponder(content.webView)
            }
        }
        content.editorStateChanged = { [weak self] in self?.objectWillChange.send() }
        content.reveal()
    }
    func retarget(_ content: ContentWindow, scope: String) {
        guard let index = documents.firstIndex(where: { $0.content === content }), documents[index].scope != scope else { return }
        let previous = documents[index]
        if selected[previous.scope] == previous.id { selected[previous.scope] = nil }
        documents[index] = Document(id: previous.id, scope: scope, content: content)
    }
    func remove(_ id: UUID) {
        guard let old = documents.first(where: { $0.id == id }) else { return }
        let peers = visible(in: old.scope)
        let index = peers.firstIndex(where: { $0.id == id }) ?? 0
        documents.removeAll { $0.id == id }
        if selected[old.scope] == id {
            let remaining = visible(in: old.scope)
            selected[old.scope] = remaining.isEmpty ? nil : remaining[min(index, remaining.count - 1)].id
            if remaining.isEmpty { terminalFocusRequested?() }
        }
    }
    func close(_ id: UUID) {
        guard let document = documents.first(where: { $0.id == id }) else { return }
        if document.content.editorDirty { document.content.reveal() }
        document.content.window?.performClose(nil)
    }
}

@MainActor
struct NativeWorkspaceDocumentSurface: View {
    @ObservedObject var model: WorkspaceModel
    @ObservedObject var documents: NativeWorkspaceDocuments
    var body: some View {
        VStack(spacing: 0) {
            if !documents.visible(in: model.inspectorContextKey).isEmpty {
                NativeWorkspaceDocumentTabs(model: model, documents: documents)
            }
            ZStack {
                TerminalCanvas(model: model, hidden: documents.active(in: model.inspectorContextKey) != nil)
                    .allowsHitTesting(documents.active(in: model.inspectorContextKey) == nil)
                if let selected = documents.active(in: model.inspectorContextKey) {
                    NativeEmbeddedDocument(content: selected.content)
                        .id(selected.id)
                }
            }
        }
    }
}

@MainActor
private struct NativeEmbeddedDocument: NSViewRepresentable {
    let content: ContentWindow
    func makeNSView(context: Context) -> EmbeddedDocumentHost {
        let host = EmbeddedDocumentHost()
        host.document = content.webView
        host.identifier = NSUserInterfaceItemIdentifier("native-embedded-document")
        content.webView.removeFromSuperview()
        content.webView.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(content.webView)
        NSLayoutConstraint.activate([
            content.webView.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            content.webView.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            content.webView.topAnchor.constraint(equalTo: host.topAnchor),
            content.webView.bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
        return host
    }
    func updateNSView(_ host: EmbeddedDocumentHost, context: Context) {}
    static func dismantleNSView(_ host: EmbeddedDocumentHost, coordinator: ()) {
        for view in host.subviews { view.removeFromSuperview() }
    }
}

@MainActor
private final class EmbeddedDocumentHost: NSView {
    weak var document: WKWebView?
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        DispatchQueue.main.async { [weak self] in
            guard let self, let window = self.window, window.isKeyWindow, let document = self.document,
                  document.window === window, !(window.firstResponder is WorkspaceTabButton) else { return }
            window.makeFirstResponder(document)
        }
    }
}

@MainActor
private struct NativeWorkspaceDocumentTabs: View {
    @ObservedObject var model: WorkspaceModel
    @ObservedObject var documents: NativeWorkspaceDocuments
    private var palette: JSONValue { NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog) }
    private var scope: String { model.inspectorContextKey }
    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 0) {
                if let session = model.sessionEntries.first(where: { $0.sessionID == model.selectedID }) {
                    tab(session.session["name"].string ?? localized("Terminal", "终端"), active: documents.active(in: scope) == nil, icon: .terminal, identifier: "native-workspace-terminal-tab") {
                        documents.showTerminal(in: scope); model.revealSelectedPane()
                    }
                    .contextMenu { NativeSessionContextMenu(model: model, id: session.sessionID) }
                }
                ForEach(documents.visible(in: scope)) { item in
                    HStack(spacing: 0) {
                        tab(item.content.path.split(separator: "/").last.map(String.init) ?? item.content.path, active: documents.active(in: scope)?.id == item.id, icon: nil, dirty: item.content.editorDirty, identifier: "native-file-select-" + item.id.uuidString) { item.content.reveal() }
                        NativeDocumentAction(title: localized("Close file", "关闭文件"), identifier: "native-file-close-" + item.id.uuidString, image: NativeChromeImages.toolbar(.close), iconOnly: true, active: false, tint: NativePreferences.color(palette["muted"], fallback: .secondaryLabelColor)) { documents.close(item.id) }
                            .frame(width: 22, height: 22).padding(.trailing, 4)
                    }
                    .background(color(documents.active(in: scope)?.id == item.id ? "canvas" : "sidebar"))
                    .overlay(alignment: .trailing) { color("border").frame(width: 1) }
                    .overlay(alignment: .bottom) { color(documents.active(in: scope)?.id == item.id ? "accent" : "sidebar").frame(height: 2) }
                    .accessibilityIdentifier("native-workspace-document-tab-" + item.id.uuidString)
                }
            }
        }
        .frame(height: 29).scrollIndicators(.hidden).buttonStyle(.borderless)
        .background(color("sidebar"))
        .overlay(alignment: .bottom) { color("border").frame(height: 1) }
        .disabled(!model.ready || model.busy || model.settingsPresented || model.gitFavoritesRecoveryPresented || model.worktreeDeletionPresented)
        .accessibilityIdentifier("native-workspace-document-tabs")
    }
    private func color(_ key: String) -> Color { Color(nsColor: NativePreferences.color(palette[key], fallback: .labelColor)) }
    private func tab(_ title: String, active: Bool, icon: CoreSidebarIcon?, dirty: Bool = false, identifier: String, action: @escaping () -> Void) -> some View {
        NativeDocumentAction(title: title + (dirty ? " ●" : ""), identifier: identifier, image: icon.map(NativeChromeImages.sidebar), iconOnly: false, active: active, tint: NativePreferences.color(palette[active ? "text" : "muted"], fallback: .labelColor), action: action)
            .fixedSize(horizontal: true, vertical: false).frame(height: 27)
            .padding(.horizontal, 9)
            .background(color(active ? "canvas" : "sidebar"))
    }
}

@MainActor
private struct NativeDocumentAction: NSViewRepresentable {
    let title: String
    let identifier: String
    let image: NSImage?
    let iconOnly: Bool
    let active: Bool
    let tint: NSColor
    let action: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(action: action) }
    func makeNSView(context: Context) -> NSButton {
        let button = WorkspaceTabButton(title: "", target: context.coordinator, action: #selector(Coordinator.activate))
        button.isBordered = false; button.font = .systemFont(ofSize: 12)
        button.imageScaling = .scaleProportionallyDown
        button.identifier = NSUserInterfaceItemIdentifier(identifier)
        button.setAccessibilityIdentifier(identifier)
        if !iconOnly { button.setAccessibilityRole(.radioButton) }
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.action = action
        button.title = iconOnly ? "" : title
        let fitted = image?.copy() as? NSImage
        fitted?.size = NSSize(width: iconOnly ? 12 : 15, height: iconOnly ? 12 : 15)
        button.image = fitted
        button.cell?.lineBreakMode = .byTruncatingMiddle
        button.imagePosition = image == nil ? .noImage : iconOnly ? .imageOnly : .imageLeading
        button.state = active ? .on : .off
        button.contentTintColor = tint; button.isEnabled = context.environment.isEnabled
        button.toolTip = title; button.setAccessibilityLabel(title)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSButton, context: Context) -> CGSize? {
        CGSize(width: iconOnly ? 22 : min(194, nsView.fittingSize.width), height: iconOnly ? 22 : 27)
    }
    @MainActor final class Coordinator: NSObject {
        var action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func activate() { action() }
    }
}

@MainActor
private final class WorkspaceTabButton: NSButton {
    override var acceptsFirstResponder: Bool { isEnabled }
    override func keyDown(with event: NSEvent) {
        guard [123, 124, 115, 119].contains(event.keyCode), event.modifierFlags.intersection([.command, .option, .control]).isEmpty,
              let root = window?.contentView, identifier?.rawValue.hasPrefix("native-file-select-") == true || identifier?.rawValue == "native-workspace-terminal-tab" else { super.keyDown(with: event); return }
        func buttons(_ view: NSView) -> [NSButton] {
            var found: [NSButton] = []
            if let button = view as? NSButton, button.isEnabled,
               button.identifier?.rawValue.hasPrefix("native-file-select-") == true || button.identifier?.rawValue == "native-workspace-terminal-tab" { found.append(button) }
            return found + view.subviews.flatMap(buttons)
        }
        let tabs = buttons(root).sorted { $0.convert(.zero, to: root).x < $1.convert(.zero, to: root).x }
        guard let index = tabs.firstIndex(where: { $0 === self }), !tabs.isEmpty else { return }
        let target = event.keyCode == 115 ? 0 : event.keyCode == 119 ? tabs.count - 1 : (index + (event.keyCode == 124 ? 1 : tabs.count - 1)) % tabs.count
        tabs[target].performClick(nil)
        window?.makeFirstResponder(tabs[target])
    }
}
