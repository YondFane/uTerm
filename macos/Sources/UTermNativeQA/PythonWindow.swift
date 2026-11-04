import AppKit
import SwiftUI
import UTermBridge

struct PythonArgument: Identifiable { let id = UUID(); var text: String }
struct PythonEnvironment: Identifiable { let id = UUID(); var key = ""; var value = "" }

@MainActor
final class PythonRunModel: ObservableObject {
    let directory: String
    let bridge: CoreBridge
    let settings: JSONValue
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
            var values: [String: JSONValue] = [:]
            for row in environment {
                guard values[row.key] == nil else {
                    throw BridgeFailure(code: "PYTHON_ENVIRONMENT_INVALID", message: localized("Environment names must be unique.", "环境变量名称不能重复。"))
                }
                values[row.key] = .string(row.value)
            }
            try await persist()
            let task = try await bridge.call("python.start", params: .object([
                "directory": .string(directory), "config": try value(formConfig()), "environment": .object(values)
            ]))
            selectedID = task["spec"]["id"].string ?? ""
            await refreshTasks()
        } catch { self.error = error.localizedDescription }
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
            log.apply(settings: settings)
            log.changed = { [weak self] in self?.objectWillChange.send() }
            terminal = log
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
            Text(model.directory).font(.caption).textSelection(.enabled)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        TextField(localized("Python interpreter", "Python 解释器"), text: text(\.interpreter))
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
                    TextField(localized("Working directory", "工作目录"), text: text(\.working_directory))
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
                PythonLogCanvas(terminal: terminal).id(terminal.attachment).frame(minHeight: 160)
                HStack {
                    Text(terminal.error).foregroundStyle(.red)
                    Spacer()
                    Button(localized("Copy retained output", "复制保留的输出")) {
                        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(terminal.text, forType: .string)
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
final class PythonWindow: NSWindowController, NSWindowDelegate {
    let model: PythonRunModel
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
        window.contentView = NSHostingView(rootView: PythonRunView(model: model, reload: { [weak self] in self?.reloadSaved() }))
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
        if model.dirty && discardChoice() != .alertSecondButtonReturn { return }
        Task { await model.reload() }
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
