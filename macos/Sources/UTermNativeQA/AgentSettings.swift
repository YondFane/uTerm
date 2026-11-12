import AppKit
import SwiftUI
import UTermBridge

@MainActor
final class AgentSettingsModel: ObservableObject {
    let workspace: WorkspaceModel
    @Published private(set) var catalog: JSONValue = .null
    @Published private(set) var busy = false
    @Published var frozen = false
    @Published var selected = "codex"
    @Published var identifier = ""
    @Published var name = ""
    @Published var program = ""
    @Published var argumentsText = "[]"
    @Published var notice = ""
    @Published var error = ""
    @Published var usage: JSONValue = .null
    @Published var visible = false
    private(set) var qaUsageReads = 0
    private(set) var qaUsageLastRemote = false
    var usageRefreshKey: String { [String(catalog != .null), selected, String(visible), String(frozen), String(workspace.settings["usageRemote"].bool ?? true), String(workspace.settings["usageRefreshInterval"].number ?? 60)].joined(separator: ":") }
    private var original = ""
    private var draftID = "codex"
    var definitions: [JSONValue] { catalog["definitions"].array }
    var identifiers: [String] { Array(Set(catalog["builtins"].array.compactMap(\.string) + definitions.compactMap { $0["id"].string })).sorted() }
    var dirty: Bool { [identifier, name, program, argumentsText].joined(separator: "\u{0}") != original }
    init(workspace: WorkspaceModel) { self.workspace = workspace; select("codex", force: true) }
    private var bridge: CoreBridge? { workspace.sshBridge ?? workspace.bridge }
    func select(_ id: String, force: Bool = false) {
        if dirty && !force && id != draftID {
            let alert = NSAlert()
            alert.messageText = localized("Discard Agent command changes?", "放弃 Agent 命令修改？")
            alert.addButton(withTitle: localized("Discard changes", "放弃修改"))
            alert.addButton(withTitle: localized("Cancel", "取消"))
            if alert.runModal() != .alertFirstButtonReturn { selected = draftID; return }
        }
        if !force && id == draftID && dirty { return }
        selected = id
        draftID = id
        let definition = definitions.first { $0["id"].string == id }
        identifier = id; name = definition?["name"].string ?? id
        program = definition?["program"].string ?? id
        let arguments = definition?["arguments"] ?? .array([])
        argumentsText = (try? String(data: JSONEncoder().encode(arguments), encoding: .utf8)) ?? "[]"
        original = [identifier, name, program, argumentsText].joined(separator: "\u{0}")
    }
    func newDefinition() { select("") }
    func setNotifications(_ enabled: Bool) async {
        guard !busy, !frozen else { return }
        busy = true; error = ""; defer { busy = false }
        do { try await workspace.agentNotifications.setEnabled(enabled) }
        catch { self.error = error.localizedDescription }
    }
    func reload() async {
        guard !busy, !frozen, let bridge else { return }
        busy = true; defer { busy = false }
        do { catalog = try await bridge.call("agent.catalog"); select(selected); error = "" }
        catch { self.error = localized("Could not read Agent settings. Retry after checking the configuration.", "无法读取 Agent 设置，请检查配置后重试。") }
    }
    func perform(_ method: String, params: [String: JSONValue]) async {
        guard !busy, !frozen, let bridge else { return }
        busy = true; error = ""; notice = ""; defer { busy = false }
        do {
            let value = try await bridge.call(method, params: .object(params))
            if method == "agent.usage" {
                qaUsageReads += 1; qaUsageLastRemote = params["remote"]?.bool == true
                if params["agent"]?.string == selected { usage = value }
            } else {
                catalog = try await bridge.call("agent.catalog")
                if method == "agent.definitions.save" { select(identifiers.contains(identifier) ? identifier : "codex", force: true) }
                await workspace.refreshAgentEnvironment()
                notice = localized("Agent settings updated.", "Agent 设置已更新。")
            }
        } catch {
            self.error = localized("Agent operation failed. Check the command path and configuration, then retry.", "Agent 操作失败，请检查程序路径和配置后重试。")
        }
    }
    func pollUsage() async {
        guard visible, !frozen, ["codex", "claude", "kimi", "grok"].contains(selected) else { return }
        while catalog == .null && visible && !frozen && !Task.isCancelled {
            if busy { try? await Task.sleep(for: .milliseconds(25)) }
            else { await reload(); if catalog == .null { return } }
        }
        guard catalog != .null else { return }
        while !Task.isCancelled && visible && !frozen {
            while busy && !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            }
            guard !Task.isCancelled, visible, !frozen else { return }
            await perform("agent.usage", params: ["agent": .string(selected), "remote": .bool(workspace.settings["usageRemote"].bool ?? true), "allowKeychain": .bool(false)])
            do { try await Task.sleep(for: .seconds(workspace.settings["usageRefreshInterval"].number ?? 60)) } catch { return }
        }
    }
    func save() async {
        do {
            let arguments = try JSONDecoder().decode(JSONValue.self, from: Data(argumentsText.utf8))
            guard case .array(let values) = arguments, values.allSatisfy({ $0.string != nil }) else {
                error = localized("Arguments must be a JSON array of strings.", "参数必须是 JSON 字符串数组。"); return
            }
            let definition: JSONValue = .object(["id": .string(identifier), "name": .string(name), "program": .string(program), "arguments": arguments])
            let others = definitions.filter { $0["id"].string != identifier }
            await perform("agent.definitions.save", params: ["definitions": .array(others + [definition])])
        } catch { self.error = localized("Arguments must be a JSON array of strings.", "参数必须是 JSON 字符串数组。") }
    }
    func remove() async {
        guard definitions.contains(where: { $0["id"].string == selected }) else { return }
        guard await workspace.mutate("settings.agent.toggle", ["agent": .string(selected), "enabled": .bool(false)]) else { error = workspace.error; return }
        await perform("agent.definitions.save", params: ["definitions": .array(definitions.filter { $0["id"].string != selected })])
    }
}

