import AppKit
import SwiftUI
import SwiftTerm
import UniformTypeIdentifiers
import UTermBridge

struct PythonArgument: Identifiable { let id = UUID(); var text: String }
struct PythonEnvironment: Identifiable { let id = UUID(); var key = ""; var value = "" }

@MainActor
final class PythonRunModel: ObservableObject {
    @Published var workspaceDocked = false
    let directory: String
    let bridge: CoreBridge
    private(set) var settings: JSONValue
    private(set) var settingsCatalog: JSONValue
    @Published var config: CorePythonRunConfig?
    @Published var argumentInput = ""
    @Published var arguments: [PythonArgument] = [] { didSet { if !editingArgumentInput { argumentInput = RunPanelInput.formatArguments(arguments.map(\.text)) } } }
    @Published var environmentInput = ""
    @Published var environment: [PythonEnvironment] = [] { didSet { if !editingEnvironmentInput { environmentInput = environment.map { $0.key + "=" + $0.value }.joined(separator: "\n") } } }
    @Published var port = ""
    @Published var error = ""
    @Published var feedback = ""
    @Published var busy = true
    @Published var prepared = false
    @Published var dirty = false
    @Published var tasks: [JSONValue] = []
    @Published var interpreters: [JSONValue] = []
    @Published var candidates: [JSONValue] = []
    @Published var selectedID = ""
    @Published var search = ""
    @Published var searchSummary = ""
    @Published private(set) var terminal: TerminalSession?
    private var editingArgumentInput = false
    private var editingEnvironmentInput = false
    private var revision = ""
    private var polling: Task<Void, Never>?
    private var frames: Task<Void, Never>?
    private var failures: Task<Void, Never>?
    private var closed = false
    private var selecting = false
    var selectedTask: JSONValue { tasks.first { $0["spec"]["id"].string == selectedID } ?? .null }
    var running: Bool { tasks.contains { $0["running"].bool == true } }

