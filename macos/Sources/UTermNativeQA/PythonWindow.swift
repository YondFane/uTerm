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
    @Published var config: CorePythonRunConfig?
    @Published var arguments: [PythonArgument] = []
    @Published var environment: [PythonEnvironment] = []
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
    private var revision = ""
    private var polling: Task<Void, Never>?
    private var frames: Task<Void, Never>?
    private var failures: Task<Void, Never>?
    private var closed = false
    private var selecting = false
    var selectedTask: JSONValue { tasks.first { $0["spec"]["id"].string == selectedID } ?? .null }
    var running: Bool { tasks.contains { $0["running"].bool == true } }

    init(directory: String, bridge: CoreBridge, settings: JSONValue) {
        self.directory = directory; self.bridge = bridge; self.settings = settings
    }
    func applySettings(_ value: JSONValue, catalog: JSONValue) {
        if settings != value { objectWillChange.send(); settings = value }
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
    private func formConfig() throws -> CorePythonRunConfig {
        guard var result = config, let number = UInt16(port) else {
            throw BridgeFailure(code: "PYTHON_CONFIG_INVALID", message: localized("Enter a valid port.", "请填写有效端口。"))
        }
        result.port = number; result.arguments = arguments.map(\.text)
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
        var values: [String: JSONValue] = [:]
        for row in environment {
            guard values[row.key] == nil else {
                throw BridgeFailure(code: "PYTHON_ENVIRONMENT_INVALID", message: localized("Environment names must be unique.", "环境变量名称不能重复。"))
            }
            values[row.key] = .string(row.value)
        }
        return values
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
        let task = selectedTask
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
    func text(_ key: WritableKeyPath<CorePythonRunConfig, String?>) -> Binding<String> {
        Binding(get: { model.config?[keyPath: key] ?? "" }, set: { model.config?[keyPath: key] = $0; model.dirty = true })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !model.workspaceDocked { Text(model.directory).font(.caption).textSelection(.enabled) }
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        TextField(localized("Python interpreter", "Python 解释器"), text: text(\.interpreter))
                        Button(localized("Choose…", "选择…")) { Task { await model.choosePath("interpreter") } }
                        Menu(localized("Detected", "已检测")) {
                            ForEach(Array(model.interpreters.enumerated()), id: \.offset) { _, interpreter in
                                Button(interpreter["path"].string ?? "") { text(\.interpreter).wrappedValue = interpreter["path"].string ?? "" }
                            }
                        }
                        Button(localized("Check again", "重新检测")) { Task { await model.detect() } }
                    }
                    Picker(localized("Launch mode", "启动方式"), selection: text(\.mode)) {
                        Text(localized("Python script", "Python 脚本")).tag("script")
                        Text(localized("Python module", "Python 模块")).tag("module")
                        Text("FastAPI").tag("fastapi"); Text("Flask").tag("flask"); Text("Django").tag("django")
                    }
                    HStack {
                        TextField(localized("Entry point", "应用入口"), text: text(\.target))
                        if ["script", "django"].contains(model.config?.mode ?? "") {
                            Button(localized("Choose…", "选择…")) { Task { await model.choosePath("script") } }
                        }
                        Menu(localized("Project entries", "项目入口")) {
                            ForEach(Array(model.candidates.enumerated()), id: \.offset) { _, candidate in
                                Button(candidate["target"].string ?? "") {
                                    text(\.target).wrappedValue = candidate["target"].string ?? ""
                                    text(\.mode).wrappedValue = candidate["mode"].string ?? "script"
                                    text(\.working_directory).wrappedValue = candidate["working_directory"].string ?? "."
                                }
                            }
                        }
                    }
                    HStack {
                    TextField(localized("Working directory", "工作目录"), text: text(\.working_directory))
                        Button(localized("Choose…", "选择…")) { Task { await model.choosePath("directory") } }
                    }
                    if ["fastapi", "flask", "django"].contains(model.config?.mode ?? "") {
                        HStack {
                            TextField(localized("Listen address", "监听地址"), text: text(\.host))
                            TextField(localized("Port", "端口"), text: $model.port).frame(width: 80).onChange(of: model.port) { _, _ in model.dirty = true }
                            Toggle(localized("Auto reload", "自动重载"), isOn: Binding(get: { model.config?.reload ?? false }, set: { model.config?.reload = $0; model.dirty = true }))
                        }
                    }
                    DisclosureGroup(localized("Advanced settings", "高级设置")) {
                        VStack(alignment: .leading) {
                            ForEach($model.arguments) { $argument in
                                HStack {
                                    TextField(localized("Literal argument", "字面参数"), text: $argument.text).onChange(of: argument.text) { _, _ in model.dirty = true }
                                    Button("−") { model.arguments.removeAll { $0.id == argument.id }; model.dirty = true }
                                }
                            }
                            Button(localized("Add argument", "添加参数")) { model.arguments.append(PythonArgument(text: "")); model.dirty = true }
                            ForEach($model.environment) { $row in
                                HStack {
                                    TextField(localized("Environment name", "环境变量名称"), text: $row.key)
                                    TextField(localized("Temporary value", "临时值"), text: $row.value)
                                    Button("−") { model.environment.removeAll { $0.id == row.id } }
                                }
                            }
                            Button(localized("Add temporary environment variable", "添加临时环境变量")) { model.environment.append(PythonEnvironment()) }
                            Text(localized("Environment values apply only to this run and are not saved.", "环境变量只用于本次运行，不保存。")).font(.caption)
                        }
                    }
                    HStack { Spacer(); Button(localized("Save configuration", "保存配置")) { Task { _ = await model.save() } } }
                }.padding(2)
            }.frame(maxHeight: 290).disabled(model.busy || model.prepared || model.config == nil)
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled) }
            if !model.feedback.isEmpty { Text(model.feedback).font(.caption) }
            HStack {
                Button(localized("Reload saved configuration", "重新读取已保存的配置"), action: reload)
                Spacer()
                Button(localized("Run", "运行")) { Task { await model.run() } }.disabled(model.running)
                Button(localized("Run again", "重新运行")) { Task { await model.runAgain() } }.disabled(model.tasks.isEmpty)
                Button(localized("Stop", "停止")) { Task { await model.stop(force: false) } }.disabled(model.selectedTask["running"].bool != true)
                Button(localized("Force stop", "强制停止")) { Task { await model.stop(force: true) } }.disabled(model.selectedTask["running"].bool != true)
            }.disabled(model.busy || model.prepared)
            if !model.tasks.isEmpty {
                Picker(localized("Task history", "任务历史"), selection: $model.selectedID) {
                    ForEach(Array(model.tasks.enumerated()), id: \.offset) { _, task in
                        Text((task["task"]["name"].string ?? "") + (task["running"].bool == true ? localized(" · Running", " · 运行中") : " · \(Int(task["code"].number ?? 0))")).tag(task["spec"]["id"].string ?? "")
                    }
                }.onChange(of: model.selectedID) { _, _ in Task { await model.selectTask() } }.disabled(model.busy || model.prepared)
            }
            if let terminal = model.terminal {
                HStack {
                    TextField(localized("Search output", "搜索输出"), text: $model.search).onSubmit { model.find() }
                        .onChange(of: model.search) { _, value in if value.isEmpty { model.find() } }
                    Button("↑") { model.find(previous: true) }.accessibilityLabel(localized("Previous match", "上一个匹配"))
                    Button("↓") { model.find() }.accessibilityLabel(localized("Next match", "下一个匹配"))
                    Text(model.searchSummary).font(.caption)
                    Toggle(localized("Auto follow", "自动跟随"), isOn: Binding(get: { terminal.taskLogFollowsOutput }, set: { terminal.followTaskLog($0) })).toggleStyle(.checkbox)
                }
                PythonLogCanvas(terminal: terminal).id(terminal.attachment).frame(minHeight: 160)
                HStack {
                    Text(terminal.error).foregroundStyle(.red)
                    Spacer()
                    Button(localized("Copy retained output", "复制保留的输出")) {
                        model.copyOutput()
                    }
                }
            } else { Text(localized("No task output yet.", "尚无任务输出。")).frame(maxWidth: .infinity, maxHeight: .infinity) }
        }.padding(12)
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
        if model.dirty {
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