@MainActor
struct AgentSettingsView: View {
    @ObservedObject var model: AgentSettingsModel
    @ObservedObject var workspace: WorkspaceModel
    @State private var confirmInstall = false
    @State private var confirmQuota = false
    var body: some View {
        VStack(alignment: .leading) {
            Form {
                Picker("Agent", selection: $model.selected) {
                    if !model.identifiers.contains(model.selected) { Text(model.selected.isEmpty ? localized("New custom Agent", "新建自定义 Agent") : model.selected).tag(model.selected) }
                    ForEach(model.identifiers, id: \.self) { id in Text(id).tag(id) }
                }.onChange(of: model.selected) { _, value in model.select(value) }
                HStack {
                    Text(model.catalog["available"].array.contains(.string(model.selected)) ? localized("Available", "可用") : localized("CLI not found", "未找到 CLI"))
                    Spacer()
                    Button(localized("Install or update…", "安装或更新…")) { confirmInstall = true }
                        .disabled(!model.catalog["installable"].array.contains(.string(model.selected)))
                }
                Toggle(localized("Enable this Agent", "启用此 Agent"), isOn: Binding(
                    get: { workspace.settings["enabledAgents"].array.contains(.string(model.selected)) },
                    set: { enabled in Task { await workspace.mutate("settings.agent.toggle", ["agent": .string(model.selected), "enabled": .bool(enabled)]) } }))
                Section(localized("Activity hooks", "活动 Hooks")) {
                    Toggle(localized("Notify when tasks finish or need attention", "任务完成或需要处理时通知"), isOn: Binding(
                        get: { workspace.agentNotifications.enabled },
                        set: { enabled in Task { await model.setNotifications(enabled) } }))
                    #if DEBUG
                    Text(localized("Development builds do not send system notifications.", "开发构建不发送系统通知。")).font(.caption).foregroundStyle(.secondary)
                    #endif
                    HStack {
                        Button(localized("Install hooks", "安装 Hooks")) { Task { await model.perform("agent.hooks", params: ["agent": .string(model.selected), "enabled": .bool(true)]) } }
                        Button(localized("Remove hooks", "移除 Hooks")) { Task { await model.perform("agent.hooks", params: ["agent": .string(model.selected), "enabled": .bool(false)]) } }
                    }.disabled(!model.catalog["hooks"].array.contains(.string(model.selected)))
                    Text(localized("Existing configuration is backed up; other tools' hooks are retained.", "备份现有配置，并保留其他工具的 Hooks。"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section(localized("Command configuration", "命令配置")) {
                    TextField(localized("Identifier", "标识"), text: $model.identifier)
                    TextField(localized("Name", "名称"), text: $model.name)
                    TextField(localized("CLI executable", "CLI 程序"), text: $model.program)
                    TextField(localized("Arguments (JSON)", "参数（JSON）"), text: $model.argumentsText)
                    HStack {
                        Button(localized("New custom Agent", "新建自定义 Agent")) { model.newDefinition() }
                        Button(localized("Save command", "保存命令")) { Task { await model.save() } }
                        Button(localized("Remove custom command", "移除自定义命令")) { Task { await model.remove() } }
                            .disabled(!model.definitions.contains { $0["id"].string == model.selected })
                    }
                }
                Section(localized("Usage", "用量")) {
                    Button(localized("Read local usage", "读取本地用量")) { Task { await model.perform("agent.usage", params: ["agent": .string(model.selected), "remote": .bool(false), "allowKeychain": .bool(false)]) } }
                        .disabled(!["codex", "claude", "kimi", "grok"].contains(model.selected))
                    Button(localized("Read account quota…", "读取账户额度…")) { confirmQuota = true }
                        .disabled(!["codex", "claude", "kimi", "grok"].contains(model.selected))
                    if model.usage != .null {
                        Text(localized("Input / output tokens: ", "输入／输出 Token：") + String(format: "%.0f / %.0f", model.usage["input"].number ?? 0, model.usage["output"].number ?? 0))
                        Text(localized("Usage records: ", "用量记录：") + String(format: "%.0f", model.usage["records"].number ?? 0))
                        ForEach(Array(model.usage["windows"].array.enumerated()), id: \.offset) { _, value in
                            Text((value["label"].string ?? "") + String(format: " %.0f%%", value["percent"].number ?? 0))
                        }
                        if let notice = model.usage["notice"].string { Text(localized("Account quota is unavailable. Check the CLI sign-in and retry.", "账户额度暂不可用，请检查 CLI 登录状态后重试。")).help(notice) }
                    }
                }
            }.formStyle(.grouped).disabled(model.busy || model.frozen || workspace.busy)
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled).padding(.horizontal) }
            if !model.notice.isEmpty { Text(model.notice).textSelection(.enabled).padding(.horizontal) }
            HStack { if model.busy { ProgressView().controlSize(.small) }; Spacer(); Button(localized("Reload", "重新读取")) { Task { await model.reload() } }.disabled(model.busy || model.frozen) }.padding()
        }.frame(minWidth: 600, minHeight: 540).task { await model.reload() }
        .task(id: model.usageRefreshKey) { await model.pollUsage() }
        .confirmationDialog(localized("Install or update the provider's Agent CLI?", "安装或更新提供方的 Agent CLI？"), isPresented: $confirmInstall) {
            Button(localized("Install or update", "安装或更新")) { Task { await model.perform("agent.install", params: ["agent": .string(model.selected)]) } }
            Button(localized("Cancel", "取消"), role: .cancel) {}
        }
        .confirmationDialog(localized("Read quota using the CLI's saved sign-in? macOS may request Keychain access.", "使用 CLI 已保存的登录信息读取额度？macOS 可能请求钥匙串访问权限。"), isPresented: $confirmQuota) {
            Button(localized("Read account quota", "读取账户额度")) { Task { await model.perform("agent.usage", params: ["agent": .string(model.selected), "remote": .bool(true), "allowKeychain": .bool(true)]) } }
            Button(localized("Cancel", "取消"), role: .cancel) {}
        }
    }
}

@MainActor
final class AgentSettingsWindow: NSObject, NSWindowDelegate {
    let model: AgentSettingsModel
    let window: NSWindow
    init(workspace: WorkspaceModel) {
        model = AgentSettingsModel(workspace: workspace)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 620), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        super.init()
        window.title = localized("Agent settings", "Agent 设置")
        window.isReleasedWhenClosed = false; window.delegate = self
        window.contentView = NSHostingView(rootView: AgentSettingsView(model: model, workspace: workspace))
        window.center()
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { model.visible = false; sender.orderOut(nil); return false }
    func prepareForQuit() async -> Bool {
        guard !model.busy else { return false }
        model.frozen = true
        guard model.dirty else { return true }
        let alert = NSAlert()
        alert.messageText = localized("Discard Agent command changes?", "放弃 Agent 命令修改？")
        alert.addButton(withTitle: localized("Discard changes", "放弃修改"))
        alert.addButton(withTitle: localized("Cancel", "取消"))
        window.makeKeyAndOrderFront(nil)
        let reply = await withCheckedContinuation { continuation in
            alert.beginSheetModal(for: window) { continuation.resume(returning: $0) }
        }
        if reply != .alertFirstButtonReturn { model.frozen = false; return false }
        return true
    }
    func resumeAfterQuit() { model.frozen = false }
}