    init(directory: String, bridge: CoreBridge, settings: JSONValue, catalog: JSONValue = .null) {
        self.directory = directory; self.bridge = bridge; self.settings = settings; self.settingsCatalog = catalog
    }
    func applySettings(_ value: JSONValue, catalog: JSONValue) {
        if settings != value || settingsCatalog != catalog { objectWillChange.send(); settings = value; settingsCatalog = catalog }
        terminal?.apply(settings: value, catalog: catalog)
    }
    func start() async {
        frames = Task { @MainActor [weak self, bridge] in
            do {
                for try await packet in bridge.terminalFrames {
                    if let terminal = self?.terminal { await terminal.receive(packet) }
                    bridge.consumed(packet)
                }
            } catch { self?.error = error.localizedDescription }
        }
        failures = Task { @MainActor [weak self, bridge] in
            for await failure in bridge.terminalFailures {
                self?.terminal?.reportFailure(failure)
            }
        }
        await reload()
        polling = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                guard let self, !self.closed else { return }
                if !self.busy && !self.prepared { await self.refreshTasks() }
            }
        }
    }
    private func value<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }
    func reload() async {
        guard !prepared, !closed else { return }
        busy = true; error = ""; feedback = ""
        defer { busy = false }
        do {
            let loaded = try await bridge.call("python.configuration", params: .object(["directory": .string(directory)]))
            try apply(loaded)
            try await detectValues()
            let configuration = try JSONDecoder().decode(CorePythonConfiguration.self, from: JSONEncoder().encode(loaded))
            config = PythonRunDraft.make(project: configuration.project, configured: configuration.configured, candidates: candidates, interpreters: interpreters)
            port = String(config?.port ?? 8000)
            await refreshTasks()
        } catch { self.error = error.localizedDescription }
    }
    private func apply(_ response: JSONValue) throws {
        let loaded = try JSONDecoder().decode(CorePythonConfiguration.self, from: JSONEncoder().encode(response))
        config = loaded.project; revision = loaded.revision
        arguments = (loaded.project.arguments ?? []).map { PythonArgument(text: $0) }
        port = String(loaded.project.port ?? 0)
        dirty = false
    }
    private func detectValues() async throws {
        interpreters = try await bridge.call("python.interpreters", params: .object([
            "directory": .string(directory), "selected": .string(config?.interpreter ?? "")
        ])).array
        let project = try await bridge.call("python.project", params: .object(["directory": .string(directory)]))
        candidates = project["candidates"].array
    }
    func detect() async {
        guard !busy, !prepared else { return }
        busy = true; error = ""
        defer { busy = false }
        do { try await detectValues() } catch { self.error = error.localizedDescription }
    }
    func applySelection(_ selected: URL?, kind: String) async -> Bool {
        guard let selected else { return false }
        do {
            let value = try await bridge.call("python.path.validate", params: .object([
                "directory": .string(directory), "path": .string(selected.standardizedFileURL.path), "kind": .string(kind)
            ]))
            guard let path = value.string else { throw BridgeFailure(code: "PYTHON_PROJECT_INVALID", message: localized("The selected path is invalid.", "所选路径无效。")) }
            switch kind {
            case "interpreter": config?.interpreter = path
            case "script": config?.target = path
            case "directory": config?.working_directory = path.isEmpty ? "." : path
            default: return false
            }
            dirty = true; error = ""
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func choosePath(_ kind: String) async {
        guard !busy, !prepared else { return }
        busy = true
        defer { busy = false }
        let panel = NSOpenPanel()
        panel.resolvesAliases = false; panel.allowsMultipleSelection = false
        panel.canChooseDirectories = kind == "directory"; panel.canChooseFiles = !panel.canChooseDirectories
        panel.directoryURL = URL(fileURLWithPath: directory)
        if kind == "script" { panel.allowedContentTypes = [.pythonScript] }
        guard panel.runModal() == .OK else { return }
        _ = await applySelection(panel.url, kind: kind)
    }
    func editArguments(_ text: String) {
        guard !busy, !prepared else { return }
        editingArgumentInput = true; defer { editingArgumentInput = false }
        argumentInput = text
        if let values = try? RunPanelInput.arguments(text) { arguments = values.map { PythonArgument(text: $0) } }
        dirty = true
    }
    func editEnvironment(_ text: String) {
        guard !busy, !prepared else { return }
        editingEnvironmentInput = true; defer { editingEnvironmentInput = false }
        environmentInput = text
        if let values = try? RunPanelInput.environment(text) { environment = values.sorted { $0.key < $1.key }.map { PythonEnvironment(key: $0.key, value: $0.value) } }
    }
    private func formConfig() throws -> CorePythonRunConfig {
        guard var result = config, let number = UInt16(port) else {
            throw BridgeFailure(code: "PYTHON_CONFIG_INVALID", message: localized("Enter a valid port.", "请填写有效端口。"))
        }
        result.port = number
        do { result.arguments = try RunPanelInput.arguments(argumentInput) }
        catch { throw BridgeFailure(code: "PYTHON_ARGUMENTS_INVALID", message: localized("Complete argument quotes and remove unsupported control characters.", "请补全参数引号并移除不支持的控制字符。")) }
        return result
    }
    private func persist() async throws {
        let response = try await bridge.call("python.saveConfiguration", params: .object([
            "directory": .string(directory), "revision": .string(revision), "config": try value(formConfig())
        ]))
        try apply(response)
        feedback = localized("Configuration saved.", "配置已保存。")
    }
    private func environmentValues() throws -> [String: JSONValue] {
        do { return try RunPanelInput.environment(environmentInput).mapValues { .string($0) } }
        catch { throw BridgeFailure(code: "PYTHON_ENVIRONMENT_INVALID", message: localized("Use one NAME=value per line with unique names; UTERM_ names are reserved.", "每行填写一个 NAME=value，名称不能重复；UTERM_ 前缀为保留名称。")) }
    }
    private func startSaved(environment: [String: JSONValue]) async throws {
        let task = try await bridge.call("python.start", params: .object([
            "directory": .string(directory), "config": try value(formConfig()), "environment": .object(environment)
        ]))
        selectedID = task["spec"]["id"].string ?? ""
        await refreshTasks()
    }
    func save() async -> Bool {
        guard !busy, !prepared else { return false }
        busy = true; error = ""
        defer { busy = false }
        do { try await persist(); return true }
        catch { self.error = error.localizedDescription; return false }
    }
    func run() async {
        guard !busy, !prepared, !running else { return }
        busy = true; error = ""; feedback = ""
        defer { busy = false }
        do {
            let values = try environmentValues()
            try await persist()
            try await startSaved(environment: values)
        } catch { self.error = error.localizedDescription }
    }
    func runAgain() async {
        guard !busy, !prepared else { return }
        busy = true; error = ""; feedback = ""
        defer { busy = false }
        do {
            let values = try environmentValues()
            try await persist()
            if let active = tasks.first(where: { $0["running"].bool == true }) {
                _ = try await bridge.call("python.stop", params: .object([
                    "id": active["spec"]["id"], "generation": active["generation"], "force": .bool(false)
                ]))
                let deadline = Date().addingTimeInterval(5)
                while Date() < deadline {
                    await refreshTasks()
                    if !running { break }
                    try await Task.sleep(for: .milliseconds(50))
                }
                guard !running else { throw BridgeFailure(code: "PYTHON_STOPPING", message: localized("The task is still stopping. Use Force stop before running again.", "任务仍在停止，请强制停止后再重新运行。")) }
            }
            try await startSaved(environment: values)
        } catch { self.error = error.localizedDescription }
    }
    func find(previous: Bool = false) {
        guard let terminal else { return }
        if search.isEmpty { terminal.view.clearSearch(); searchSummary = ""; return }
        terminal.followTaskLog(false)
        if previous { terminal.view.findPrevious(search) }
        else { terminal.view.findNext(search) }
        let result = terminal.view.searchMatchSummary(search)
        searchSummary = "\(result.index)/\(result.total)"
    }
    func copyOutput() {
        guard let terminal else { return }
        NSPasteboard.general.clearContents()
        if NSPasteboard.general.setString(terminal.text, forType: .string) {
            feedback = localized("Output copied.", "输出已复制。")
        } else { error = localized("Could not copy retained output.", "无法复制保留的输出。") }
    }
    func stop(force: Bool) async {
        let task = tasks.first { $0["running"].bool == true } ?? .null
        guard !busy, !prepared, task["running"].bool == true,
              let id = task["spec"]["id"].string, let generation = task["generation"].string else { return }
        busy = true; error = ""
        defer { busy = false }
        do {
            _ = try await bridge.call("python.stop", params: .object([
                "id": .string(id), "generation": .string(generation), "force": .bool(force)
            ]))
            await refreshTasks()
        } catch { self.error = error.localizedDescription }
    }
    func refreshTasks() async {
        guard !closed else { return }
        do {
            let loaded = try await bridge.call("python.tasks", params: .object(["directory": .string(directory)]))
            tasks = loaded.array.sorted { ($0["task"]["created"].number ?? 0) > ($1["task"]["created"].number ?? 0) }
            if !tasks.contains(where: { $0["spec"]["id"].string == selectedID }) { selectedID = tasks.first?["spec"]["id"].string ?? "" }
            await selectTask()
        } catch { self.error = error.localizedDescription }
    }
    func selectTask() async {
        guard !closed, let id = selectedTask["spec"]["id"].string,
              let generation = selectedTask["generation"].string else { return }
        guard !selecting else { return }
        selecting = true
        defer {
            selecting = false
            if !closed, !selectedID.isEmpty, terminal?.id != selectedID { Task { await self.selectTask() } }
        }
        if terminal?.id == id && terminal?.generation == generation { return }
        if let current = terminal {
            _ = try? await bridge.call("terminal.action", params: .object(["attachment": .string(current.attachment), "action": .string("detach")]))
        }
        do {
            let entry: JSONValue = .object([
                "directory": .string(directory), "projectId": .null, "rosterId": .string("task"),
                "workspaceId": .string("local"), "session": selectedTask["spec"]
            ])
            let decoded = try JSONDecoder().decode(CoreSessionEntry.self, from: JSONEncoder().encode(entry))
            let log = TerminalSession(entry: decoded, bridge: bridge, taskGeneration: generation)
            log.apply(settings: settings, catalog: try await bridge.call("settings.catalog"))
            log.changed = { [weak self] in self?.objectWillChange.send() }
            terminal = log
            searchSummary = ""
            await log.connect(reconnectOnly: true)
            if !log.error.isEmpty { error = log.error }
        } catch { self.error = error.localizedDescription }
    }
    func detach() async {
        closed = true; polling?.cancel(); frames?.cancel(); failures?.cancel()
        if let terminal {
            _ = try? await bridge.call("terminal.action", params: .object(["attachment": .string(terminal.attachment), "action": .string("detach")]))
        }
        await bridge.close()
    }
}

@MainActor
struct PythonRunView: View {
    @ObservedObject var model: PythonRunModel
    let reload: () -> Void
    @State private var viewportWidth: CGFloat = 1100
    @State private var configurationExpanded = true
    @State private var advancedExpanded = false
    private var palette: JSONValue { NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog) }
    private var blocked: Bool { model.busy || model.prepared || model.config == nil }
    private var web: Bool { ["fastapi", "flask", "django"].contains(model.config?.mode ?? "") }
    private var fileTarget: Bool { ["script", "django"].contains(model.config?.mode ?? "") }
    private var columns: [GridItem] { Array(repeating: GridItem(.flexible(minimum: 0), spacing: 12, alignment: .top), count: RunPanelLayout.formColumns(viewportWidth: Double(viewportWidth))) }
    func text(_ key: WritableKeyPath<CorePythonRunConfig, String?>) -> Binding<String> {
        Binding(get: { model.config?[keyPath: key] ?? "" }, set: { model.config?[keyPath: key] = $0; model.dirty = true })
    }
    private func input(_ title: String, _ key: WritableKeyPath<CorePythonRunConfig, String?>, id: String, completions: [String]? = nil) -> some View {
        NativeRunTextField(text: text(key), label: title, id: "native-python-" + id, palette: palette, completions: completions).frame(height: 28)
    }
    private func choose(_ kind: String, title: String) -> some View {
        NativeRunAction(title: title, id: "native-python-choose-" + kind, palette: palette, icon: .folder, iconOnly: true) { Task { await model.choosePath(kind) } }.fixedSize()
    }
    private var interpreterField: some View {
        NativeRunFormField(localized("Python interpreter", "Python 解释器"), id: "native-python-field-interpreter") {
            HStack(spacing: 5) {
                input(localized("Python interpreter", "Python 解释器"), \.interpreter, id: "interpreter", completions: model.interpreters.compactMap { $0["path"].string })
                choose("interpreter", title: localized("Choose Python interpreter", "选择 Python 解释器"))
            }
            Text(model.interpreters.first { $0["path"].string == model.config?.interpreter }?["version"].string ?? localized("Use an existing Python 3 environment", "使用已有 Python 3 环境"))
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }
    private var primaryFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            if RunPanelLayout.interpreterFillsRow(viewportWidth: Double(viewportWidth)) { interpreterField }
            LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
                if !RunPanelLayout.interpreterFillsRow(viewportWidth: Double(viewportWidth)) { interpreterField }
                NativeRunFormField(localized("Launch mode", "启动方式"), id: "native-python-field-mode") {
                    Picker(localized("Launch mode", "启动方式"), selection: Binding(get: { model.config?.mode ?? "script" }, set: {
                        guard let config = model.config else { return }
                        model.config = PythonRunDraft.changingMode(config, to: $0, candidates: model.candidates)
                        model.port = String(model.config?.port ?? 8000); model.dirty = true
                    })) {
                        Text(localized("Python script", "Python 脚本")).tag("script"); Text(localized("Python module", "Python 模块")).tag("module")
                        Text("FastAPI").tag("fastapi"); Text("Flask").tag("flask"); Text("Django").tag("django")
                    }.labelsHidden().frame(height: 28)
                }
                NativeRunFormField(fileTarget ? localized("Startup script", "启动脚本") : localized("Entry point", "应用入口"), id: "native-python-field-target") {
                    HStack(spacing: 5) {
                        input(localized("Entry point", "应用入口"), \.target, id: "target", completions: model.candidates.filter { $0["mode"].string == model.config?.mode }.compactMap { $0["target"].string })
                        if fileTarget { choose("script", title: localized("Choose Python script", "选择 Python 脚本")) }
                    }
                }
                NativeRunFormField(localized("Working directory", "工作目录")) {
                    HStack(spacing: 5) { input(localized("Working directory", "工作目录"), \.working_directory, id: "directory"); choose("directory", title: localized("Choose Python working directory", "选择 Python 工作目录")) }
                }
                if web {
                    NativeRunFormField(localized("Listen address", "监听地址")) { input(localized("Listen address", "监听地址"), \.host, id: "host") }
                    NativeRunFormField(localized("Port", "端口")) {
                        HStack(spacing: 8) {
                            NativeRunTextField(text: Binding(get: { model.port }, set: { model.port = $0; model.dirty = true }), label: localized("Port", "端口"), id: "native-python-port", palette: palette).frame(height: 28)
                            Toggle(localized("Auto reload", "自动重载"), isOn: Binding(get: { model.config?.reload ?? false }, set: { model.config?.reload = $0; model.dirty = true })).toggleStyle(.checkbox).fixedSize()
                        }
                    }
                }
            }
        }.padding(.top, 7)
    }
    private var advancedFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
                NativeRunFormField(localized("Application arguments", "应用参数")) {
                    NativeRunTextArea(text: Binding(get: { model.argumentInput }, set: { model.editArguments($0) }), label: localized("Application arguments", "应用参数"), id: "native-python-arguments", palette: palette).frame(height: 40)
                }
                NativeRunFormField(localized("Environment variables", "环境变量")) {
                    NativeRunTextArea(text: Binding(get: { model.environmentInput }, set: { model.editEnvironment($0) }), label: localized("Environment variables", "环境变量"), id: "native-python-environment", palette: palette).frame(height: 40)
                    Text(localized("Only for this run; environment values are not saved.", "仅用于本次运行，不保存环境变量。")).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            HStack {
                Spacer()
                NativeRunAction(title: localized("Save configuration", "保存配置"), id: "native-python-save-configuration", palette: palette, height: 28) { Task { _ = await model.save() } }.fixedSize()
            }
        }.padding(.top, 7)
    }
    private var configuration: some View {
        NativeRunDisclosure(localized("Run configuration", "运行配置"), id: "native-python-configuration-toggle", expanded: $configurationExpanded) {
            VStack(alignment: .leading, spacing: 8) {
                primaryFields
                NativeRunDisclosure(localized("Advanced settings", "高级设置"), id: "native-python-advanced-toggle", expanded: $advancedExpanded) { advancedFields }
            }
        }.font(.system(size: 11))
    }
    private var taskToolbar: some View {
        NativeRunToolbarLayout() {
            NativeRunTaskState(running: model.running, busy: model.busy, selected: model.selectedTask)
            if let running = model.tasks.first(where: { $0["running"].bool == true }), let url = PythonRunDraft.serviceURL(task: running) {
                Button(url.absoluteString) {
                    if !NSWorkspace.shared.open(url) { model.error = localized("Could not open the service address.", "无法打开服务地址。") }
                }.lineLimit(1).help(localized("Open service address", "打开服务地址"))
            }
            Spacer(minLength: 0).layoutValue(key: NativeRunToolbarSpace.self, value: true)
            Menu {
                Button(localized("Reload saved configuration", "重新读取已保存的配置"), action: reload)
                Button(localized("Run again", "重新运行")) { Task { await model.runAgain() } }.disabled(model.tasks.isEmpty)
                Button(localized("Force stop", "强制停止")) { Task { await model.stop(force: true) } }.disabled(!model.running)
            } label: { Image(systemName: "ellipsis") }.fixedSize().help(localized("More actions", "更多操作"))
            NativeRunAction(title: model.running ? localized("Run again", "重新运行") : localized("Run", "运行"), id: "native-python-run", palette: palette, icon: model.running ? .restart : .python, primary: true) {
                Task { if model.running { await model.runAgain() } else { await model.run() } }
            }.fixedSize().disabled(model.config?.interpreter?.isEmpty != false || model.config?.target?.isEmpty != false)
            NativeRunAction(title: localized("Stop", "停止"), id: "native-python-stop", palette: palette) { Task { await model.stop(force: false) } }.fixedSize().disabled(!model.running)
        }.disabled(model.busy || model.prepared).padding(.horizontal, 12).padding(.vertical, 6)
            .overlay(alignment: .top) { border }.overlay(alignment: .bottom) { border }
    }
    private var border: some View { Color(nsColor: NativePreferences.color(palette["border"], fallback: .separatorColor)).frame(height: 1) }
    private var output: some View {
        Group {
            if let terminal = model.terminal {
                NativeRunLogToolbar(terminal: terminal, search: $model.search, summary: model.searchSummary, taskName: model.selectedTask["task"]["name"].string ?? "", find: { model.find(previous: $0) }, copy: { model.copyOutput() })
                PythonLogCanvas(terminal: terminal).id(terminal.attachment).frame(minHeight: model.workspaceDocked ? 0 : 160, maxHeight: .infinity)
                if !terminal.error.isEmpty { Text(terminal.error).foregroundStyle(.red).padding(8) }
            } else {
                Text(localized("Choose a Python environment and startup target, then run. Logs appear here.", "请选择 Python 环境和启动目标后运行，日志将在此显示。"))
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(12)
            }
        }
    }
    var body: some View {
        GeometryReader { geometry in
            VStack(alignment: .leading, spacing: 0) {
                if !model.workspaceDocked {
                    HStack { Text(model.directory).lineLimit(1).truncationMode(.middle); Spacer(); Button(localized("Check again", "重新检测")) { Task { await model.detect() } } }.padding(8).disabled(blocked)
                }
                NativeRunConfiguration(maximumHeight: max(0, geometry.size.height * 0.48)) { configuration }.disabled(blocked)
                taskToolbar
                if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled).padding(8) }
                if !model.feedback.isEmpty { Text(model.feedback).foregroundStyle(.secondary).padding(8) }
                if model.tasks.count > 1 {
                    Picker(localized("Task history", "任务历史"), selection: $model.selectedID) {
                        ForEach(Array(model.tasks.enumerated()), id: \.offset) { _, task in Text(task["task"]["name"].string ?? "").tag(task["spec"]["id"].string ?? "") }
                    }.onChange(of: model.selectedID) { _, _ in Task { await model.selectTask() } }.disabled(model.busy || model.prepared).padding(.horizontal, 12)
                }
                output
            }.font(.system(size: 12)).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .foregroundStyle(Color(nsColor: NativePreferences.color(palette["text"], fallback: .labelColor)))
                .background(Color(nsColor: NativePreferences.color(palette["canvas"], fallback: .windowBackgroundColor)))
                .background(NativeRunViewport(width: $viewportWidth))
        }
    }
}

