import AppKit
import Combine
import SwiftUI
import UTermBridge
import UniformTypeIdentifiers

@MainActor
final class NativeSettingsModel: ObservableObject {
    let workspace: WorkspaceModel
    let login = NativeLoginItems()
    let maven: NativeMavenSettingsModel
    let databaseComponents: NativeDatabaseComponentsModel
    let javaComponents: NativeJavaComponentsModel
    let agentSettings: AgentSettingsModel
    private var mavenChanges: AnyCancellable?
    private var databaseChanges: AnyCancellable?
    private var javaChanges: AnyCancellable?
    private var loginChanges: AnyCancellable?
    private var agentChanges: AnyCancellable?
    @Published private(set) var catalog: JSONValue = .null
    @Published private(set) var agents: JSONValue = .null
    @Published var values: [String: JSONValue] = [:]
    @Published var numbers: [String: String] = [:]
    @Published var shortcuts: [String: String] = [:]
    @Published private(set) var busy = false
    @Published private(set) var automaticSaving = false
    private var automaticKeys: Set<String> = []
    private var automaticTask: Task<Void, Never>?
    private var automaticFailures: [String: (String, String)] = [:]
    @Published var frozen = false
    @Published var error = ""
    @Published var notice = ""
    @Published var section = "general"
    @Published var query = ""
    @Published var presentationWidth: CGFloat = 760
    @Published var presentationVisible = false
    func syncAgentVisibility() { agentSettings.setInlineVisible("full-settings-usage", presentationVisible && section == "usage") }
    var presentationCardFrame = CGRect.zero
    func matchesSection(_ id: String, title: String) -> Bool {
        let section = catalog["sections"].array.first { $0["id"].string == id } ?? .null
        let value = [id, title, section["labels"]["en"].string ?? "", section["labels"]["zh-Hans"].string ?? "", section["keywords"].string ?? ""].joined(separator: " ").precomposedStringWithCompatibilityMapping.lowercased()
        return query.precomposedStringWithCompatibilityMapping.lowercased().split(whereSeparator: \.isWhitespace).allSatisfy { value.contains($0) }
    }
    private(set) var errorCode = ""
    private var baseline: [String: JSONValue] = [:]
    private var baselineNumbers: [String: String] = [:]
    private var baselineShortcuts: [String: String] = [:]
    func lastSavedValue(_ key: String) -> JSONValue { baseline[key] ?? .null }
    private var bridge: CoreBridge? { workspace.sshBridge ?? workspace.bridge }
    var dirty: Bool { values != baseline || numbers != baselineNumbers || shortcuts != baselineShortcuts }
    var commands: [JSONValue] { catalog["commands"].array }
    var terminalThemes: [JSONValue] { catalog["themes"].array + (values["customThemes"]?.array ?? []) }
    var agentIDs: [String] {
        let enabled = Set((values["enabledAgents"]?.array ?? []).compactMap(\.string))
        return agents["available"].array.compactMap(\.string).filter { enabled.contains($0) }
    }
    init(workspace: WorkspaceModel, agents: AgentSettingsModel? = nil) {
        self.workspace = workspace; maven = NativeMavenSettingsModel()
        agentSettings = agents ?? AgentSettingsModel(workspace: workspace)
        databaseComponents = NativeDatabaseComponentsModel(workspace: workspace)
        javaComponents = NativeJavaComponentsModel()
        mavenChanges = maven.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
        databaseChanges = databaseComponents.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
        javaChanges = javaComponents.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
        loginChanges = login.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
        agentChanges = agentSettings.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
    }
    private func object(_ value: JSONValue) -> [String: JSONValue] { if case .object(let entries) = value { return entries }; return [:] }
    private func numberStrings(_ entries: [String: JSONValue]) -> [String: String] {
        entries.compactMapValues { value in
            guard let value = value.number else { return nil }
            return value.rounded() == value ? String(format: "%.0f", value) : String(value)
        }
    }
    private func apply(_ value: JSONValue) {
        values = object(value)
        numbers = numberStrings(values)
        shortcuts = object(value["shortcuts"]).compactMapValues(\.string)
        baseline = values; baselineNumbers = numbers; baselineShortcuts = shortcuts
    }
    private func applySaved(_ value: JSONValue, keys: Set<String>?, submittedValues: [String: JSONValue], submittedNumbers: [String: String], submittedShortcuts: [String: String]) {
        let requested = keys ?? Set(submittedValues.keys)
        let oldBaseline = baseline, oldNumbers = baselineNumbers, oldShortcuts = baselineShortcuts
        var retainedKeys = Set(values.filter { !requested.contains($0.key) && baseline[$0.key] != $0.value }.keys)
        retainedKeys.formUnion(numbers.filter { !requested.contains($0.key) && baselineNumbers[$0.key] != $0.value }.keys)
        let keepShortcuts = shortcuts != (requested.contains("shortcuts") ? submittedShortcuts : baselineShortcuts)
        if !requested.contains("shortcuts"), keepShortcuts { retainedKeys.insert("shortcuts") }
        let retainedValues = values.filter { retainedKeys.contains($0.key) || (requested.contains($0.key) && submittedValues[$0.key] != $0.value) }
        let retainedNumbers = numbers.filter { retainedKeys.contains($0.key) || (requested.contains($0.key) && submittedNumbers[$0.key] != $0.value) }
        let draftShortcuts = shortcuts
        apply(value)
        // An unrelated save must retain the original comparison point of every uncommitted field.
        // 保存无关字段时，必须保留每个未提交字段最初的冲突比较基点。
        for key in retainedKeys { baseline[key] = oldBaseline[key]; baselineNumbers[key] = oldNumbers[key] }
        if retainedKeys.contains("shortcuts") { baselineShortcuts = oldShortcuts }
        values.merge(retainedValues) { _, draft in draft }; numbers.merge(retainedNumbers) { _, draft in draft }
        if keepShortcuts { shortcuts = draftShortcuts }
    }
    func saveAutomatically(_ keys: Set<String>) {
        automaticKeys.formUnion(keys)
        guard !frozen, !automaticKeys.isEmpty, automaticTask == nil else { return }
        automaticSaving = true
        automaticTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.automaticTask = nil; self.automaticSaving = false }
            while !self.automaticKeys.isEmpty && !Task.isCancelled {
                while self.busy { do { try await Task.sleep(for: .milliseconds(10)) } catch { return } }
                guard !self.frozen else { return }
                let requested = self.automaticKeys; self.automaticKeys.removeAll()
                if await self.save(keys: requested) {
                    for key in requested { self.automaticFailures[key] = nil }
                    if let previous = self.automaticFailures.values.first { self.errorCode = previous.0; self.error = previous.1 }
                } else {
                    for key in requested { self.automaticFailures[key] = (self.errorCode, self.error) }
                    self.automaticKeys.subtract(requested)
                }
            }
        }
    }
    func reload() async {
        guard !busy, !frozen, !automaticSaving, let bridge else { return }
        automaticKeys.removeAll(); automaticFailures.removeAll()
        busy = true; error = ""; errorCode = ""; notice = ""; defer { busy = false }
        do {
            catalog = try await bridge.call("settings.catalog")
            agents = try await bridge.call("agent.catalog")
            let snapshot = try await bridge.snapshot()
            apply(snapshot.document.settings)
        } catch { self.error = localized("Could not read settings. Retry after checking saved data.", "无法读取设置，请检查保存数据后重试。") }
    }
    func resetDraft() {
        guard !busy, !automaticSaving, !frozen, catalog != .null else { return }
        values = object(catalog["defaults"])
        values["agentNotifications"] = .bool(false)
        numbers = numberStrings(values); shortcuts = [:]
        error = ""; notice = localized("Defaults are ready. Save to apply them.", "已载入默认值，保存后生效。")
    }
    func chooseLegacyExport(over window: NSWindow) {
        guard !busy, !automaticSaving, !frozen else { return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = "uterm-legacy-export.json"; panel.allowedContentTypes = [.json]
        busy = true; error = ""; errorCode = ""; notice = ""
        panel.beginSheetModal(for: window) { [weak self] response in
            Task { @MainActor in
                guard let self else { return }
                defer { self.busy = false }
                if response == .OK, let destination = panel.url { _ = await self.writeLegacyExport(to: destination) }
            }
        }
    }
    func exportLegacy(to destination: URL) async -> Bool {
        guard !busy, !automaticSaving, !frozen else { return false }
        busy = true; error = ""; errorCode = ""; notice = ""; defer { busy = false }
        return await writeLegacyExport(to: destination)
    }
    private func writeLegacyExport(to destination: URL) async -> Bool {
        guard let bridge else { errorCode = "CLOSED"; error = localized("The settings client is closed. Reopen settings.", "设置客户端已关闭，请重新打开设置。"); return false }
        do {
            await workspace.flushWorkspaceOperations()
            let exported = try await bridge.call("legacy.export")
            try await Task.detached(priority: .utility) {
                let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                try encoder.encode(exported).write(to: destination, options: .atomic)
            }.value
            notice = localized("Legacy-compatible data exported.", "旧版兼容数据已导出。")
            return true
        } catch {
            errorCode = (error as? BridgeFailure)?.code ?? "LEGACY_EXPORT_FAILED"
            self.error = localized("Could not export compatibility data. Check saved data and the destination, then retry. Your draft is retained.", "无法导出兼容数据，请检查保存数据和目标后重试，草稿已保留。")
            return false
        }
    }
    func importTheme(source: String, name: String) async {
        guard !busy, !frozen, let bridge else { return }
        busy = true; error = ""; notice = ""; defer { busy = false }
        do {
            let theme = try await bridge.call("settings.theme.import", params: .object(["source": .string(source), "name": .string(name)]))
            values["customThemes"] = .array((values["customThemes"]?.array ?? []).filter { $0["id"] != theme["id"] } + [theme])
            values["darkTheme"] = theme["id"]
            notice = localized("Theme added to this draft. Save to apply it.", "主题已加入草稿，保存后生效。")
        } catch { self.error = localized("Could not import the theme. Use a UTF-8 Ghostty theme with valid six-digit colors.", "无法导入主题，请使用颜色为六位十六进制的 UTF-8 Ghostty 主题。") }
    }
    func chooseTheme() {
        guard !busy, !frozen else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await importThemeFile(url); if error.isEmpty { saveAutomatically(["customThemes", "darkTheme"]) } }
    }
    func importThemeFile(_ url: URL) async {
        guard !busy, !frozen else { return }
        do {
            let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
            let data = try handle.read(upToCount: 32001) ?? Data()
            guard data.count <= 32000, let source = String(data: data, encoding: .utf8) else { throw BridgeFailure(code: "THEME_INVALID", message: "Invalid theme file") }
            let name = ["conf", "txt"].contains(url.pathExtension.lowercased()) ? url.deletingPathExtension().lastPathComponent : url.lastPathComponent
            await importTheme(source: source, name: name)
        } catch { self.error = localized("Could not read the theme. Select a UTF-8 file up to 32 KB.", "无法读取主题，请选择不超过 32 KB 的 UTF-8 文件。") }
    }
    @discardableResult
    func save(keys: Set<String>? = nil) async -> Bool {
        guard !busy, !frozen else { return false }
        guard let bridge else { errorCode = "CLOSED"; error = localized("The settings client is closed. Reopen settings.", "设置客户端已关闭，请重新打开设置。"); return false }
        busy = true; error = ""; errorCode = ""; notice = ""; defer { busy = false }
        let submittedValues = values, submittedNumbers = numbers, submittedShortcuts = shortcuts
        do {
            var draft = values
            for (key, text) in numbers where keys == nil || keys!.contains(key) {
                guard let value = Double(text), value.isFinite else { throw BridgeFailure(code: "INVALID_SETTINGS", message: "Invalid number") }
                draft[key] = .number(value)
            }
            draft["shortcuts"] = .object(shortcuts.mapValues(JSONValue.string))
            let patch = draft.filter { (keys == nil || keys!.contains($0.key)) && baseline[$0.key] != $0.value }
            let current = try await bridge.snapshot()
            if patch.isEmpty {
                applySaved(current.document.settings, keys: keys, submittedValues: submittedValues, submittedNumbers: submittedNumbers, submittedShortcuts: submittedShortcuts)
                if keys == nil { automaticFailures.removeAll() }
                return true
            }
            var merged = object(current.document.settings)
            // Rebase unrelated changes, but never overwrite a field another client changed.
            // 可合并无关修改，但绝不覆盖另一客户端已改动的字段。
            for (key, value) in patch {
                guard merged[key] == baseline[key] else { throw BridgeFailure(code: "SETTINGS_CONFLICT", message: "Settings changed in another client") }
                merged[key] = value
            }
            _ = try await bridge.call("settings.validate", params: .object(["settings": .object(merged), "platform": .string("macos")]))
            let saved = try await bridge.call("settings.patch", params: .object(["expectedRevision": .string(current.revision), "patch": .object(patch)]))
            applySaved(saved["document"]["settings"], keys: keys, submittedValues: submittedValues, submittedNumbers: submittedNumbers, submittedShortcuts: submittedShortcuts)
            if keys == nil { automaticFailures.removeAll() }
            await workspace.reload()
            notice = localized("Settings saved.", "设置已保存。")
            return true
        } catch let failure as BridgeFailure {
            errorCode = failure.code
            switch failure.code {
            case "SHORTCUT_RESERVED": error = localized("This shortcut belongs to the system or editor. Choose another shortcut.", "此快捷键由系统或编辑器使用，请选择其他快捷键。")
            case "SHORTCUT_CONFLICT": error = localized("Two commands use the same shortcut. Resolve the duplicate before saving.", "两个命令使用相同快捷键，请解决重复后保存。")
            case "SETTINGS_CONFLICT", "CONFLICT": error = localized("Settings changed in another client. Your draft is retained; reload before retrying.", "另一客户端已修改设置。草稿已保留，请重新读取后重试。")
            case "WRITER_BUSY": error = localized("Saved data is busy. Your draft is retained; retry saving.", "保存数据正忙。草稿已保留，请重试保存。")
            default: error = localized("Settings are invalid or could not be saved. Check the values and retry.", "设置无效或无法保存，请检查填写值后重试。")
            }
        } catch { self.error = localized("Could not save settings. Your draft is retained.", "无法保存设置，草稿已保留。") }
        return false
    }
    func title(_ item: JSONValue) -> String { localized(item["labels"]["en"].string ?? item["name"].string ?? "", item["labels"]["zh-Hans"].string ?? item["name"].string ?? "") }
    func defaultShortcut(_ id: String) -> String { commands.first { $0["id"].string == id }?["defaultShortcut"].string ?? "" }
}

