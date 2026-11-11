import AppKit
import SwiftUI
import UTermBridge

@MainActor
final class NativeJavaComponentsModel: ObservableObject {
    @Published private(set) var catalog: JSONValue = .null
    @Published private(set) var jdks: [JSONValue] = []
    @Published private(set) var progress: JSONValue = .null
    @Published private(set) var loading = false
    @Published private(set) var working = false
    @Published private(set) var mutating = false
    @Published private(set) var cancelling = false
    @Published private(set) var error = ""
    @Published private(set) var notice = ""
    @Published var frozen = false
    @Published var adding = false
    @Published var home = ""
    private var client: CoreBridge?
    private var active: JSONValue = .null
    var pending: Bool { working || active != .null }
    var blocked: Bool { frozen || loading || pending || mutating || catalog["busy"].bool == true }
    private func componentClient() async throws -> CoreBridge {
        if let client { return client }
        let client = try await CoreBridge.open(root: WorkspaceModel.dataRoot())
        self.client = client
        return client
    }
    private func probe(_ method: String, params: JSONValue = .object([:])) async throws -> JSONValue {
        let worker = try await CoreBridge.open(root: WorkspaceModel.dataRoot())
        do {
            let value = try await worker.call(method, params: params)
            await worker.close()
            return value
        } catch { await worker.close(); throw error }
    }
    private func failure(_ reason: Error) {
        let code = (reason as? BridgeFailure)?.code ?? "JAVA_OPERATION_FAILED"
        if code.contains("CANCELLED") {
            notice = localized("Installation cancelled. Verified download progress is retained.", "安装已取消，已校验的下载进度保留。")
        } else if code == "JAVA_TASK_BUSY" {
            error = localized("Another Java component operation is active. Wait and reload.", "另一 Java 组件操作仍在运行，请等待后重新读取。")
        } else if code == "JAVA_JDK_REQUIRED" || code == "JAVA_COMPONENT_INVALID" {
            error = localized("Choose a complete JDK 8, 11, 17 or 21 with bin/java and bin/javac.", "请选择包含 bin/java 和 bin/javac 的完整 JDK 8、11、17 或 21。")
        } else if code == "DB_COMPONENT_HASH" {
            error = localized("The archive does not match the selected component. Download the matching archive and retry.", "安装包与所选组件不符，请下载对应安装包后重试。")
        } else {
            error = localized("The Java operation failed. Your path is retained; check the archive or network and retry.", "Java 操作失败。已保留填写的路径，请检查安装包或网络后重试。")
        }
    }
    private func finish(_ operation: JSONValue, client: CoreBridge) async throws {
        active = operation
        while true {
            let value = try await client.call("java.components.read", params: .object([
                "id": operation["id"], "generation": operation["generation"], "consume": .bool(false)
            ]))
            if value["state"].string != "running" {
                _ = try await client.call("java.components.read", params: .object([
                    "id": operation["id"], "generation": operation["generation"], "consume": .bool(true)
                ]))
                active = .null
                if let code = value["error"].string { throw BridgeFailure(code: code, message: code) }
                catalog = value["result"]
                return
            }
            progress = try await client.call("java.components.status")["progress"]
            try await Task.sleep(for: .milliseconds(100))
        }
    }
    func reload() async {
        guard !frozen, !loading, !working, !mutating else { return }
        loading = true; error = ""; notice = ""
        defer { loading = false; working = false }
        do {
            let client = try await componentClient()
            let value = try await client.call("java.components.status")
            catalog = value["catalog"]; progress = value["progress"]
            if value["operation"] != .null {
                working = true
                try await finish(value["operation"], client: client)
            } else { active = .null }
            jdks = try await probe("java.jdks.list").array
        } catch { failure(error) }
    }
    func perform(_ action: String, id: String, path: URL? = nil) async {
        guard !blocked, ["install", "import"].contains(action) else { return }
        working = true; error = ""; notice = ""; progress = .null
        defer { working = false }
        do {
            let client = try await componentClient()
            let operation = try await client.call("java.components.start", params: .object([
                "action": .string(action), "component": .string(id), "path": path.map { .string($0.path) } ?? .null
            ]))
            try await finish(operation, client: client)
            notice = localized("Java component installed.", "Java 组件已安装。")
            jdks = try await probe("java.jdks.list").array
        } catch { failure(error) }
    }
    func cancel() async {
        guard !frozen, !cancelling, active != .null, let client else { return }
        cancelling = true; defer { cancelling = false }
        do {
            _ = try await client.call("java.components.cancel", params: .object([
                "id": active["id"], "generation": active["generation"]
            ]))
        } catch { failure(error) }
    }
    func register(_ path: String, remove: Bool = false) async {
        guard !blocked else { return }
        mutating = true; error = ""; notice = ""
        defer { mutating = false }
        do {
            jdks = try await probe("java.jdks.register", params: .object(["home": .string(path), "remove": .bool(remove)])).array
            if !remove { adding = false; home = "" }
            notice = remove ? localized("JDK record removed. Its files are retained.", "已移除 JDK 记录，文件保留。") : localized("Local JDK added.", "已添加本机 JDK。")
        } catch { failure(error) }
    }
    func chooseHome() {
        guard !blocked else { return }
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true
        if !home.isEmpty { panel.directoryURL = URL(fileURLWithPath: home, isDirectory: true) }
        if panel.runModal() == .OK, let url = panel.url { home = url.path }
    }
    func importArchive(_ id: String) {
        guard !blocked else { return }
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url { Task { await perform("import", id: id, path: url) } }
    }
    func download(_ item: JSONValue) {
        guard let raw = item["source"].string, let url = URL(string: raw), url.scheme == "https", url.host != nil else { return }
        if !NSWorkspace.shared.open(url) { error = localized("Could not open the download link.", "无法打开下载链接。") }
    }
}

