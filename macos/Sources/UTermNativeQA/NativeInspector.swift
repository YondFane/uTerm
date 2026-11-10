import AppKit
import SwiftUI
import UTermBridge

@MainActor
final class NativeInspectorModel: ObservableObject {
    enum Mode: String, CaseIterable { case files, search, quick }
    private weak var workspace: WorkspaceModel?
    @Published var mode: Mode = .files
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
    @Published var selected = -1
    private var generation = 0
    private var context = ""
    init(workspace: WorkspaceModel) { self.workspace = workspace }
    func invalidate() { generation += 1; busy = false }
    func reload() async {
        guard let workspace, let bridge = workspace.bridge, let state = workspace.state else { return }
        generation += 1; let request = generation
        if context != workspace.inspectorContextKey {
            context = workspace.inspectorContextKey; directory = ""; path = ""; rows = []; query = ""; selected = -1
        }
        busy = true; error = ""; defer { if request == generation { busy = false } }
        do {
            let current = try await bridge.projectContext(expectedRevision: state.snapshot.revision)
            guard request == generation, !Task.isCancelled else { return }
            guard let root = current.directory, root.hasPrefix("/") else {
                directory = ""; rows = []
                error = localized("Select a local project or Worktree first.", "请先选择本地项目或 Worktree。")
                return
            }
            if directory != root { directory = root; path = ""; rows = []; selected = -1 }
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
            rows = []; self.error = localized("Could not read this project. Check the path and retry.", "无法读取此项目，请检查路径后重试。")
        }
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
    @FocusState private var queryFocused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Picker(localized("Tools", "工具"), selection: $model.mode) {
                    Text(localized("Files", "文件")).tag(NativeInspectorModel.Mode.files)
                    Text(localized("Search", "搜索")).tag(NativeInspectorModel.Mode.search)
                    Text(localized("Quick open", "快速打开")).tag(NativeInspectorModel.Mode.quick)
                }.labelsHidden().pickerStyle(.segmented)
                Button { workspace.hideInspector() } label: { Image(systemName: "xmark") }.help(localized("Close tools", "关闭工具"))
            }
            if !model.directory.isEmpty { Text(URL(fileURLWithPath: model.directory).lastPathComponent).font(.caption).foregroundStyle(.secondary).lineLimit(1).help(model.directory) }
            if model.mode == .files {
                HStack {
                    Button(localized("Up", "上一级")) { Task { await model.up() } }.disabled(model.path.isEmpty || model.busy)
                    Text(model.path.isEmpty ? "/" : model.path).font(.caption).lineLimit(1).truncationMode(.middle)
                    Spacer()
                }
            } else {
                TextField(model.mode == .search ? localized("Search file contents", "搜索文件内容") : localized("Search file names", "搜索文件名"), text: $model.query)
                    .focused($queryFocused).onSubmit { Task { await model.reload() } }
                    .accessibilityIdentifier("native-inspector-query")
                if model.mode == .search { Toggle(localized("Match case", "区分大小写"), isOn: $model.sensitive).onChange(of: model.sensitive) { _, _ in Task { await model.reload() } } }
            }
            HStack {
                Toggle(localized("Show hidden files", "显示隐藏文件"), isOn: $model.hidden)
                Spacer()
                Button(localized("Refresh", "刷新")) { Task { await model.reload() } }.disabled(model.busy)
            }.font(.caption)
            if model.busy { ProgressView().controlSize(.small) }
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).font(.caption).textSelection(.enabled) }
            InspectorRows(model: model, workspace: workspace).frame(maxWidth: .infinity, maxHeight: .infinity)
            if model.partial || model.skipped > 0 { Text(localized("Some results were omitted. Narrow the search or refresh.", "部分结果未显示，请缩小搜索范围或刷新。")).font(.caption).foregroundStyle(.secondary) }
            HStack {
                Button("Git") { workspace.openGitRequested?() }
                Button("GitHub") { workspace.openGitHubRequested?() }.disabled(workspace.openGitHubRequested == nil)
                Spacer()
                Button(localized("Open", "打开")) { model.activateFromUI(model.selected) }.disabled(!model.rows.indices.contains(model.selected) || model.busy)
            }
        }.padding(10)
        .task(id: workspace.inspectorContextKey) { await model.reload(); queryFocused = model.mode != .files }
        .onChange(of: model.mode) { _, mode in Task { await model.reload() }; queryFocused = mode != .files }
        .onChange(of: model.hidden) { _, _ in Task { await model.reload() } }
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
        return view
    }
    func updateNSView(_ view: InspectorContainer, context: Context) {
        // The root observes both models; replacing it on PTY updates restarts focus and reload tasks.
        // 根视图已监听两个模型，因 PTY 更新替换根视图会重启焦点及重新加载任务。
        if view.rootView.workspace !== model { view.rootView = NativeInspectorView(model: model.inspector, workspace: model) }
    }
}