@MainActor
struct NativeSettingsView: View {
    @ObservedObject var model: NativeSettingsModel
    @ObservedObject var workspace: WorkspaceModel
    @State private var confirmReset = false
    @State private var confirmReload = false
    private func text(_ key: String) -> Binding<String> { Binding(get: { model.values[key]?.string ?? "" }, set: { model.values[key] = .string($0); model.saveAutomatically([key]) }) }
    private func flag(_ key: String) -> Binding<Bool> { Binding(get: { model.values[key]?.bool == true }, set: { model.values[key] = .bool($0); model.saveAutomatically([key]) }) }
    private func number(_ key: String, _ en: String, _ zh: String) -> some View {
        HStack {
            Text(localized(en, zh)); Spacer()
            NativeSettingsField(model: model, key: key, numeric: true, label: localized(en, zh)).frame(width: 140, height: 24)
        }
    }
    private func choice(_ key: String, _ en: String, _ zh: String, _ entries: [(String, String, String)]) -> some View {
        Picker(localized(en, zh), selection: text(key)) {
            ForEach(entries, id: \.0) { value, english, chinese in Text(localized(english, chinese)).tag(value) }
        }
    }
    private var general: some View {
        Form {
            choice("language", "Language", "语言", [("system", "System default", "系统默认"), ("en", "English", "English"), ("zh-Hans", "简体中文", "简体中文")])
            NativeLoginItemsView(model: model.login).id(NativeLocale.preference)
            number("fileTabLimit", "File tab limit", "文件标签数量上限")
            Toggle(localized("Break reminder", "休息提醒"), isOn: flag("breakReminder"))
            number("breakInterval", "Break interval (minutes)", "休息间隔（分钟）").disabled(model.values["breakReminder"]?.bool != true)
            NativeLegacyExportButton(model: model).frame(height: 28)
            Button(localized("Restore interface and terminal defaults…", "恢复界面与终端默认设置…")) { confirmReset = true }
                .disabled(model.busy || model.automaticSaving || model.frozen || model.maven.busy || model.databaseComponents.working || model.javaComponents.pending || model.javaComponents.mutating)
        }.formStyle(.grouped)
    }
    private var appearance: some View {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            NativeInterfaceThemes(model: model)
            Divider()
            NativeIconColor(model: model)
            choice("appearance", "Color mode", "颜色模式", [("system", "System default", "系统默认"), ("dark", "Dark", "深色"), ("light", "Light", "浅色")])
            ForEach(["darkTheme", "lightTheme"], id: \.self) { key in
                Picker(key == "darkTheme" ? localized("Dark terminal theme", "深色终端主题") : localized("Light terminal theme", "浅色终端主题"), selection: text(key)) {
                    ForEach(Array(model.terminalThemes.enumerated()), id: \.offset) { _, item in Text(model.title(item)).tag(item["id"].string ?? "") }
                }
            }
            Button(localized("Import Ghostty theme…", "导入 Ghostty 主题…")) { model.chooseTheme() }
            NativeFontPickerRow(model: model, key: "interfaceFont", title: localized("Interface font", "界面字体"))
            number("interfaceSize", "Interface font size", "界面字号")
            number("rowPadding", "Row padding", "行间留白")
            number("windowPadding", "Window padding", "窗口留白")
            number("opacity", "Background opacity (0.3–1)", "背景不透明度（0.3–1）")
            Toggle(localized("Blur background", "背景模糊"), isOn: flag("blur"))
            NativeFontPickerRow(model: model, key: "fontFamily", title: localized("Terminal font", "终端字体"))
            Toggle(localized("Thicken terminal text", "加粗字形"), isOn: flag("fontThicken"))
            number("fontSize", "Font size", "字号")
            number("lineHeight", "Line height (1–2)", "行高（1–2）")
            number("fileFontSize", "File font size", "文件字号")
            number("gitDiffFontSize", "Diff font size", "差异字号")
          }.padding(28)
        }
    }
    private var terminal: some View {
        Form {
            choice("cursorStyle", "Cursor", "光标", [("block", "Block", "方块"), ("bar", "Bar", "竖线"), ("underline", "Underline", "下划线")])
            Toggle(localized("Blink cursor", "光标闪烁"), isOn: flag("cursorBlink"))
            number("scrollback", "Scrollback lines", "回滚行数")
            Toggle(localized("Copy on selection", "选中即复制"), isOn: flag("copyOnSelect"))
        }.formStyle(.grouped)
    }
    private var workspaceSection: some View {
        Form {
            Section(localized("Manage workspaces", "管理工作区")) {
                ForEach(workspace.groupItems) { group in
                    Button { Task { await workspace.mutate("workspace.switch", ["id": .string(group.id)]) } } label: {
                        HStack { Text(group.name); Spacer(); if group.id == workspace.groupID { Image(systemName: "checkmark") } }
                    }.disabled(workspace.busy)
                }
                HStack {
                    Button(localized("New workspace…", "新建工作区…")) { workspace.newWorkspace(owner: .settings) }
                    Button(localized("Rename workspace…", "重命名工作区…")) { workspace.renameWorkspace(owner: .settings) }
                    Button(localized("Delete workspace…", "删除工作区…")) { workspace.removeWorkspace() }.disabled(!workspace.canRemoveWorkspace)
                }
                Text(localized("Only empty workspaces can be deleted. Keep at least one workspace.", "仅可删除空工作区，至少保留一个工作区。")).font(.caption).foregroundStyle(.secondary)
            }
            choice("projectOrder", "Project order", "项目排序", [("manual", "Manual", "手动"), ("name", "Name", "名称")])
            NativeDefaultAgentPicker(model: model)
            Section(localized("Sidebar", "侧栏")) {
                Toggle(localized("Show SSH connections", "显示 SSH 连接"), isOn: flag("showSshConnections"))
                Toggle(localized("Show Redis connections", "显示 Redis 连接"), isOn: flag("showRedisConnections"))
                Toggle(localized("Show database connections", "显示数据库连接"), isOn: flag("showDatabaseConnections"))
            }
            choice("inspectorPosition", "Inspector position", "检查器位置", [("left", "Left", "左侧"), ("right", "Right", "右侧")])
            choice("sidebarStyle", "Sidebar style", "侧栏样式", [("navigation", "Navigation", "导航")])
        }.formStyle(.grouped)
    }
    private var agents: some View {
        AgentSettingsView(model: model.agentSettings, workspace: workspace, scope: .commands)
    }
    private var usage: some View {
        VStack(alignment: .leading, spacing: 0) {
          VStack(alignment: .leading, spacing: 12) {
            Toggle(localized("Read remote usage", "读取远程用量"), isOn: flag("usageRemote"))
            number("usageRefreshInterval", "Usage refresh interval (seconds)", "用量刷新间隔（秒）")
          }.padding(.horizontal, 28).padding(.top, 16)
          AgentSettingsView(model: model.agentSettings, workspace: workspace, scope: .usage)
        }
    }
    private var control: some View {
        Form {
            LocalControlCheckbox(model: workspace)
            if let directory = workspace.controlStatus["directory"].string {
                Text(localized("CLI data directory: ", "CLI 数据目录：") + directory).font(.caption).textSelection(.enabled)
            }
            if !workspace.controlError.isEmpty {
                Text(workspace.controlError).foregroundStyle(.red)
                Button(localized("Retry control service", "重试控制服务")) { Task { await workspace.startControl() } }.disabled(workspace.controlBusy)
            }
        }.formStyle(.grouped)
    }
    private var updates: some View {
        Form {
            if workspace.updates.controlsVisible {
                Toggle(WorkspaceModel.applicationProfile.mode == .personal ? localized("Automatically check and download updates", "自动检查并下载更新") : localized("Automatically check for updates", "自动检查更新"), isOn: flag("automaticUpdates"))
            }
            NativeUpdateStatus(model: workspace.updates).id(NativeLocale.preference)
        }.formStyle(.grouped)
    }
    private var keyboard: some View {
        Form {
            Text(localized("Click a shortcut and press the new keys. Escape cancels.", "点击快捷键后按下新组合键，Escape 取消。"))
            ForEach(Array(model.commands.enumerated()), id: \.offset) { _, command in
                let id = command["id"].string ?? ""
                HStack {
                    Text(model.title(command)); Spacer()
                    NativeShortcutCapture(id: id, value: model.shortcuts[id] ?? model.defaultShortcut(id)) { model.shortcuts[id] = $0; model.saveAutomatically(["shortcuts"]) }
                        .frame(width: 170, height: 26)
                    Button(localized("Clear", "清除")) { model.shortcuts[id] = ""; model.saveAutomatically(["shortcuts"]) }
                    Button(localized("Default", "默认")) { model.shortcuts[id] = nil; model.saveAutomatically(["shortcuts"]) }
                }
            }
        }.formStyle(.grouped)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.catalog == .null || model.values.isEmpty { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
            else {
                HStack(spacing: 0) {
                    ScrollView(.vertical) {
                        VStack(alignment: .leading, spacing: 4) {
                            NativeSettingsSearch(model: model).frame(height: 40)
                            if !model.catalog["sections"].array.contains(where: { model.matchesSection($0["id"].string ?? "", title: model.title($0)) }) { Text(localized("No matching items.", "没有匹配的条目。")).font(.caption).foregroundStyle(.secondary) }
                            navigation("general", "gearshape", "General", "通用")
                            navigation("appearance", "paintpalette", "Appearance", "外观")
                            navigation("terminal", "terminal", "Terminal", "终端")
                            navigation("workspace", "rectangle.3.group", "Workspaces", "工作区")
                            navigation("keyboard", "keyboard", "Shortcuts", "快捷键")
                            navigation("agents", "sparkle", "Agents", "Agent")
                            navigation("usage", "chart.bar", "Usage", "用量")
                            navigation("control", "network", "Local control", "本地控制")
                            navigation("database", "externaldrive", "Database components", "数据库组件")
                            navigation("maven", "shippingbox", "Maven settings", "Maven 设置")
                            navigation("java", "cup.and.saucer", "Java development tools", "Java 开发环境")
                            navigation("updates", "arrow.down.circle", "Software updates", "软件更新")
                        }.frame(width: 133).padding(.horizontal, 8).padding(.vertical, 12)
                    }.scrollIndicators(.hidden).frame(width: 149).background(Color(nsColor: NativePreferences.color(NativePreferences.interfacePalette(workspace.settings, catalog: model.catalog)["sidebar"], fallback: .controlBackgroundColor))).disabled(model.databaseComponents.working || model.javaComponents.pending || model.javaComponents.mutating)
                    Divider()
                    VStack(alignment: .leading, spacing: 0) {
                        Text(model.title(model.catalog["sections"].array.first { $0["id"].string == model.section } ?? .null)).font(.system(size: 16, weight: .semibold)).padding(.horizontal, 28).padding(.top, 24)
                        selectedSection.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }.disabled(model.busy || model.automaticSaving || model.frozen || model.maven.busy || workspace.busy)
            }
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled).padding(.horizontal) }
            if !model.notice.isEmpty && model.dirty { Text(model.notice).textSelection(.enabled).padding(.horizontal) }
            if model.dirty || !model.error.isEmpty {
            HStack {
                if model.busy { ProgressView().controlSize(.small) }
                Spacer()
                if model.dirty { Text(localized("Unsaved changes", "有未保存修改")).foregroundStyle(.secondary) }
                Button(localized("Reload", "重新读取")) { if model.dirty { confirmReload = true } else { Task { await model.reload() } } }.disabled(model.busy || model.automaticSaving || model.frozen || model.maven.busy || model.databaseComponents.working || model.javaComponents.pending || model.javaComponents.mutating)
                Button(localized("Save settings", "保存设置")) { Task { await model.save() } }.disabled(!model.dirty || model.busy || model.automaticSaving || model.frozen || model.maven.busy || model.databaseComponents.working || model.javaComponents.pending || model.javaComponents.mutating)
            }.padding()
            }
        }.task { await model.reload() }
        .onChange(of: model.section, initial: true) { _, _ in model.syncAgentVisibility() }
        .onChange(of: model.presentationVisible) { _, _ in model.syncAgentVisibility() }
        .sheet(item: Binding(get: { workspace.nameDraftOwner == .settings ? workspace.nameDraft : nil }, set: { if workspace.nameDraftOwner == .settings { workspace.nameDraft = $0 } })) { _ in NameEditorView(model: workspace) }
        .confirmationDialog(localized("Replace this draft with default settings?", "用默认设置替换当前草稿？"), isPresented: $confirmReset) {
            Button(localized("Restore defaults", "恢复默认值")) { model.resetDraft(); model.saveAutomatically(Set(model.values.keys).union(["shortcuts"])) }
            Button(localized("Cancel", "取消"), role: .cancel) {}
        }
        .confirmationDialog(localized("Discard changes and read saved settings?", "放弃修改并读取已保存设置？"), isPresented: $confirmReload) {
            Button(localized("Reload", "重新读取")) { Task { await model.reload() } }
            Button(localized("Cancel", "取消"), role: .cancel) {}
        }
    }
    private func navigation(_ id: String, _ symbol: String, _ en: String, _ zh: String) -> some View {
        Group {
            if model.matchesSection(id, title: localized(en, zh)) {
                NativeSettingsNavigation(model: model, id: id, symbol: symbol, title: model.title(model.catalog["sections"].array.first { $0["id"].string == id } ?? .null)).frame(maxWidth: .infinity, minHeight: 32)
                    .accessibilityIdentifier("native-settings-section-" + id)
            }
        }
    }
    @ViewBuilder private var selectedSection: some View {
        switch model.section {
        case "appearance": appearance
        case "terminal": terminal
        case "workspace": workspaceSection
        case "files": appearance
        case "keyboard": keyboard
        case "agents": agents
        case "usage": usage
        case "control": control
        case "database": NativeDatabaseComponentsView(model: model.databaseComponents)
        case "maven": NativeMavenSettingsView(model: model.maven)
        case "java": NativeJavaComponentsView(model: model.javaComponents)
        case "updates": updates
        default: general
        }
    }
}