@MainActor
struct NativeJavaComponentsView: View {
    @ObservedObject var model: NativeJavaComponentsModel
    private func size(_ value: JSONValue) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(value.number ?? 0), countStyle: .file)
    }
    private func jdk(_ item: JSONValue) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("JDK " + String(Int(item["version"].number ?? 0))).font(.headline)
                Text(item["registered"].bool == true ? localized("Manually added", "手动添加") : localized("Automatically detected", "自动检测")).font(.caption)
                Text(item["home"].string ?? "").font(.caption).textSelection(.enabled)
                if item["available"].bool == false { Text(localized("Currently unavailable", "当前不可用")).foregroundStyle(.secondary) }
            }
            Spacer()
            if item["registered"].bool == true {
                Button(localized("Remove record", "移除记录")) { Task { await model.register(item["home"].string ?? "", remove: true) } }
                    .help(localized("Remove only this record; keep JDK files.", "仅移除记录，不删除 JDK 文件。")).disabled(model.blocked)
            }
        }.padding(.vertical, 6)
    }
    private func component(_ item: JSONValue) -> some View {
        let id = item["id"].string ?? ""
        let installed = item["installed"].bool == true
        return VStack(alignment: .leading, spacing: 6) {
            Text(id == "maven" ? localized("Managed Maven", "托管 Maven") : id.replacingOccurrences(of: "jdk-", with: "JDK ")).font(.headline)
            Text([item["version"].string ?? "", size(item["size"]), installed ? localized("Installed", "已安装") : localized("Not installed", "未安装")].joined(separator: " · ")).font(.caption)
            Text(URL(string: item["source"].string ?? "")?.host ?? "").font(.caption).foregroundStyle(.secondary)
            if (item["downloaded"].number ?? 0) > 0 { Text(localized("Downloaded: ", "已下载：") + size(item["downloaded"])).font(.caption) }
            HStack {
                Button(installed ? localized("Ready", "已就绪") : (item["downloaded"].number ?? 0) > 0 ? localized("Resume download", "继续下载") : localized("Install", "安装")) {
                    Task { await model.perform("install", id: id) }
                }.disabled(model.blocked || installed)
                Button(localized("Offline install", "离线安装")) { model.importArchive(id) }.disabled(model.blocked)
                Button(localized("Manual download", "手动下载")) { model.download(item) }.disabled(model.frozen)
            }.controlSize(.small)
            Divider()
        }
    }
    private var addJdk: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(localized("JDK home", "JDK 主目录"))
            HStack {
                TextField(localized("JDK home", "JDK 主目录"), text: $model.home)
                Button(localized("Choose…", "选择…")) { model.chooseHome() }
            }
            Text(localized("Choose a JDK 8, 11, 17 or 21 containing bin/java and bin/javac.", "选择包含 bin/java 和 bin/javac 的 JDK 8、11、17 或 21 目录。")).font(.caption)
            HStack {
                NativeJavaActionButton(title: localized("Add", "添加"), id: "native-java-register", enabled: !model.blocked && !model.home.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) { Task { await model.register(model.home.trimmingCharacters(in: .whitespacesAndNewlines)) } }.fixedSize().frame(height: 28)
                Button(localized("Cancel", "取消")) { model.adding = false }
            }
        }.disabled(model.blocked)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(localized("Prefer local JDKs; install only the versions you need. Maven builds require a full JDK, not a database JRE.", "优先使用本机 JDK，仅按需安装选择的版本。Maven 编译需要完整 JDK，数据库 JRE 不能代替。"))
                    Text(localized("Download sizes are shown before installation. Interrupted downloads can resume, and matching archives can be imported offline.", "安装前显示下载体积；下载中断可继续，也可手动下载后离线安装。")).font(.caption)
                    HStack {
                        NativeJavaActionButton(title: localized("Detect local JDKs", "检测本机 JDK"), id: "native-java-detect", enabled: !model.loading && !model.working && !model.mutating && !model.frozen) { Task { await model.reload() } }.fixedSize().frame(height: 28)
                        Button(localized("Manually add JDK", "手动添加 JDK")) { model.adding = true }.disabled(model.blocked)
                    }
                    if model.adding { addJdk }
                    Text(localized("Detected JDKs", "检测到的 JDK")).font(.headline)
                    if model.jdks.isEmpty && !model.loading { Text(localized("No local JDK detected. Choose a local path or install the required version.", "未检测到本机 JDK。可选择本机路径或安装所需版本。")).foregroundStyle(.secondary) }
                    ForEach(model.jdks, id: \.jdkIdentity) { item in jdk(item) }
                    Text(localized("Optional managed tools", "可选托管工具")).font(.headline)
                    ForEach(model.catalog["items"].array, id: \.componentIdentity) { item in component(item) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if model.loading || model.mutating { ProgressView().controlSize(.small) }
            if model.pending {
                HStack {
                    if let received = model.progress["received"].number, let total = model.progress["total"].number, total > 0 {
                        ProgressView(value: received, total: total)
                        Text(size(model.progress["received"]) + " / " + size(model.progress["total"])).font(.caption)
                    } else { ProgressView().controlSize(.small) }
                    Button(localized("Cancel installation", "取消安装")) { Task { await model.cancel() } }.disabled(model.cancelling || model.frozen)
                }
            }
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled) }
            if !model.notice.isEmpty { Text(model.notice).textSelection(.enabled) }
        }.padding().task { await model.reload() }
    }
}

private extension JSONValue {
    var jdkIdentity: String { self["home"].string ?? "" }
    var componentIdentity: String { self["id"].string ?? "" }
}

@MainActor
private struct NativeJavaActionButton: NSViewRepresentable {
    let title: String
    let id: String
    let enabled: Bool
    let action: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(action: action) }
    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(title: title, target: context.coordinator, action: #selector(Coordinator.activate))
        button.identifier = NSUserInterfaceItemIdentifier(id)
        button.bezelStyle = .rounded; button.controlSize = .small
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.action = action
        button.title = title; button.isEnabled = context.environment.isEnabled && enabled
    }
    @MainActor final class Coordinator: NSObject {
        var action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func activate() { action() }
    }
}
