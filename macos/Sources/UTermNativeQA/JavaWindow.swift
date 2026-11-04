import AppKit
import SwiftUI
import SwiftTerm
import UTermBridge

struct JavaArgument: Identifiable { let id = UUID(); var text: String }
struct JavaEnvironment: Identifiable { let id = UUID(); var key = ""; var value = "" }

@MainActor
final class JavaRunModel: ObservableObject {
    let directory: String
    let bridge: CoreBridge
    let settings: JSONValue
    @Published var config: CoreJavaProjectConfig?
    @Published var arguments: [JavaArgument] = []
    @Published var environment: [JavaEnvironment] = []
    @Published var global: CoreJavaMavenConfig?
    @Published var vmArguments: [JavaArgument] = []
    @Published var action = "run"
    @Published var error = ""
    @Published var feedback = ""
    @Published var busy = true
    @Published var prepared = false
    @Published var dirty = false
    @Published var tasks: [JSONValue] = []
    @Published var jdks: [JSONValue] = []
    @Published var modules: [JSONValue] = []
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
            let loaded = try await bridge.call("java.configuration", params: .object(["directory": .string(directory)]))
            try apply(loaded)
            try await detectValues()
            await refreshTasks()
        } catch { self.error = error.localizedDescription }
    }
    private func apply(_ response: JSONValue) throws {
        let loaded = try JSONDecoder().decode(CoreJavaConfiguration.self, from: JSONEncoder().encode(response))
        config = loaded.project; revision = loaded.revision
        arguments = (loaded.project.arguments ?? []).map { JavaArgument(text: $0) }
        global = loaded.global
        vmArguments = (loaded.project.vm_arguments ?? []).map { JavaArgument(text: $0) }
        dirty = false
    }
    private func detectValues() async throws {
        jdks = try await bridge.call("java.jdks.list").array
        modules = try await bridge.call("java.project", params: .object(["directory": .string(directory)]))["modules"].array
    }
    func detect() async {
        guard !busy, !prepared else { return }
        busy = true; error = ""
        defer { busy = false }
        do { try await detectValues() } catch { self.error = error.localizedDescription }
    }
    private func formConfig() throws -> CoreJavaProjectConfig {
        guard var result = config else {
            throw BridgeFailure(code: "JAVA_CONFIG_INVALID", message: localized("Load Java configuration first.", "请先读取 Java 配置。"))
        }
        result.arguments = arguments.map(\.text); result.vm_arguments = vmArguments.map(\.text)
        return result
    }
    private func persist() async throws {
        let response = try await bridge.call("java.saveConfiguration", params: .object([
            "directory": .string(directory), "revision": .string(revision), "project": try value(formConfig()), "global": try value(global)
        ]))
        try apply(response)
        feedback = localized("Configuration saved.", "配置已保存。")
    }
    private func environmentValues() throws -> [String: JSONValue] {
        var values: [String: JSONValue] = [:]
        for row in environment {
            guard values[row.key] == nil else {
                throw BridgeFailure(code: "JAVA_ENVIRONMENT_INVALID", message: localized("Environment names must be unique.", "环境变量名称不能重复。"))
            }
            values[row.key] = .string(row.value)
        }
        return values
    }
    private func startSaved(environment: [String: JSONValue]) async throws {
        let task = try await bridge.call("java.start", params: .object([
            "directory": .string(directory), "config": try value(formConfig()), "action": .string(action), "environment": .object(environment)
        ]))
        selectedID = task["spec"]["id"].string ?? ""
        await refreshTasks()
    }
    private func runError(_ error: Error) -> String {
        if let failure = error as? BridgeFailure, failure.code == "JAVA_DEVELOPMENT_ARGUMENTS_UNSUPPORTED" {
            return localized("Spring Boot development mode cannot preserve empty or whitespace-only arguments, line breaks or tabs. Use JAR mode.", "Spring Boot 开发模式无法保留空参数、纯空白参数、换行或制表符，请使用 JAR 模式。")
        }
        return error.localizedDescription
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
        } catch { self.error = runError(error) }
    }
    func runAgain() async {
        guard !busy, !prepared else { return }
        busy = true; error = ""; feedback = ""
        defer { busy = false }
        do {
            let values = try environmentValues()
            try await persist()
            if let active = tasks.first(where: { $0["running"].bool == true }) {
                _ = try await bridge.call("java.stop", params: .object([
                    "id": active["spec"]["id"], "generation": active["generation"], "force": .bool(false)
                ]))
                let deadline = Date().addingTimeInterval(5)
                while Date() < deadline {
                    await refreshTasks()
                    if !running { break }
                    try await Task.sleep(for: .milliseconds(50))
                }
                guard !running else { throw BridgeFailure(code: "JAVA_STOPPING", message: localized("The task is still stopping. Use Force stop before running again.", "任务仍在停止，请强制停止后再重新运行。")) }
            }
            try await startSaved(environment: values)
        } catch { self.error = runError(error) }
    }
    func registerJDK(remove: Bool = false) async {
        guard !busy, !prepared, let home = config?.java_home, !home.isEmpty else { return }
        busy = true; error = ""
        defer { busy = false }
        do {
            jdks = try await bridge.call("java.jdks.register", params: .object(["home": .string(home), "remove": .bool(remove)])).array
            feedback = remove ? localized("JDK registration removed; files retained.", "JDK 注册已移除，文件已保留。") : localized("JDK registered.", "JDK 已注册。")
        } catch { self.error = error.localizedDescription }
    }
    func setScope(_ scope: String) {
        if scope == "project", config?.maven_configured != true { config?.maven = global }
        config?.maven_scope = scope; dirty = true
    }
    func choosePath(_ kind: String) {
        guard !busy, !prepared else { return }
        busy = true
        defer { busy = false }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = !["jar", "settings"].contains(kind)
        panel.canChooseFiles = !panel.canChooseDirectories; panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: directory)
        guard panel.runModal() == .OK, let selected = panel.url else { return }
        let path = selected.standardizedFileURL.resolvingSymlinksInPath()
        if kind == "jar" {
            let root = URL(fileURLWithPath: directory).resolvingSymlinksInPath().path
            guard path.path.hasPrefix(root + "/"), path.pathExtension == "jar" else {
                error = localized("Choose a JAR inside this project.", "请选择此项目内的 JAR。"); return
            }
            config?.jar = String(path.path.dropFirst(root.count + 1))
        } else if kind == "jdk" { config?.java_home = path.path }
        else {
            let key: WritableKeyPath<CoreJavaMavenConfig, String?> = kind == "settings" ? \.settings : kind == "repository" ? \.repository : \.home
            if config?.maven_scope == "project" { config?.maven?[keyPath: key] = path.path }
            else { global?[keyPath: key] = path.path }
        }
        dirty = true
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
            _ = try await bridge.call("java.stop", params: .object([
                "id": .string(id), "generation": .string(generation), "force": .bool(force)
            ]))
            await refreshTasks()
        } catch { self.error = error.localizedDescription }
    }
    func refreshTasks() async {
        guard !closed else { return }
        do {
            let loaded = try await bridge.call("java.tasks", params: .object(["directory": .string(directory)]))
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
struct JavaRunView: View {
    @ObservedObject var model: JavaRunModel
    let reload: () -> Void
    func text(_ key: WritableKeyPath<CoreJavaProjectConfig, String?>) -> Binding<String> {
        Binding(get: { model.config?[keyPath: key] ?? "" }, set: { model.config?[keyPath: key] = $0; model.dirty = true })
    }
    func flag(_ key: WritableKeyPath<CoreJavaProjectConfig, Bool?>) -> Binding<Bool> {
        Binding(get: { model.config?[keyPath: key] ?? false }, set: { model.config?[keyPath: key] = $0; model.dirty = true })
    }
    func maven(_ key: WritableKeyPath<CoreJavaMavenConfig, String?>) -> Binding<String> {
        Binding(get: { model.config?.maven_scope == "project" ? model.config?.maven?[keyPath: key] ?? "" : model.global?[keyPath: key] ?? "" }, set: {
            if model.config?.maven_scope == "project" { model.config?.maven?[keyPath: key] = $0 }
            else { model.global?[keyPath: key] = $0 }
            model.dirty = true
        })
    }
    func argumentRows(_ rows: Binding<[JavaArgument]>, title: String) -> some View {
        VStack(alignment: .leading) {
            Text(title).font(.caption)
            ForEach(rows) { row in
                HStack {
                    TextField(title, text: row.text).onChange(of: row.wrappedValue.text) { _, _ in model.dirty = true }
                    Button("−") { let id = row.wrappedValue.id; rows.wrappedValue.removeAll { $0.id == id }; model.dirty = true }
                }
            }
            Button(localized("Add argument", "添加参数")) { rows.wrappedValue.append(JavaArgument(text: "")); model.dirty = true }
        }
    }
    var mavenFields: some View {
        GroupBox(localized("Maven configuration", "Maven 配置")) {
            VStack {
                Picker(localized("Configuration scope", "配置范围"), selection: Binding(get: { model.config?.maven_scope ?? "global" }, set: { model.setScope($0) })) {
                    Text(localized("System-wide", "系统全局")).tag("global")
                    Text(localized("Project", "项目独立")).tag("project")
                }
                Picker(localized("Distribution", "分发方式"), selection: maven(\.distribution)) {
                    Text(localized("Local", "本地")).tag("local"); Text(localized("Managed", "受管")).tag("managed")
                }
                HStack { TextField(localized("Maven home", "Maven 目录"), text: maven(\.home)); Button(localized("Choose…", "选择…")) { model.choosePath("home") } }
                HStack { TextField("settings.xml", text: maven(\.settings)); Button(localized("Choose…", "选择…")) { model.choosePath("settings") } }
                HStack { TextField(localized("Local repository", "本地仓库"), text: maven(\.repository)); Button(localized("Choose…", "选择…")) { model.choosePath("repository") } }
                Toggle(localized("Prefer project Wrapper", "优先项目 Wrapper"), isOn: Binding(get: { model.config?.maven_scope == "project" ? model.config?.maven?.wrapper ?? true : model.global?.wrapper ?? true }, set: {
                    if model.config?.maven_scope == "project" { model.config?.maven?.wrapper = $0 } else { model.global?.wrapper = $0 }; model.dirty = true
                }))
            }
        }
    }
    var configuration: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker(localized("Module", "模块"), selection: Binding(get: { model.config?.module ?? "." }, set: {
                if model.config?.module != $0 { model.config?.main_class = "" }
                text(\.module).wrappedValue = $0
            })) {
                ForEach(Array(model.modules.enumerated()), id: \.offset) { _, module in
                    Text((module["name"].string ?? "") + " · " + (module["path"].string ?? "")).tag(module["path"].string ?? ".")
                }
            }
            HStack {
                Picker(localized("Java version", "Java 版本"), selection: Binding(get: { model.config?.java_version ?? 21 }, set: { model.config?.java_version = $0; model.dirty = true })) {
                    ForEach([UInt32(8), 11, 17, 21], id: \.self) { Text(String($0)).tag($0) }
                }
                TextField(localized("JDK home (automatic when empty)", "JDK 目录（留空自动检测）"), text: text(\.java_home))
                Button(localized("Choose…", "选择…")) { model.choosePath("jdk") }
                Menu(localized("Detected JDKs", "已检测 JDK")) {
                    ForEach(Array(model.jdks.enumerated()), id: \.offset) { _, jdk in
                        Button((jdk["home"].string ?? "") + (jdk["available"].bool == true ? "" : localized(" · Unavailable", " · 不可用"))) { text(\.java_home).wrappedValue = jdk["home"].string ?? "" }
                    }
                }
            }
            HStack {
                Button(localized("Check again", "重新检测")) { Task { await model.detect() } }
                Button(localized("Register JDK", "注册 JDK")) { Task { await model.registerJDK() } }
                Button(localized("Remove registration", "移除注册")) { Task { await model.registerJDK(remove: true) } }
            }
            Picker(localized("Run mode", "运行方式"), selection: text(\.mode)) {
                Text(localized("Development run", "开发启动")).tag("development"); Text(localized("JAR run", "JAR 启动")).tag("jar")
            }
            if model.config?.mode == "jar" {
                HStack {
                    TextField(localized("Existing JAR (empty to package first)", "已有 JAR（留空先打包）"), text: text(\.jar))
                    Button(localized("Choose…", "选择…")) { model.choosePath("jar") }
                }
            } else {
                HStack {
                    TextField(localized("Main class (automatic when empty)", "启动主类（留空自动选择）"), text: text(\.main_class))
                    Menu(localized("Detected main classes", "已检测主类")) {
                        ForEach(Array((model.modules.first { $0["path"].string == model.config?.module }?["main_classes"].array ?? []).enumerated()), id: \.offset) { _, entry in
                            Button(entry["name"].string ?? "") { text(\.main_class).wrappedValue = entry["name"].string ?? "" }
                        }
                    }
                }
            }
            DisclosureGroup(localized("Advanced settings", "高级设置")) {
                VStack(alignment: .leading, spacing: 8) {
                    mavenFields
                    TextField(localized("Maven profiles", "Maven Profile"), text: text(\.maven_profiles))
                    TextField(localized("Spring profiles", "Spring Profile"), text: text(\.spring_profiles))
                    argumentRows($model.vmArguments, title: localized("Literal JVM argument", "字面 JVM 参数"))
                    argumentRows($model.arguments, title: localized("Literal application argument", "字面应用参数"))
                    ForEach($model.environment) { $row in
                        HStack {
                            TextField(localized("Environment name", "环境变量名称"), text: $row.key)
                            TextField(localized("Temporary value", "临时值"), text: $row.value)
                            Button("−") { model.environment.removeAll { $0.id == row.id } }
                        }
                    }
                    Button(localized("Add temporary environment", "添加临时环境变量")) { model.environment.append(JavaEnvironment()) }
                    HStack { Toggle(localized("Skip tests", "跳过测试"), isOn: flag(\.skip_tests)); Toggle(localized("Maven offline", "Maven 离线"), isOn: flag(\.offline)) }
                }.padding(.top, 5)
            }
            HStack { Spacer(); Button(localized("Save configuration", "保存配置")) { Task { _ = await model.save() } }.controlSize(.small) }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.directory).font(.caption).textSelection(.enabled)
            ScrollView { configuration.padding(2) }.frame(maxHeight: 310).disabled(model.busy || model.prepared || model.config == nil)
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled) }
            if !model.feedback.isEmpty { Text(model.feedback).font(.caption) }
            HStack {
                Button(localized("Reload saved configuration", "重新读取已保存的配置"), action: reload)
                Picker(localized("Task", "任务"), selection: $model.action) {
                    Text(localized("Run", "运行")).tag("run"); Text(localized("Package", "打包")).tag("build")
                    Text(localized("Test", "测试")).tag("test"); Text(localized("Install", "安装")).tag("install")
                }.frame(maxWidth: 160)
                Spacer()
                Button(localized("Start", "启动")) { Task { await model.run() } }.disabled(model.running)
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
                JavaLogCanvas(terminal: terminal).id(terminal.attachment).frame(minHeight: 160)
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
private struct JavaLogCanvas: NSViewRepresentable {
    let terminal: TerminalSession
    func makeNSView(context: Context) -> NSView { terminal.view }
    func updateNSView(_ view: NSView, context: Context) {}
}

@MainActor
final class JavaWindow: NSWindowController, NSWindowDelegate {
    let model: JavaRunModel
    var didClose: (() -> Void)?
    private var closing = false
    init(model: JavaRunModel) {
        self.model = model
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 720), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init(window: window)
        window.title = localized("Java build and run", "Java 构建与运行") + " · " + URL(fileURLWithPath: model.directory).lastPathComponent
        window.minSize = NSSize(width: 640, height: 560); window.delegate = self
        let appearance = model.settings["appearance"].string
        window.appearance = appearance == "light" ? NSAppearance(named: .aqua) : appearance == "dark" ? NSAppearance(named: .darkAqua) : nil
        window.contentView = NSHostingView(rootView: JavaRunView(model: model, reload: { [weak self] in self?.reloadSaved() }))
        window.center()
    }
    required init?(coder: NSCoder) { fatalError("Use programmatic construction") }
    private func discardChoice() -> NSApplication.ModalResponse {
        let alert = NSAlert()
        alert.messageText = localized("Java configuration has unsaved changes.", "Java 配置尚未保存。")
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
        guard !model.busy else { model.error = localized("Wait for the Java operation to finish.", "请等待 Java 操作完成。"); return false }
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