@MainActor
private struct NativeSettingsNavigation: NSViewRepresentable {
    @ObservedObject var model: NativeSettingsModel
    let id: String
    let symbol: String
    let title: String
    func makeCoordinator() -> Coordinator { Coordinator(model: model, id: id) }
    func makeNSView(context: Context) -> NavigationButton {
        let button = NavigationButton(title: title, target: context.coordinator, action: #selector(Coordinator.select))
        button.identifier = NSUserInterfaceItemIdentifier("native-settings-section-" + id)
        button.setAccessibilityIdentifier("native-settings-section-" + id)
        button.isBordered = false; button.alignment = .left; button.imagePosition = .noImage
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return button
    }
    func updateNSView(_ button: NavigationButton, context: Context) {
        button.title = title; button.isEnabled = context.environment.isEnabled
        button.font = .systemFont(ofSize: 13, weight: .medium)
        button.palette = NativePreferences.interfacePalette(model.workspace.settings, catalog: model.catalog)
        button.selected = model.section == id; button.needsDisplay = true
        button.setAccessibilityLabel(title)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NavigationButton, context: Context) -> CGSize? {
        let width = proposal.width ?? 133
        let text = (title as NSString).boundingRect(with: NSSize(width: max(1, width - 16), height: 200), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: nsView.font ?? .systemFont(ofSize: 13)])
        return CGSize(width: width, height: max(32, ceil(text.height) + 16))
    }
    @MainActor final class NavigationButton: NSButton {
        var palette: JSONValue = .null
        var selected = false
        override var isFlipped: Bool { true }
        override var acceptsFirstResponder: Bool { isEnabled }
        override func becomeFirstResponder() -> Bool { needsDisplay = true; return super.becomeFirstResponder() }
        override func resignFirstResponder() -> Bool { needsDisplay = true; return super.resignFirstResponder() }
        override func draw(_ dirtyRect: NSRect) {
            if selected || isHighlighted { NativePreferences.color(palette["hover"], fallback: .controlBackgroundColor).setFill(); NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill() }
            let style = NSMutableParagraphStyle(); style.lineBreakMode = .byWordWrapping
            let color = NativePreferences.color(palette["text"]).withAlphaComponent(isEnabled ? 1 : 0.45)
            (title as NSString).draw(in: bounds.insetBy(dx: 8, dy: 8), withAttributes: [.font: font ?? .systemFont(ofSize: 13), .foregroundColor: color, .paragraphStyle: style])
            if window?.firstResponder === self { NativePreferences.color(palette["accent"], fallback: .controlAccentColor).setStroke(); let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 4, yRadius: 4); ring.lineWidth = 2; ring.stroke() }
        }
    }
    @MainActor final class Coordinator: NSObject {
        let model: NativeSettingsModel
        let id: String
        init(model: NativeSettingsModel, id: String) { self.model = model; self.id = id }
        @objc func select() { model.section = id }
    }
}

