import AppKit
import SwiftUI
import UTermBridge

@MainActor
final class NativeDatabaseComponentsModel: ObservableObject {
    let workspace: WorkspaceModel
    @Published private(set) var status: JSONValue = .null
    @Published private(set) var loading = false
    @Published private(set) var working = false
    @Published private(set) var connected = false
    @Published var frozen = false
    @Published private(set) var error = ""
    @Published private(set) var notice = ""
    @Published private(set) var progress: JSONValue = .null
    private(set) var receivedComponentEvents = 0
    private var service: DatabaseHost?
    private var observer: UUID?
    private var readEpoch = 0
    var blocked: Bool { working || loading || frozen || connected || status["busy"].bool == true }
    init(workspace: WorkspaceModel) { self.workspace = workspace }
    private func client() throws -> DatabaseHost {
        if let service { return service }
        let client = try workspace.sharedDatabaseHost(); service = client; return client
    }
    func startObserving() {
        guard observer == nil else { return }
        do {
            observer = try client().observe { [weak self] kind, value in
                guard let self else { return }
                if kind == "database-component-progress" { self.progress = value; self.receivedComponentEvents += 1 }
                if kind == "database-frozen" { self.frozen = value.bool == true }
                if kind == "database-components-changed" {
                    self.receivedComponentEvents += 1
                    Task { await self.refresh() }
                }
            }
        } catch { self.error = localized("Database components are unavailable. Reload to retry.", "数据库组件暂不可用，请重新读取后重试。") }
    }
    func stopObserving() {
        if let observer { service?.removeObserver(observer) }
        observer = nil
        readEpoch += 1; loading = false
    }
    func refresh(clearError: Bool = false) async {
        guard !loading, !frozen else { return }
        readEpoch += 1
        let epoch = readEpoch
        loading = true; defer { if epoch == readEpoch { loading = false } }
        if clearError { error = "" }
        do {
            let status = try await client().execute("database_components", params: ["action": .string("status")])
            guard let bridge = workspace.sshBridge else { throw BridgeFailure(code: "DB_CLOSED", message: "Database bridge is closed") }
            let connected = try await bridge.call("database.status")["connected"].bool == true
            guard epoch == readEpoch else { return }
            self.status = status; self.connected = connected
        } catch {
            if epoch == readEpoch { self.error = localized("Could not read database components. Reload to retry.", "无法读取数据库组件，请重新读取后重试。") }
        }
    }
    func perform(_ action: String, id: String? = nil) async {
        guard !frozen, ["install", "import", "remove", "java", "cancel"].contains(action) else { return }
        if action == "cancel" {
            guard working else { return }
            do { _ = try await client().execute("database_components", params: ["action": .string(action)]) }
            catch { self.error = localized("Could not cancel the component operation. Wait and retry.", "无法取消组件操作，请稍候重试。") }
            return
        }
        guard !blocked else { return }
        working = true; error = ""; notice = ""; progress = .null; defer { working = false }
        do {
            status = try await client().execute("database_components", params: ["action": .string(action), "id": id.map(JSONValue.string) ?? .null])
            notice = localized("Component operation finished.", "组件操作已完成。")
        } catch {
            let code = (error as? BridgeFailure)?.code ?? "DB_OPERATION_FAILED"
            if ["DOWNLOAD_CANCELLED", "DB_COMPONENT_CANCELLED"].contains(code) {
                notice = localized("Download cancelled. Saved progress can be resumed.", "下载已取消，可继续已保存的进度。")
            } else if code == "DB_BUSY" {
                self.error = localized("Disconnect databases before changing components.", "修改组件前请先断开数据库连接。")
            } else {
                self.error = localized("Could not change the component. Check the connection or selected package and retry.", "无法更改组件，请检查网络或所选安装包后重试。")
            }
            await refresh()
        }
    }
    func remove(_ id: String) {
        guard !blocked else { return }
        let alert = NSAlert()
        alert.messageText = localized("Uninstall component?", "卸载组件？")
        alert.informativeText = localized("Connection profiles are retained. Components cannot be removed while connected.", "保留连接配置，已连接时无法卸载组件。")
        alert.addButton(withTitle: localized("Uninstall", "卸载")); alert.addButton(withTitle: localized("Cancel", "取消"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task { await perform("remove", id: id) }
    }
    func manualDownload(_ text: String) {
        guard let url = URL(string: text), url.scheme == "https", url.host != nil, NSWorkspace.shared.open(url) else {
            error = localized("Could not open the component download page.", "无法打开组件下载页面。"); return
        }
    }
}

@MainActor
struct NativeDatabaseComponentsView: View {
    @ObservedObject var model: NativeDatabaseComponentsModel
    private func name(_ id: String) -> String {
        ["mysql": "MySQL", "postgresql": "PostgreSQL", "oracle": "Oracle", "mongodb": "MongoDB", "mongodb-core": "MongoDB Core", "mongodb-bson": "MongoDB BSON", "runtime": localized("Java runtime", "Java 运行时")][id] ?? id
    }
    private func size(_ bytes: Double) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text(localized("The connection engine is bundled. Use local Java 17 or newer and install database drivers as needed.", "连接引擎已内置，可使用本机 Java 17 或更新版本，按需安装数据库驱动。"))
                    Text(localized("Elasticsearch needs no extra driver. MongoDB requires Java and three driver components.", "Elasticsearch 无需额外驱动；MongoDB 需要 Java 与三个驱动组件。")).font(.caption)
                    Text(localized("Interrupted or cancelled downloads retain progress. Install again to resume when the source supports it.", "下载中断或取消后保留进度，下载源支持时再次安装可继续下载。")).font(.caption).foregroundStyle(.secondary)
                    if let java = model.status["java"].string { Text(localized("Java path: ", "Java 路径：") + java).font(.caption).textSelection(.enabled) }
                    if model.connected { Text(localized("Disconnect databases before changing components.", "修改组件前请先断开数据库连接。")).foregroundStyle(.secondary) }
                    ForEach(model.status["items"].array, id: \.selfID) { item in
                        let id = item["id"].string ?? ""
                        GroupBox {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(name(id)).font(.headline)
                                Text((item["version"].string ?? "") + " · " + size(item["size"].number ?? 0) + " · " + (item["external"].bool == true ? localized("Local Java ready", "本机 Java 已就绪") : item["installed"].bool == true ? localized("Installed", "已安装") : localized("Not installed", "未安装"))).font(.caption)
                                if item["external"].bool != true {
                                    Text(URL(string: item["source"].string ?? "")?.host ?? "").font(.caption).foregroundStyle(.secondary)
                                    if let downloaded = item["downloaded"].number, downloaded > 0 { Text(localized("Downloaded: ", "已下载：") + size(downloaded)).font(.caption) }
                                    HStack {
                                        Button(item["installed"].bool == true ? localized("Reinstall", "重新安装") : localized("Install / resume", "安装／继续下载")) { Task { await model.perform("install", id: id) } }.disabled(model.blocked)
                                        Button(localized("Offline install…", "离线安装…")) { Task { await model.perform("import", id: id) } }.disabled(model.blocked)
                                        Button(localized("Manual download", "手动下载")) { model.manualDownload(item["source"].string ?? "") }
                                        if item["installed"].bool == true { Button(localized("Uninstall…", "卸载…")) { model.remove(id) }.disabled(model.blocked) }
                                    }.controlSize(.small)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
                        }
                    }
                }
            }
            if model.loading { ProgressView().controlSize(.small) }
            if model.working {
                HStack {
                    if let received = model.progress["received"].number, let total = model.progress["total"].number, total > 0 {
                        ProgressView(value: received, total: total)
                        Text(size(received) + " / " + size(total)).font(.caption)
                    } else { ProgressView().controlSize(.small) }
                    Button(localized("Cancel download", "取消下载")) { Task { await model.perform("cancel") } }.disabled(model.frozen)
                }
            }
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled) }
            if !model.notice.isEmpty { Text(model.notice).textSelection(.enabled) }
            HStack {
                Button(localized("Choose local Java…", "选择本机 Java…")) { Task { await model.perform("java", id: "runtime") } }.disabled(model.blocked)
                Spacer()
                Button(localized("Refresh", "刷新")) { Task { await model.refresh(clearError: true) } }.disabled(model.loading || model.frozen)
            }
        }.padding().onAppear { model.startObserving() }.onDisappear { model.stopObserving() }.task { await model.refresh(clearError: true) }
    }
}

private extension JSONValue {
    var selfID: String { self["id"].string ?? "" }
}
