import AppKit
import SwiftUI
import UTermBridge

@MainActor
final class NativeMavenSettingsModel: ObservableObject {
    @Published var values: [String: JSONValue] = [:]
    @Published private(set) var busy = false
    @Published var frozen = false
    @Published private(set) var error = ""
    @Published private(set) var notice = ""
    private(set) var errorCode = ""
    private var baseline: [String: JSONValue] = [:]
    private var revision = ""
    var dirty: Bool { values != baseline }
    private func call(_ method: String, params: JSONValue) async throws -> JSONValue {
        let worker = try await CoreBridge.open(root: WorkspaceModel.dataRoot())
        do {
            let response = try await worker.call(method, params: params)
            await worker.close()
            return response
        } catch { await worker.close(); throw error }
    }
    private func apply(_ response: JSONValue) throws {
        guard let revision = response["revision"].string, case .object(let global) = response["global"],
              ["distribution", "home", "settings", "repository", "wrapper"].allSatisfy({ global[$0] != nil }) else {
            throw BridgeFailure(code: "JAVA_CONFIG_INVALID", message: "Incomplete global Maven configuration")
        }
        self.revision = revision; values = global; baseline = global
    }
    func reload(discard: Bool = false) async {
        guard !busy, !frozen, values.isEmpty || !dirty || discard else { return }
        busy = true; error = ""; errorCode = ""; notice = ""; defer { busy = false }
        do { try apply(await call("java.configuration", params: .object(["directory": .null]))) }
        catch { self.error = localized("Could not read Maven settings. Your draft is retained; retry loading.", "无法读取 Maven 设置。草稿已保留，请重试读取。") }
    }
    func save() async {
        guard !busy, !frozen, !values.isEmpty, dirty else { return }
        busy = true; error = ""; errorCode = ""; notice = ""; defer { busy = false }
        do {
            try apply(await call("java.saveConfiguration", params: .object([
                "directory": .null, "revision": .string(revision), "global": .object(values), "project": .null
            ])))
            notice = localized("Maven settings saved.", "Maven 设置已保存。")
        } catch {
            errorCode = (error as? BridgeFailure)?.code ?? "JAVA_OPERATION_FAILED"
            self.error = errorCode == "JAVA_CONFIG_CONFLICT"
                ? localized("Maven settings changed in another window. Your draft is retained; reload before saving.", "另一窗口已修改 Maven 设置。草稿已保留，请重新读取后保存。")
                : localized("Could not save Maven settings. Your draft is retained; check the paths and retry.", "无法保存 Maven 设置。草稿已保留，请检查路径后重试。")
        }
    }
    func choose(_ key: String) {
        guard !busy, !frozen, ["home", "settings", "repository"].contains(key) else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = key != "settings"; panel.canChooseFiles = key == "settings"
        panel.allowsMultipleSelection = false
        if let path = values[key]?.string, !path.isEmpty { panel.directoryURL = URL(fileURLWithPath: path).deletingLastPathComponent() }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        values[key] = .string(url.path)
    }
}

@MainActor
struct NativeMavenSettingsView: View {
    @ObservedObject var model: NativeMavenSettingsModel
    @State private var confirmReload = false
    private func text(_ key: String) -> Binding<String> { Binding(get: { model.values[key]?.string ?? "" }, set: { model.values[key] = .string($0) }) }
    private func path(_ key: String, _ en: String, _ zh: String, _ hint: String, _ hintZH: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(localized(en, zh))
            HStack(spacing: 8) {
                TextField("", text: text(key), prompt: Text(localized(hint, hintZH)))
                    .textFieldStyle(.roundedBorder).frame(height: 32)
                    .accessibilityLabel(localized(en, zh))
                Button(localized("Choose", "选择")) { model.choose(key) }
            }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.values.isEmpty && model.busy { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
            else {
                NativeSettingsForm {
                    Text(localized("System-wide configuration", "系统全局配置"))
                        .frame(maxWidth: .infinity).padding(8)
                        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 4))
                    Text(localized("These settings apply to every project that inherits the system-wide configuration.", "所有继承全局配置的项目共用以下设置。")).font(.caption).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 8) {
                        Text(localized("Maven source", "Maven 来源"))
                        Picker(localized("Maven source", "Maven 来源"), selection: text("distribution")) {
                            Text(localized("Local Maven", "本机 Maven")).tag("local")
                            Text(localized("Managed Maven", "托管 Maven")).tag("managed")
                        }.labelsHidden().frame(maxWidth: .infinity)
                    }
                    path("home", "Maven home", "Maven 主目录", "Leave blank to detect local Maven", "留空自动检测本机 Maven").disabled(model.values["distribution"]?.string != "local")
                    path("settings", "User settings file · settings.xml", "用户设置文件 · settings.xml", "Leave blank to use Maven's default settings file", "留空使用 Maven 默认设置文件")
                    path("repository", "Maven local repository", "Maven 本地仓库", "Leave blank to use settings.xml or Maven's default", "留空使用 settings.xml 或 Maven 默认值")
                    Toggle(localized("Prefer project Wrapper", "优先项目 Wrapper"), isOn: Binding(get: { model.values["wrapper"]?.bool ?? true }, set: { model.values["wrapper"] = .bool($0) }))
                }.disabled(model.values.isEmpty || model.busy || model.frozen)
            }
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled).padding(.horizontal, 28) }
            if !model.notice.isEmpty { Text(model.notice).textSelection(.enabled).padding(.horizontal, 28) }
            HStack {
                if model.busy { ProgressView().controlSize(.small) }
                if model.dirty { Text(localized("Unsaved Maven settings", "有未保存的 Maven 设置")).foregroundStyle(.secondary) }
                Spacer()
                Button(localized("Reload Maven settings", "重新读取 Maven 设置")) { if model.dirty { confirmReload = true } else { Task { await model.reload() } } }
                NativeMavenSaveButton(model: model).frame(width: 150, height: 28)
            }.disabled(model.busy || model.frozen).padding(.horizontal, 28).padding(.bottom, 18)
        }.task { if model.values.isEmpty { await model.reload() } }
        .confirmationDialog(localized("Discard this Maven draft and read saved settings?", "放弃此 Maven 草稿并读取已保存设置？"), isPresented: $confirmReload) {
            Button(localized("Reload", "重新读取")) { Task { await model.reload(discard: true) } }
            Button(localized("Cancel", "取消"), role: .cancel) {}
        }
    }
}

@MainActor
private struct NativeMavenSaveButton: NSViewRepresentable {
    @ObservedObject var model: NativeMavenSettingsModel
    func makeCoordinator() -> Coordinator { Coordinator(model) }
    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(title: "", target: context.coordinator, action: #selector(Coordinator.save))
        button.identifier = NSUserInterfaceItemIdentifier("native-maven-settings-save")
        button.bezelStyle = .rounded; button.controlSize = .small
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) {
        button.title = localized("Save Maven settings", "保存 Maven 设置")
        button.isEnabled = context.environment.isEnabled && model.dirty && !model.busy && !model.frozen
    }
    @MainActor final class Coordinator: NSObject {
        let model: NativeMavenSettingsModel
        init(_ model: NativeMavenSettingsModel) { self.model = model }
        @objc func save() { Task { await model.save() } }
    }
}