@MainActor
private struct NativeUpdateStatus: View {
    @ObservedObject var model: NativeUpdates
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.controlsVisible {
                Button(localized("Check for updates…", "检查更新…")) { model.check() }.disabled(!model.available)
                if !model.available { Text(localized("Update checks are unavailable for this build.", "此构建暂不提供更新检查。")).font(.caption).foregroundStyle(.secondary) }
            } else {
                Text(localized("Install updates manually by replacing the app. Your personal profile stays on this Mac.", "请替换应用以手动更新；个人配置保留在此 Mac。")).font(.caption).foregroundStyle(.secondary)
            }
            if !model.status.isEmpty { Text(model.status).font(.caption) }
            if !model.error.isEmpty { Text(model.error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        }
    }
}

@MainActor
private struct NativeShortcutCapture: NSViewRepresentable {
    let id: String
    let value: String
    let changed: (String) -> Void
    func makeNSView(context: Context) -> CaptureButton {
        let button = CaptureButton(); button.identifier = NSUserInterfaceItemIdentifier("native-shortcut-" + id); return button
    }
    func updateNSView(_ view: CaptureButton, context: Context) { view.value = value; view.changed = changed; view.refresh() }
    final class CaptureButton: NSButton {
        var value = ""
        var changed: ((String) -> Void)?
        private var recording = false
        override var acceptsFirstResponder: Bool { true }
        init() { super.init(frame: .zero); bezelStyle = .rounded; target = self; action = #selector(beginCapture) }
        required init?(coder: NSCoder) { fatalError("Not supported") }
        func refresh() {
            if recording { title = localized("Press shortcut…", "按下快捷键…"); return }
            title = value.isEmpty ? localized("Unassigned", "未设置") : NativeCommandKey.label(value)
        }
        @objc private func beginCapture() { recording = true; window?.makeFirstResponder(self); refresh() }
        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            guard recording else { return super.performKeyEquivalent(with: event) }
            keyDown(with: event); return true
        }
        override func keyDown(with event: NSEvent) {
            guard recording else { super.keyDown(with: event); return }
            if event.keyCode == 53 { recording = false; refresh(); return }
            let codes: [UInt16: String] = [0:"KeyA",1:"KeyS",2:"KeyD",3:"KeyF",4:"KeyH",5:"KeyG",6:"KeyZ",7:"KeyX",8:"KeyC",9:"KeyV",11:"KeyB",12:"KeyQ",13:"KeyW",14:"KeyE",15:"KeyR",16:"KeyY",17:"KeyT",18:"Digit1",19:"Digit2",20:"Digit3",21:"Digit4",22:"Digit6",23:"Digit5",24:"Equal",25:"Digit9",26:"Digit7",27:"Minus",28:"Digit8",29:"Digit0",30:"BracketRight",31:"KeyO",32:"KeyU",33:"BracketLeft",34:"KeyI",35:"KeyP",36:"Enter",37:"KeyL",38:"KeyJ",40:"KeyK",42:"Backslash",43:"Comma",44:"Slash",45:"KeyN",46:"KeyM",47:"Period",123:"ArrowLeft",124:"ArrowRight",125:"ArrowDown",126:"ArrowUp"]
            guard event.modifierFlags.contains(.command), !event.modifierFlags.contains(.control), let code = codes[event.keyCode] else { NSSound.beep(); return }
            let result = "Mod+" + (event.modifierFlags.contains(.option) ? "Alt+" : "") + (event.modifierFlags.contains(.shift) ? "Shift+" : "") + code
            recording = false; value = result; changed?(result); refresh()
        }
        override func resignFirstResponder() -> Bool { recording = false; refresh(); return super.resignFirstResponder() }
    }
}

