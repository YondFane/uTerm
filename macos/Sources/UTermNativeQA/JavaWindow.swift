import AppKit
import SwiftUI
import SwiftTerm
import UTermBridge

struct JavaArgument: Identifiable { let id = UUID(); var text: String }
struct JavaEnvironment: Identifiable { let id = UUID(); var key = ""; var value = "" }

@MainActor
final class JavaRunModel: ObservableObject {
    @Published var workspaceDocked = false
    let directory: String
    let bridge: CoreBridge
    private(set) var settings: JSONValue
    private(set) var settingsCatalog: JSONValue
    @Published var config: CoreJavaProjectConfig?
    @Published var argumentInput = ""
    @Published var arguments: [JavaArgument] = [] { didSet { if !editingArgumentInput { argumentInput = RunPanelInput.formatArguments(arguments.map(\.text)) } } }
    @Published var environmentInput = ""
    @Published var environment: [JavaEnvironment] = [] { didSet { if !editingEnvironmentInput { environmentInput = environment.map { $0.key + "=" + $0.value }.joined(separator: "\n") } } }
    @Published var global: CoreJavaMavenConfig?
    @Published var vmArgumentInput = ""
    @Published var vmArguments: [JavaArgument] = [] { didSet { if !editingArgumentInput { vmArgumentInput = RunPanelInput.formatArguments(vmArguments.map(\.text)) } } }
    @Published var action = "run"
    @Published var error = ""
    @Published var feedback = ""
    @Published var busy = true
    @Published var prepared = false
    @Published var dirty = false
    @Published var tasks: [JSONValue] = []
    @Published var jdks: [JSONValue] = []
    @Published var modules: [JSONValue] = []
    private(set) var qaCompletedDetections = 0
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
        guard !busy, !prepared, !closed else { return }
        busy = true; error = ""
        defer { busy = false }
        do { try await detectValues(); qaCompletedDetections += 1 } catch { self.error = error.localizedDescription }
    }
    func editArguments(_ text: String, vm: Bool = false) {
        guard !busy, !prepared else { return }
        editingArgumentInput = true; defer { editingArgumentInput = false }
        if vm {
            vmArgumentInput = text
            if let values = try? RunPanelInput.arguments(text) { vmArguments = values.map { JavaArgument(text: $0) } }
        } else {
            argumentInput = text
            if let values = try? RunPanelInput.arguments(text) { arguments = values.map { JavaArgument(text: $0) } }
        }
        dirty = true
    }
    func editEnvironment(_ text: String) {
        guard !busy, !prepared else { return }
        editingEnvironmentInput = true; defer { editingEnvironmentInput = false }
        environmentInput = text
        if let values = try? RunPanelInput.environment(text) { environment = values.sorted { $0.key < $1.key }.map { JavaEnvironment(key: $0.key, value: $0.value) } }
    }
    private func formConfig() throws -> CoreJavaProjectConfig {
        guard var result = config else {
            throw BridgeFailure(code: "JAVA_CONFIG_INVALID", message: localized("Load Java configuration first.", "请先读取 Java 配置。"))
        }
        do { result.arguments = try RunPanelInput.arguments(argumentInput); result.vm_arguments = try RunPanelInput.arguments(vmArgumentInput) }
        catch { throw BridgeFailure(code: "JAVA_ARGUMENTS_INVALID", message: localized("Complete argument quotes and remove unsupported control characters.", "请补全参数引号并移除不支持的控制字符。")) }
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
        do { return try RunPanelInput.environment(environmentInput).mapValues { .string($0) } }
        catch { throw BridgeFailure(code: "JAVA_ENVIRONMENT_INVALID", message: localized("Use one NAME=value per line with unique names; UTERM_ names are reserved.", "每行填写一个 NAME=value，名称不能重复；UTERM_ 前缀为保留名称。")) }
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
        let task = tasks.first { $0["running"].bool == true } ?? .null
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
struct JavaRunView: View {
    @ObservedObject var model: JavaRunModel
    let reload: () -> Void
    @State private var viewportWidth: CGFloat = 1100
    @State private var configurationExpanded = true
    @State private var advancedExpanded = false
    @State private var mavenPresented = false
    @State private var buildGoal = "build"
    private var palette: JSONValue { NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog) }
    private var blocked: Bool { model.busy || model.prepared || model.config == nil }
    private var columns: [GridItem] { Array(repeating: GridItem(.flexible(minimum: 0), spacing: 12, alignment: .top), count: RunPanelLayout.formColumns(viewportWidth: Double(viewportWidth))) }
    private var selectedModule: JSONValue { model.modules.first { $0["path"].string == model.config?.module } ?? .null }
    private var mainClasses: [String] { selectedModule["main_classes"].array.compactMap { $0["name"].string } }
    private func input(_ title: String, _ key: WritableKeyPath<CoreJavaProjectConfig, String?>, id: String, completions: [String]? = nil) -> some View {
        NativeRunTextField(text: text(key), label: title, id: "native-java-" + id, palette: palette, completions: completions).frame(height: 28)
    }
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
    private var selectedJavaHome: String {
        if let home = model.config?.java_home, !home.isEmpty { return home }
        return model.jdks.first { UInt32(exactly: $0["version"].number ?? 0) == model.config?.java_version && $0["available"].bool != false }?["home"].string ?? ""
    }
    private var versionSelection: Binding<String> {
        Binding(get: {
            if let home = model.config?.java_home, model.jdks.contains(where: { $0["home"].string == home && $0["registered"].bool == true }) { return "home:" + home }
            return String(model.config?.java_version ?? 21)
        }, set: { value in
            if let jdk = model.jdks.first(where: { "home:" + ($0["home"].string ?? "") == value }) {
                model.config?.java_home = jdk["home"].string; model.config?.java_version = UInt32(exactly: jdk["version"].number ?? 21) ?? 21
            } else { model.config?.java_version = UInt32(value) ?? 21; model.config?.java_home = "" }
            model.dirty = true
        })
    }
    private var primaryFields: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            NativeRunFormField(localized("Target module", "目标模块"), id: "native-java-field-module") {
                Picker(localized("Target module", "目标模块"), selection: Binding(get: { model.config?.module ?? "." }, set: {
                    if model.config?.module != $0 { model.config?.main_class = ""; model.config?.jar = "" }
                    text(\.module).wrappedValue = $0
                })) {
                    ForEach(Array(model.modules.enumerated()), id: \.offset) { _, module in Text(module["name"].string ?? ".").tag(module["path"].string ?? ".") }
                }.labelsHidden().frame(height: 28)
            }
            NativeRunFormField(localized("Launch mode", "启动方式"), id: "native-java-field-mode") {
                Picker(localized("Launch mode", "启动方式"), selection: text(\.mode)) {
                    Text(localized("Development run", "开发启动")).tag("development"); Text(localized("JAR run", "JAR 启动")).tag("jar")
                }.labelsHidden().frame(height: 28)
            }
            NativeRunFormField(localized("JDK version", "JDK 版本"), id: "native-java-field-version") {
                Picker(localized("JDK version", "JDK 版本"), selection: versionSelection) {
                    ForEach([UInt32(8), 11, 17, 21], id: \.self) { version in
                        Text("Java \(version) · " + (model.jdks.contains { UInt32(exactly: $0["version"].number ?? 0) == version && $0["available"].bool != false } ? localized("Detected", "已检测到") : localized("Choose or install", "需选择或安装"))).tag(String(version))
                    }
                    ForEach(Array(model.jdks.filter { $0["registered"].bool == true }.enumerated()), id: \.offset) { _, jdk in
                        Text("Java \(Int(jdk["version"].number ?? 0)) · " + (jdk["home"].string ?? "")).tag("home:" + (jdk["home"].string ?? "")).disabled(jdk["available"].bool == false)
                    }
                }.labelsHidden().frame(height: 28)
                if !selectedJavaHome.isEmpty { Text(selectedJavaHome).font(.system(size: 11)).foregroundStyle(.secondary).textSelection(.enabled) }
            }
        }.padding(.top, 7)
    }
    private var mainClassField: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(model.config?.mode == "jar" ? localized("Existing JAR", "已有 JAR") : localized("Main class", "启动主类")).foregroundStyle(.secondary)
                Spacer()
                NativeRunAction(title: localized("Check again", "重新检测"), id: "native-java-redetect", palette: palette, height: 20) { Task { await model.detect() } }.fixedSize()
            }.font(.system(size: 11))
            if model.config?.mode == "jar" {
                HStack(spacing: 5) {
                    input(localized("Existing JAR (empty to package first)", "已有 JAR（留空先打包）"), \.jar, id: "jar")
                    NativeRunAction(title: localized("Choose JAR", "选择 JAR"), id: "native-java-choose-jar", palette: palette, icon: .folder, iconOnly: true) { model.choosePath("jar") }.fixedSize()
                }
            } else {
                input(localized("Main class (automatic when empty)", "启动主类（留空自动选择）"), \.main_class, id: "main-class", completions: mainClasses)
                if mainClasses.isEmpty { Text(localized("No main class detected. Enter one manually, or leave blank for the Maven plugin to find it.", "未检测到主类，可手动填写，或留空由 Maven 插件选择。")).foregroundStyle(.secondary).font(.system(size: 11)) }
            }
        }
    }
    private var mavenSummary: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(localized("Maven configuration", "Maven 配置")).font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button(localized("Settings", "设置")) { mavenPresented = true }.controlSize(.mini)
                        .popover(isPresented: $mavenPresented) { mavenPopover }
                }
                Picker(localized("Maven configuration", "Maven 配置"), selection: Binding(get: { model.config?.maven_scope ?? "global" }, set: { model.setScope($0) })) {
                    Text(localized("System-wide configuration", "系统全局配置")).tag("global"); Text(localized("Project configuration", "项目独立配置")).tag("project")
                }.labelsHidden().frame(height: 28)
            }
            NativeRunFormField(localized("Maven profile", "Maven Profile")) { input(localized("Maven profile", "Maven Profile"), \.maven_profiles, id: "maven-profiles") }
            NativeRunFormField(localized("Spring profile", "Spring Profile")) { input(localized("Spring profile", "Spring Profile"), \.spring_profiles, id: "spring-profiles") }
        }
    }
    private var mavenPopover: some View {
        VStack(alignment: .leading, spacing: 8) {
            mavenFields
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                NativeRunAction(title: localized("Save configuration", "保存配置"), id: "native-java-maven-save", palette: palette, height: 28) {
                    Task { if await model.save() { mavenPresented = false } }
                }.fixedSize()
            }
        }.padding(12).frame(width: 480).disabled(blocked)
    }
    private var advancedFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
                NativeRunFormField(localized("Full JDK home", "完整 JDK 主目录")) {
                    HStack(spacing: 5) {
                        input(localized("JDK home", "JDK 目录"), \.java_home, id: "jdk-home", completions: model.jdks.compactMap { $0["home"].string })
                        NativeRunAction(title: localized("Choose JDK", "选择 JDK"), id: "native-java-choose-jdk", palette: palette, icon: .folder, iconOnly: true) { model.choosePath("jdk") }.fixedSize()
                    }
                }
                NativeRunFormField(localized("JVM arguments", "JVM 参数")) {
                    NativeRunTextField(text: Binding(get: { model.vmArgumentInput }, set: { model.editArguments($0, vm: true) }), label: localized("JVM arguments", "JVM 参数"), id: "native-java-vm-arguments", palette: palette).frame(height: 28)
                }
                NativeRunFormField(localized("Application arguments", "应用参数")) {
                    NativeRunTextField(text: Binding(get: { model.argumentInput }, set: { model.editArguments($0) }), label: localized("Application arguments", "应用参数"), id: "native-java-arguments", palette: palette).frame(height: 28)
                }
                NativeRunFormField(localized("Environment variables", "环境变量")) {
                    NativeRunTextArea(text: Binding(get: { model.environmentInput }, set: { model.editEnvironment($0) }), label: localized("Environment variables", "环境变量"), id: "native-java-environment", palette: palette).frame(height: 40)
                    Text(localized("Only for this run; environment values are not saved.", "仅用于本次运行，不保存环境变量。")).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            HStack { Toggle(localized("Skip tests", "跳过测试"), isOn: flag(\.skip_tests)); Toggle(localized("Maven offline", "Maven 离线"), isOn: flag(\.offline)) }
            HStack {
                Spacer()
                NativeRunAction(title: localized("Save configuration", "保存配置"), id: "native-java-save-configuration", palette: palette, height: 28) { Task { _ = await model.save() } }.fixedSize()
            }
        }.padding(.top, 7)
    }
    private var configuration: some View {
        NativeRunDisclosure(localized("Run configuration", "运行配置"), id: "native-java-configuration-toggle", expanded: $configurationExpanded) {
            VStack(alignment: .leading, spacing: 8) {
                primaryFields; mainClassField; mavenSummary
                NativeRunDisclosure(localized("Advanced settings", "高级设置"), id: "native-java-advanced-toggle", expanded: $advancedExpanded) { advancedFields }
            }
        }.font(.system(size: 11))
    }
    private var taskToolbar: some View {
        NativeRunToolbarLayout() {
            NativeRunTaskState(running: model.running, busy: model.busy, selected: model.selectedTask, successLabel: true)
            Spacer(minLength: 0).layoutValue(key: NativeRunToolbarSpace.self, value: true)
            Menu {
                Button(localized("Reload saved configuration", "重新读取已保存的配置"), action: reload)
                Button(localized("Run again", "重新运行")) { Task { await model.runAgain() } }.disabled(model.tasks.isEmpty)
                Button(localized("Force stop", "强制停止")) { Task { await model.stop(force: true) } }.disabled(!model.running)
            } label: { Image(systemName: "ellipsis") }.fixedSize().help(localized("More actions", "更多操作"))
            Picker(localized("Maven build goal", "Maven 构建目标"), selection: $buildGoal) {
                Text(localized("Package", "打包 package")).tag("build"); Text(localized("Test", "测试 test")).tag("test"); Text(localized("Install", "安装 install")).tag("install")
            }.labelsHidden().frame(width: 82).disabled(model.running)
            NativeRunAction(title: localized("Build", "构建"), id: "native-java-build", palette: palette) {
                Task { guard !model.busy, !model.prepared else { return }; model.action = buildGoal; await model.run() }
            }.fixedSize().disabled(model.running || model.modules.isEmpty)
            NativeRunAction(title: model.running ? localized("Run again", "重新运行") : localized("Run", "运行"), id: "native-java-run", palette: palette) {
                Task { guard !model.busy, !model.prepared else { return }; model.action = "run"; if model.running { await model.runAgain() } else { await model.run() } }
            }.fixedSize().disabled(model.modules.isEmpty || selectedModule["packaging"].string == "pom")
            NativeRunAction(title: localized("Stop", "停止"), id: "native-java-stop", palette: palette) { Task { await model.stop(force: false) } }.fixedSize().disabled(!model.running)
        }.disabled(model.busy || model.prepared).padding(.horizontal, 12).padding(.vertical, 6)
            .overlay(alignment: .top) { border }.overlay(alignment: .bottom) { border }
    }
    private var border: some View { Color(nsColor: NativePreferences.color(palette["border"], fallback: .separatorColor)).frame(height: 1) }
    private var output: some View {
        Group {
            if let terminal = model.terminal {
                NativeRunLogToolbar(terminal: terminal, search: $model.search, summary: model.searchSummary, taskName: model.selectedTask["task"]["name"].string ?? "", find: { model.find(previous: $0) }, copy: { model.copyOutput() })
                JavaLogCanvas(terminal: terminal).id(terminal.attachment).frame(minHeight: model.workspaceDocked ? 0 : 160, maxHeight: .infinity)
                if !terminal.error.isEmpty { Text(terminal.error).foregroundStyle(.red).padding(8) }
            } else {
                Text(localized("Select a module and build or run. Output appears here.", "选择模块后构建或运行，输出将在此显示。"))
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(12)
            }
        }
    }
    var body: some View {
        GeometryReader { geometry in
            VStack(alignment: .leading, spacing: 0) {
                if !model.workspaceDocked { Text(model.directory).font(.system(size: 11)).textSelection(.enabled).padding(8) }
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
private struct JavaLogCanvas: NSViewRepresentable {
    let terminal: TerminalSession
    func makeNSView(context: Context) -> NSView { terminal.view }
    func updateNSView(_ view: NSView, context: Context) {}
}

@MainActor
final class JavaWindow: NSWindowController, NSWindowDelegate, NativeWorkspacePanelContent {
    let model: JavaRunModel
    private(set) var workspacePanelView: NSView?
    func workspaceEmbeddingChanged(_ embedded: Bool) { model.workspaceDocked = embedded }
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
        workspacePanelView = NSHostingView(rootView: JavaRunView(model: model, reload: { [weak self] in self?.reloadSaved() }))
        window.contentView = workspacePanelView
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
