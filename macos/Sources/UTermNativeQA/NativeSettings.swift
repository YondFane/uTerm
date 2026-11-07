import AppKit
import SwiftUI
import UTermBridge

@MainActor
final class NativeSettingsModel: ObservableObject {
    let workspace: WorkspaceModel
    let login = NativeLoginItems()
    @Published private(set) var catalog: JSONValue = .null
    @Published private(set) var agents: JSONValue = .null
    @Published var values: [String: JSONValue] = [:]
    @Published var numbers: [String: String] = [:]
    @Published var shortcuts: [String: String] = [:]
    @Published private(set) var busy = false
    @Published var frozen = false
    @Published var error = ""
    @Published var notice = ""
    @Published var section = "general"
    private(set) var errorCode = ""
    private var baseline: [String: JSONValue] = [:]
    private var baselineNumbers: [String: String] = [:]
    private var baselineShortcuts: [String: String] = [:]
    private var bridge: CoreBridge? { workspace.sshBridge ?? workspace.bridge }
    var dirty: Bool { values != baseline || numbers != baselineNumbers || shortcuts != baselineShortcuts }
    var commands: [JSONValue] { catalog["commands"].array }
    var terminalThemes: [JSONValue] { catalog["themes"].array + (values["customThemes"]?.array ?? []) }
    var agentIDs: [String] { Array(Set(agents["builtins"].array.compactMap(\.string) + agents["definitions"].array.compactMap { $0["id"].string })).sorted() }
    init(workspace: WorkspaceModel) { self.workspace = workspace }
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
    func reload() async {
        guard !busy, !frozen, let bridge else { return }
        busy = true; error = ""; errorCode = ""; notice = ""; defer { busy = false }
        do {
            catalog = try await bridge.call("settings.catalog")
            agents = try await bridge.call("agent.catalog")
            let snapshot = try await bridge.snapshot()
            apply(snapshot.document.settings)
        } catch { self.error = localized("Could not read settings. Retry after checking saved data.", "无法读取设置，请检查保存数据后重试。") }
    }
    func resetDraft() {
        guard !busy, !frozen, catalog != .null else { return }
        values = object(catalog["defaults"])
        values["agentNotifications"] = .bool(false)
        numbers = numberStrings(values); shortcuts = [:]
        error = ""; notice = localized("Defaults are ready. Save to apply them.", "已载入默认值，保存后生效。")
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
        Task { await importThemeFile(url) }
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
    func save() async {
        guard !busy, !frozen, let bridge else { return }
        busy = true; error = ""; errorCode = ""; notice = ""; defer { busy = false }
        do {
            var draft = values
            for (key, text) in numbers {
                guard let value = Double(text), value.isFinite else { throw BridgeFailure(code: "INVALID_SETTINGS", message: "Invalid number") }
                draft[key] = .number(value)
            }
            draft["shortcuts"] = .object(shortcuts.mapValues(JSONValue.string))
            let patch = draft.filter { baseline[$0.key] != $0.value }
            if patch.isEmpty { apply(.object(draft)); return }
            let current = try await bridge.snapshot()
            var merged = object(current.document.settings)
            // Rebase unrelated changes, but never overwrite a field another client changed.
            // 可合并无关修改，但绝不覆盖另一客户端已改动的字段。
            for (key, value) in patch {
                guard merged[key] == baseline[key] else { throw BridgeFailure(code: "SETTINGS_CONFLICT", message: "Settings changed in another client") }
                merged[key] = value
            }
            _ = try await bridge.call("settings.validate", params: .object(["settings": .object(merged), "platform": .string("macos")]))
            let saved = try await bridge.call("settings.patch", params: .object(["expectedRevision": .string(current.revision), "patch": .object(patch)]))
            apply(saved["document"]["settings"])
            await workspace.reload()
            notice = localized("Settings saved.", "设置已保存。")
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
    private func text(_ key: String) -> Binding<String> { Binding(get: { model.values[key]?.string ?? "" }, set: { model.values[key] = .string($0) }) }
    private func flag(_ key: String) -> Binding<Bool> { Binding(get: { model.values[key]?.bool == true }, set: { model.values[key] = .bool($0) }) }
    private func number(_ key: String, _ en: String, _ zh: String) -> some View {
        TextField(localized(en, zh), text: Binding(get: { model.numbers[key] ?? "" }, set: { model.numbers[key] = $0 }))
    }
    private func choice(_ key: String, _ en: String, _ zh: String, _ entries: [(String, String, String)]) -> some View {
        Picker(localized(en, zh), selection: text(key)) {
            ForEach(entries, id: \.0) { value, english, chinese in Text(localized(english, chinese)).tag(value) }
        }
    }
    private var general: some View {
        Form {
            choice("language", "Language", "语言", [("system", "System default", "系统默认"), ("en", "English", "English"), ("zh-Hans", "简体中文", "简体中文")])
            choice("appearance", "Appearance", "外观", [("system", "System default", "系统默认"), ("dark", "Dark", "深色"), ("light", "Light", "浅色")])
            choice("projectOrder", "Project order", "项目排序", [("manual", "Manual", "手动"), ("name", "Name", "名称")])
            choice("defaultShell", "Default shell", "默认 Shell", [("default", "System default", "系统默认"), ("cmd", "Windows Command Prompt", "Windows 命令提示符")])
            if WorkspaceModel.applicationProfile.networkUpdatesAllowed {
                Toggle(localized("Automatically check for updates", "自动检查更新"), isOn: flag("automaticUpdates"))
            }
            NativeUpdateStatus(model: workspace.updates).id(NativeLocale.preference)
            NativeLoginItemsView(model: model.login).id(NativeLocale.preference)
            Toggle(localized("Break reminder", "休息提醒"), isOn: flag("breakReminder"))
            number("breakInterval", "Break interval (minutes)", "休息间隔（分钟）")
            Section(localized("Sidebar", "侧栏")) {
                Toggle(localized("Show SSH connections", "显示 SSH 连接"), isOn: flag("showSshConnections"))
                Toggle(localized("Show Redis connections", "显示 Redis 连接"), isOn: flag("showRedisConnections"))
                Toggle(localized("Show database connections", "显示数据库连接"), isOn: flag("showDatabaseConnections"))
            }
        }.formStyle(.grouped)
    }
    private var appearance: some View {
        Form {
            Picker(localized("Interface theme", "界面主题"), selection: text("interfaceTheme")) {
                ForEach(Array(model.catalog["interfaceThemes"].array.enumerated()), id: \.offset) { _, item in Text(model.title(item)).tag(item["id"].string ?? "") }
            }
            ForEach(["darkTheme", "lightTheme"], id: \.self) { key in
                Picker(key == "darkTheme" ? localized("Dark terminal theme", "深色终端主题") : localized("Light terminal theme", "浅色终端主题"), selection: text(key)) {
                    ForEach(Array(model.terminalThemes.enumerated()), id: \.offset) { _, item in Text(model.title(item)).tag(item["id"].string ?? "") }
                }
            }
            Button(localized("Import Ghostty theme…", "导入 Ghostty 主题…")) { model.chooseTheme() }
            TextField(localized("Interface font", "界面字体"), text: text("interfaceFont"))
            number("interfaceSize", "Interface font size", "界面字号")
            number("rowPadding", "Row padding", "行间留白")
            number("windowPadding", "Window padding", "窗口留白")
            number("opacity", "Background opacity (0.3–1)", "背景不透明度（0.3–1）")
            Toggle(localized("Blur background", "背景模糊"), isOn: flag("blur"))
            TextField(localized("Active icon color (hex, optional)", "活跃图标颜色（十六进制，可选）"), text: text("activeIconColor"))
        }.formStyle(.grouped)
    }
    private var terminal: some View {
        Form {
            TextField(localized("Terminal font family", "终端字体"), text: text("fontFamily"))
            number("fontSize", "Terminal font size", "终端字号")
            Toggle(localized("Thicken terminal text", "加粗终端文字"), isOn: flag("fontThicken"))
            number("lineHeight", "Line height (1–2)", "行高（1–2）")
            choice("cursorStyle", "Cursor", "光标", [("block", "Block", "方块"), ("bar", "Bar", "竖线"), ("underline", "Underline", "下划线")])
            Toggle(localized("Blink cursor", "光标闪烁"), isOn: flag("cursorBlink"))
            number("scrollback", "Scrollback lines", "回滚行数")
            Toggle(localized("Copy on selection", "选中即复制"), isOn: flag("copyOnSelect"))
        }.formStyle(.grouped)
    }
    private var files: some View {
        Form {
            number("fileFontSize", "File font size", "文件字号")
            number("gitDiffFontSize", "Diff font size", "差异字号")
            number("fileTabLimit", "Maximum file tabs", "文件标签上限")
            choice("inspectorPosition", "Inspector position", "检查器位置", [("left", "Left", "左侧"), ("right", "Right", "右侧")])
            choice("sidebarStyle", "Sidebar style", "侧栏样式", [("navigation", "Navigation", "导航")])
            Section(localized("Agents", "Agent")) {
                Picker(localized("Default Agent", "默认 Agent"), selection: text("defaultAgent")) {
                    ForEach(model.agentIDs, id: \.self) { id in Text(id).tag(id) }
                }
                Toggle(localized("Read remote usage", "读取远程用量"), isOn: flag("usageRemote"))
                number("usageRefreshInterval", "Usage refresh interval (seconds)", "用量刷新间隔（秒）")
                Button(localized("Agent commands, hooks and notifications…", "Agent 命令、Hooks 与通知…")) { workspace.openAgentsRequested?() }
            }
        }.formStyle(.grouped)
    }
    private var keyboard: some View {
        Form {
            Text(localized("Click a shortcut and press the new keys. Escape cancels.", "点击快捷键后按下新组合键，Escape 取消。"))
            ForEach(Array(model.commands.enumerated()), id: \.offset) { _, command in
                let id = command["id"].string ?? ""
                HStack {
                    Text(model.title(command)); Spacer()
                    NativeShortcutCapture(id: id, value: model.shortcuts[id] ?? model.defaultShortcut(id)) { model.shortcuts[id] = $0 }
                        .frame(width: 170, height: 26)
                    Button(localized("Clear", "清除")) { model.shortcuts[id] = "" }
                    Button(localized("Default", "默认")) { model.shortcuts[id] = nil }
                }
            }
        }.formStyle(.grouped)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.catalog == .null || model.values.isEmpty { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
            else { TabView(selection: $model.section) {
                general.tabItem { Text(localized("General", "通用")) }.tag("general")
                appearance.tabItem { Text(localized("Appearance", "外观")) }.tag("appearance")
                terminal.tabItem { Text(localized("Terminal", "终端")) }.tag("terminal")
                files.tabItem { Text(localized("Files and Agents", "文件与 Agent")) }.tag("files")
                keyboard.tabItem { Text(localized("Shortcuts", "快捷键")) }.tag("keyboard")
            }.disabled(model.busy || model.frozen || workspace.busy) }
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled).padding(.horizontal) }
            if !model.notice.isEmpty { Text(model.notice).textSelection(.enabled).padding(.horizontal) }
            HStack {
                Button(localized("Restore defaults…", "恢复默认值…")) { confirmReset = true }.disabled(model.busy || model.frozen)
                if model.busy { ProgressView().controlSize(.small) }
                Spacer()
                if model.dirty { Text(localized("Unsaved changes", "有未保存修改")).foregroundStyle(.secondary) }
                Button(localized("Reload", "重新读取")) { if model.dirty { confirmReload = true } else { Task { await model.reload() } } }.disabled(model.busy || model.frozen)
                Button(localized("Save settings", "保存设置")) { Task { await model.save() } }.disabled(!model.dirty || model.busy || model.frozen)
            }.padding()
        }.frame(minWidth: 640, minHeight: 480).task { await model.reload() }
        .confirmationDialog(localized("Replace this draft with default settings?", "用默认设置替换当前草稿？"), isPresented: $confirmReset) {
            Button(localized("Restore defaults", "恢复默认值")) { model.resetDraft() }
            Button(localized("Cancel", "取消"), role: .cancel) {}
        }
        .confirmationDialog(localized("Discard changes and read saved settings?", "放弃修改并读取已保存设置？"), isPresented: $confirmReload) {
            Button(localized("Reload", "重新读取")) { Task { await model.reload() } }
            Button(localized("Cancel", "取消"), role: .cancel) {}
        }
    }
}

@MainActor
private struct NativeUpdateStatus: View {
    @ObservedObject var model: NativeUpdates
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if WorkspaceModel.applicationProfile.networkUpdatesAllowed {
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
    init(workspace: WorkspaceModel) {
        model = NativeSettingsModel(workspace: workspace)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 620), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        super.init()
        window.title = localized("Settings", "设置"); window.isReleasedWhenClosed = false; window.delegate = self
        window.contentView = NSHostingView(rootView: NativeSettingsView(model: model, workspace: workspace)); window.center()
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func prepareForQuit() async -> Bool {
        guard !model.busy, !model.login.busy else { return false }
        model.frozen = true
        guard model.dirty else { return true }
        let alert = NSAlert(); alert.messageText = localized("Discard settings changes?", "放弃设置修改？")
        alert.addButton(withTitle: localized("Discard changes", "放弃修改")); alert.addButton(withTitle: localized("Cancel", "取消"))
        window.makeKeyAndOrderFront(nil)
        let response = await withCheckedContinuation { continuation in alert.beginSheetModal(for: window) { continuation.resume(returning: $0) } }
        if response != .alertFirstButtonReturn { model.frozen = false; return false }
        return true
    }
    func resumeAfterQuit() { model.frozen = false }
}