@MainActor
final class NativeSettingsWindow: NSObject, NSWindowDelegate {
    let model: NativeSettingsModel
    let window: NSWindow
    private weak var previousResponder: NSView?
    init(workspace: WorkspaceModel, agents: AgentSettingsModel? = nil) {
        model = NativeSettingsModel(workspace: workspace, agents: agents)
        window = NativeSettingsOverlayWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 620), styleMask: [.borderless, .resizable], backing: .buffered, defer: false)
        super.init()
        window.identifier = NSUserInterfaceItemIdentifier("native-full-settings")
        window.title = localized("Settings", "设置"); window.isReleasedWhenClosed = false; window.delegate = self
        window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = false
        window.collectionBehavior.insert(.fullScreenAuxiliary)
        (window as? NativeSettingsOverlayWindow)?.closeRequested = { [weak self] in if let self { _ = self.windowShouldClose(self.window) } }
        window.contentView = NSHostingView(rootView: NativeSettingsOverlay(model: model, workspace: workspace, close: { [weak self] in self?.window.performClose(nil) })); window.center()
    }
    func present(over parent: NSWindow) {
        model.presentationVisible = true; model.syncAgentVisibility()
        if !window.isVisible { previousResponder = parent.firstResponder as? NSView }
        parent.orderFront(nil)
        if window.parent !== parent { window.parent?.removeChildWindow(window); parent.addChildWindow(window, ordered: .above) }
        window.setFrame(parent.frame, display: true); window.makeKeyAndOrderFront(nil)
    }
    func alignToParent() {
        if window.isVisible, let parent = window.parent { window.setFrame(parent.frame, display: true) }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !model.busy, !model.automaticSaving, !model.agentSettings.busy, !model.login.busy, !model.maven.busy, !model.databaseComponents.working, !model.javaComponents.pending, !model.javaComponents.mutating, !model.frozen else { return false }
        model.presentationVisible = false; model.syncAgentVisibility()
        let parent = sender.parent; parent?.removeChildWindow(sender); sender.orderOut(nil)
        model.workspace.settingsPresented = false
        parent?.makeKeyAndOrderFront(nil)
        if let previousResponder, previousResponder.window === parent { parent?.makeFirstResponder(previousResponder) }
        return false
    }
    func prepareForQuit() async -> Bool {
        guard !model.busy, !model.automaticSaving, !model.login.busy, !model.maven.busy, !model.databaseComponents.working, !model.javaComponents.pending, !model.javaComponents.mutating else { return false }
        model.frozen = true; model.maven.frozen = true; model.databaseComponents.frozen = true; model.javaComponents.frozen = true
        guard model.dirty || model.maven.dirty else { return true }
        let alert = NSAlert(); alert.messageText = localized("Discard settings changes?", "放弃设置修改？")
        alert.addButton(withTitle: localized("Discard changes", "放弃修改")); alert.addButton(withTitle: localized("Cancel", "取消"))
        window.makeKeyAndOrderFront(nil)
        let response = await withCheckedContinuation { continuation in alert.beginSheetModal(for: window) { continuation.resume(returning: $0) } }
        if response != .alertFirstButtonReturn { resumeAfterQuit(); return false }
        return true
    }
    func resumeAfterQuit() { model.frozen = false; model.saveAutomatically([]); model.maven.frozen = false; model.databaseComponents.frozen = false; model.javaComponents.frozen = false }
}