@MainActor
private struct InspectorRows: NSViewRepresentable {
    @ObservedObject var model: NativeInspectorModel
    @ObservedObject var workspace: WorkspaceModel
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true
        let table = InspectorTable(); table.identifier = NSUserInterfaceItemIdentifier("native-inspector-rows")
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("file")))
        table.headerView = nil; table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle; table.autoresizingMask = [.width]
        table.delegate = context.coordinator; table.dataSource = context.coordinator; table.target = context.coordinator; table.doubleAction = #selector(Coordinator.open(_:))
        let coordinator = context.coordinator
        table.activate = { [weak table, weak coordinator] in guard let table else { return }; coordinator?.activate(row: table.selectedRow) }
        scroll.documentView = table; context.coordinator.update(model, workspace: workspace, table: table)
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) { if let table = scroll.documentView as? NSTableView { context.coordinator.update(model, workspace: workspace, table: table) } }
    final class InspectorTable: NSTableView {
        var activate: (() -> Void)?
        override func keyDown(with event: NSEvent) { if event.keyCode == 36 { activate?() } else { super.keyDown(with: event) } }
    }
    @MainActor
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        private weak var model: NativeInspectorModel?
        private weak var workspace: WorkspaceModel?
        private var rows: [JSONValue] = []
        private var fontFamily = ""
        private var mode: NativeInspectorModel.Mode?
        private var updating = false
        func update(_ model: NativeInspectorModel, workspace: WorkspaceModel, table: NSTableView) {
            self.model = model; self.workspace = workspace
            let height = CGFloat(workspace.settings["fileFontSize"].number ?? 14) + (model.mode == .search ? 28 : 12)
            let family = workspace.settings["fontFamily"].string ?? "monospace"
            if rows != model.rows || table.rowHeight != height || fontFamily != family || mode != model.mode {
                updating = true; rows = model.rows; fontFamily = family; mode = model.mode; table.rowHeight = height; table.reloadData(); updating = false
            }
            let selection = rows.indices.contains(model.selected) ? IndexSet(integer: model.selected) : IndexSet()
            if table.selectedRowIndexes != selection { updating = true; table.selectRowIndexes(selection, byExtendingSelection: false); updating = false }
        }
        func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
        func tableViewSelectionDidChange(_ notification: Notification) {
            guard !updating, let table = notification.object as? NSTableView else { return }
            model?.selected = table.selectedRow
        }
        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            guard rows.indices.contains(row) else { return nil }
            let value = rows[row], path = value["path"].string ?? ""
            let name = value["name"].string ?? path
            let icon = NSImageView(image: NSImage(systemSymbolName: value["directory"].bool == true ? "folder" : value["symlink"].bool == true ? "link" : "doc", accessibilityDescription: nil) ?? NSImage())
            let text = NSTextField(labelWithString: name); text.lineBreakMode = .byTruncatingMiddle
            text.font = NativePreferences.font(workspace?.settings["fontFamily"].string ?? "monospace", size: CGFloat(workspace?.settings["fileFontSize"].number ?? 14), mono: true)
            let title = NSStackView(views: [icon, text]); title.spacing = 6
            if model?.mode != .search { return title }
            let line = Int(value["line"].number ?? 0)
            let preview = NSTextField(labelWithString: "\(line): " + (value["text"].string ?? "")); preview.lineBreakMode = .byTruncatingTail; preview.font = .systemFont(ofSize: 11); preview.textColor = .secondaryLabelColor
            let stack = NSStackView(views: [title, preview]); stack.orientation = .vertical; stack.alignment = .leading; return stack
        }
        func activate(row: Int) { guard rows.indices.contains(row) else { return }; model?.activateFromUI(row, expected: rows[row]) }
        @objc func open(_ table: NSTableView) { activate(row: table.clickedRow) }
    }
}
