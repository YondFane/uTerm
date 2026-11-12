import AppKit
import ServiceManagement
import SwiftUI

@MainActor
final class NativeLoginItems: ObservableObject {
    @Published private(set) var enabled = false
    @Published private(set) var requiresApproval = false
    @Published private(set) var busy = false
    @Published private(set) var error = ""
    let simulated: Bool
    var qaFailNextRequest = false
    var qaRequireApproval = false
    init() {
        simulated = Bundle.main.bundleIdentifier == "sh.uterm.desktop.qa.native" && WorkspaceModel.argument("--settings-smoke-report") != nil && (try? WorkspaceModel.dataRoot()) != nil
        refresh()
    }
    func refresh() {
        guard !simulated else { return }
        enabled = SMAppService.mainApp.status == .enabled
        requiresApproval = SMAppService.mainApp.status == .requiresApproval
    }
    func setEnabled(_ value: Bool) async {
        guard !busy else { return }
        busy = true; error = ""; defer { busy = false }
        do {
            if simulated {
                if qaFailNextRequest { qaFailNextRequest = false; throw NSError(domain: "LoginItemQA", code: 1) }
                requiresApproval = value && qaRequireApproval; qaRequireApproval = false
                enabled = value && !requiresApproval
            } else {
                try await Task.detached {
                    if value { try SMAppService.mainApp.register() }
                    else { try await SMAppService.mainApp.unregister() }
                }.value
                refresh()
            }
        } catch {
            refresh()
            self.error = localized("Could not change login startup. Check Login Items in System Settings and retry.", "无法修改开机启动，请检查系统设置中的登录项后重试。")
        }
    }
    func openSystemSettings() { if !simulated { SMAppService.openSystemSettingsLoginItems() } }
}

@MainActor
struct NativeLoginItemsView: View {
    @ObservedObject var model: NativeLoginItems
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle(localized("Open at login", "登录时打开"), isOn: Binding(get: { model.enabled }, set: { value in Task { await model.setEnabled(value) } })).disabled(model.busy)
            Text(localized("This system preference applies immediately and is separate from the settings draft.", "此系统偏好立即生效，独立于设置草稿。")).foregroundStyle(.secondary)
            if model.busy { ProgressView().controlSize(.small) }
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled) }
            if model.requiresApproval { Text(localized("Allow this app in System Settings → General → Login Items, then refresh.", "请在系统设置 → 通用 → 登录项中允许此应用，然后刷新。")) }
            HStack {
                Button(localized("Open Login Items…", "打开登录项…")) { model.openSystemSettings() }
                Button(localized("Refresh status", "刷新状态")) { model.refresh() }
            }.disabled(model.busy)
        }
    }
}