@MainActor
private struct PythonLogCanvas: NSViewRepresentable {
    let terminal: TerminalSession
    func makeNSView(context: Context) -> NSView { terminal.view }
    func updateNSView(_ view: NSView, context: Context) {}
}

@MainActor
final class PythonWindow: NSWindowController, NSWindowDelegate, NativeWorkspacePanelContent {
    let model: PythonRunModel
    private(set) var workspacePanelView: NSView?
    func workspaceEmbeddingChanged(_ embedded: Bool) { model.workspaceDocked = embedded }
    var didClose: (() -> Void)?
    private var closing = false
    init(model: PythonRunModel) {
        self.model = model
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 720), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init(window: window)
        window.title = localized("Python run", "Python 运行") + " · " + URL(fileURLWithPath: model.directory).lastPathComponent
        window.minSize = NSSize(width: 640, height: 560); window.delegate = self
        let appearance = model.settings["appearance"].string
        window.appearance = appearance == "light" ? NSAppearance(named: .aqua) : appearance == "dark" ? NSAppearance(named: .darkAqua) : nil
        workspacePanelView = NSHostingView(rootView: PythonRunView(model: model, reload: { [weak self] in self?.reloadSaved() }))
        window.contentView = workspacePanelView
        window.center()
    }
    required init?(coder: NSCoder) { fatalError("Use programmatic construction") }
    private func discardChoice() -> NSApplication.ModalResponse {
        let alert = NSAlert()
        alert.messageText = localized("Python configuration has unsaved changes.", "Python 配置尚未保存。")
        alert.addButton(withTitle: localized("Cancel", "取消")); alert.addButton(withTitle: localized("Discard changes", "放弃修改")); alert.addButton(withTitle: localized("Save", "保存"))
        alert.window.defaultButtonCell = alert.buttons[0].cell as? NSButtonCell
        return alert.runModal()
    }
    private func reloadSaved() {
        guard !model.busy, !model.prepared else { return }
        Task {
            if model.dirty {
                switch discardChoice() {
                case .alertSecondButtonReturn: break
                case .alertThirdButtonReturn: guard await model.save() else { return }
                default: return
                }
            }
            await model.reload()
        }
    }
    func prepareForQuit() async -> Bool {
        guard !model.busy else { model.error = localized("Wait for the Python operation to finish.", "请等待 Python 操作完成。"); return false }
        if model.prepared { return true }
        // Docked panels save loaded configuration on hide, including clean stale snapshots.
        // 停靠面板隐藏时保存已加载配置，包括未编辑但修订已过期的快照。
        if model.workspaceDocked, model.config != nil {
            guard await model.save() else { return false }
        } else if model.dirty {
            switch discardChoice() {
            case .alertSecondButtonReturn: break
            case .alertThirdButtonReturn: guard await model.save() else { return false }
            default: return false
            }
        }
        model.prepared = true
        return true
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !closing, !model.prepared else { return false }
        closing = true
        Task { @MainActor in
            if await prepareForQuit() { await forceClose() }
            else { closing = false }
        }
        return false
    }
    func forceClose() async {
        await model.detach()
        window?.delegate = nil; close(); didClose?()
    }
    func resumeAfterQuit() { model.prepared = false }
}
