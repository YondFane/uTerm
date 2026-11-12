import AppKit
import SwiftUI
import UTermBridge
import WebKit

@MainActor
final class NativeInspectorModel: ObservableObject {
    enum Mode: String, CaseIterable { case files, search, quick, github }
    private weak var workspace: WorkspaceModel?
    @Published var mode: Mode = .files {
        didSet { if mode != oldValue && mode != .github { (content?.workbenchHost as? FilesHost)?.modeChanged() } }
    }
    @Published private(set) var content: ContentWindow?
    private(set) var request = 0
    @Published var query = ""
    @Published var hidden = false
    @Published var sensitive = false
    @Published private(set) var directory = ""
    @Published private(set) var path = ""
    @Published private(set) var rows: [JSONValue] = []
    @Published private(set) var partial = false
    @Published private(set) var skipped = 0
    @Published private(set) var busy = false
    @Published private(set) var error = ""
    @Published private(set) var errorCode = ""
    @Published var selected = -1
    private var generation = 0
    private var context = ""
    init(workspace: WorkspaceModel) { self.workspace = workspace }
    func show(_ mode: Mode) {
        if (mode == .github) != (content?.workbenchHost?.kind == "github") { content = nil }
        self.mode = mode; request += 1
        if mode != .github { (content?.workbenchHost as? FilesHost)?.modeChanged() }
    }
    func presentGitHub(_ content: ContentWindow, scope: String) {
        guard let workspace, workspace.inspectorContextKey == scope else { return }
        generation += 1; busy = false; error = ""; errorCode = ""
        context = scope; directory = content.directory.path
        mode = .github; self.content = content
    }
    func invalidate() { generation += 1; busy = false }
    func reload() async {
        guard let workspace, let bridge = workspace.bridge, workspace.state != nil else { return }
        generation += 1; let request = generation
        if context != workspace.inspectorContextKey {
            context = workspace.inspectorContextKey; directory = ""; path = ""; rows = []; query = ""; selected = -1; content = nil
        }
        busy = true; error = ""; errorCode = ""; defer { if request == generation { busy = false } }
        do {
            guard let current = try await currentProject(bridge, workspace: workspace, request: request) else { return }
            guard request == generation, !Task.isCancelled else { return }
            guard let root = current.directory, root.hasPrefix("/") else {
                directory = ""; rows = []; content = nil
                error = localized("Select a local project or Worktree first.", "请先选择本地项目或 Worktree。")
                return
            }
            if directory != root { directory = root; path = ""; rows = []; selected = -1; content = nil }
            if mode == .github {
                guard let make = workspace.makeGitHubTools else { throw BridgeFailure(code: "CLOSED", message: "GitHub tools are unavailable") }
                if content?.workbenchHost?.kind != "github" {
                    let next = try await make(URL(fileURLWithPath: root), context)
                    guard request == generation, context == workspace.inspectorContextKey, mode == .github, !Task.isCancelled else { return }
                    content = next
                }
                return
            }
            if content == nil, let make = workspace.makeFileTools {
                let next = try await make(URL(fileURLWithPath: root), context)
                guard request == generation, context == workspace.inspectorContextKey, !Task.isCancelled else { return }
                content = next
                (next.workbenchHost as? FilesHost)?.modeChanged()
            }
            let result: JSONValue
            if mode == .files {
                result = try await bridge.call("files.list", params: .object(["directory": .string(root), "path": .string(path), "hidden": .bool(hidden)]))
            } else {
                result = try await bridge.call("files.search", params: .object(["directory": .string(root), "query": .string(query), "content": .bool(mode == .search), "sensitive": .bool(sensitive), "hidden": .bool(hidden)]))
            }
            // A cancelled search or a different project must never replace the current list.
            // 已取消的搜索或其他项目的结果绝不能替换当前列表。
            guard request == generation, context == workspace.inspectorContextKey, !Task.isCancelled else { return }
            rows = result[mode == .files ? "entries" : "matches"].array
            partial = result["partial"].bool == true; skipped = Int(result["skipped"].number ?? 0); selected = -1
        } catch {
            guard request == generation, context == workspace.inspectorContextKey, !Task.isCancelled else { return }
            errorCode = (error as? BridgeFailure)?.code ?? "READ_FAILED"
            rows = []; self.error = localized("Could not read this project. Check the path and retry.", "无法读取此项目，请检查路径后重试。")
        }
    }
    private func currentProject(_ bridge: CoreBridge, workspace: WorkspaceModel, request: Int) async throws -> CoreProjectContext? {
        await workspace.flushWorkspaceOperations()
        for attempt in 0..<3 {
            guard request == generation, context == workspace.inspectorContextKey, !Task.isCancelled else { return nil }
            do {
                let snapshot = try await bridge.snapshot()
                let saved = snapshot.document.workspace
                let savedContext = [saved["selectedWorkspace"].string ?? "local", saved["selectedProject"].string ?? "", saved["selectedWorktree"].string ?? ""].joined(separator: "\u{0}")
                guard savedContext == context else { return nil }
                // Unrelated settings writes may change the revision without changing this project.
                // 无关的设置写入可能改变版本，但并未切换当前项目。
                return try await bridge.projectContext(expectedRevision: snapshot.revision)
            } catch let failure as BridgeFailure where attempt < 2 && ["CONFLICT", "WRITER_BUSY"].contains(failure.code) {
                try await Task.sleep(for: .milliseconds(25 * (attempt + 1)))
            }
        }
        return nil
    }

    func up() async {
        guard !path.isEmpty else { return }
        path = path.split(separator: "/").dropLast().joined(separator: "/")
        await reload()
    }
    func activate(_ index: Int) async {
        guard !busy, rows.indices.contains(index), let relative = rows[index]["path"].string, let workspace else { return }
        if mode == .files, rows[index]["directory"].bool == true { path = relative; await reload(); return }
        guard !directory.isEmpty, let open = workspace.openInspectorFile else { return }
        do { try await open(directory, relative, Int(rows[index]["line"].number ?? 0)) }
        catch { self.error = localized("Could not open this file. Check the selected project and retry.", "无法打开此文件，请检查所选项目后重试。") }
    }
    func activateFromUI(_ index: Int, expected: JSONValue? = nil) {
        guard !busy, rows.indices.contains(index), expected == nil || rows[index] == expected else { return }
        let request = generation
        Task { @MainActor [weak self] in
            guard let self, request == self.generation, !self.busy else { return }
            await self.activate(index)
        }
    }
}

@MainActor
struct NativeInspectorView: View {
    @ObservedObject var model: NativeInspectorModel
    @ObservedObject var workspace: WorkspaceModel
    var body: some View {
        Group {
            if let content = model.content {
                if content.workbenchHost?.kind == "github" {
                    NativeEmbeddedDocument(content: content).id(ObjectIdentifier(content))
                } else { FileToolsSurface(content: content) }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    if model.busy { ProgressView().controlSize(.small) }
                    if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled) }
                    Button(localized("Refresh", "刷新")) { Task { await model.reload() } }.disabled(model.busy)
                    Spacer()
                }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(.container, edges: .top)
        .task(id: workspace.inspectorContextKey) { await model.reload() }
        .onChange(of: model.mode) { _, _ in Task { await model.reload() } }
        .onDisappear { model.invalidate() }
        .accessibilityIdentifier("native-inspector")
    }
}

@MainActor
final class InspectorContainer: NSHostingView<NativeInspectorView> {}

@MainActor
struct InspectorHost: NSViewRepresentable {
    @ObservedObject var model: WorkspaceModel
    func makeNSView(context: Context) -> InspectorContainer {
        let view = InspectorContainer(rootView: NativeInspectorView(model: model.inspector, workspace: model))
        view.identifier = NSUserInterfaceItemIdentifier("native-inspector-container")
        view.safeAreaRegions = []
        return view
    }
    func updateNSView(_ view: InspectorContainer, context: Context) {
        // Keep the mounted file tools and their query while terminal frames update.
        // 终端帧更新时保留已接入的文件工具及其查询。
        if view.rootView.workspace !== model { view.rootView = NativeInspectorView(model: model.inspector, workspace: model) }
    }
}

@MainActor
private struct FileToolsSurface: NSViewRepresentable {
    let content: ContentWindow
    func makeNSView(context: Context) -> NSView {
        let host = NSView()
        attach(to: host)
        return host
    }
    func updateNSView(_ host: NSView, context: Context) {
        if content.webView.superview !== host { attach(to: host) }
    }
    private func attach(to host: NSView) {
        host.subviews.forEach { $0.removeFromSuperview() }
        content.webView.removeFromSuperview()
        content.webView.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(content.webView)
        NSLayoutConstraint.activate([
            content.webView.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            content.webView.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            content.webView.topAnchor.constraint(equalTo: host.topAnchor),
            content.webView.bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
    }
    static func dismantleNSView(_ host: NSView, coordinator: ()) {
        host.subviews.forEach { $0.removeFromSuperview() }
    }
}
