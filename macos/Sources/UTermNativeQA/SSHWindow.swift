import AppKit
import SwiftUI
import UTermBridge

@MainActor
final class SSHModel: ObservableObject {
    let bridge: CoreBridge
    let workspaceID: String
    weak var workspace: WorkspaceModel?
    @Published var snapshot: CoreSnapshot?
    @Published var selectedID = ""
    @Published var connectionID = UUID().uuidString
    @Published var name = ""
    @Published var host = ""
    @Published var mode = "direct"
    @Published var port = "22"
    @Published var username = ""
    @Published var authentication = "config"
    @Published var identity = ""
    @Published var jump = ""
    @Published var remoteOS = "posix"
    @Published var rootPath = ""
    @Published var password = ""
    @Published var remember = false
    @Published var error = ""
    @Published var feedback = ""
    @Published var resolution = ""
    @Published var busy = false
    @Published var prepared = false
    @Published var folder = ""
    @Published var hidden = false
    @Published var listing: [JSONValue] = []
    @Published var selection: String?
    @Published var remoteRoot: JSONValue = .null
    @Published var operations: [CoreSshOperation] = []
    @Published var tunnels: [JSONValue] = []
    @Published var active: CoreSshOperation?
    @Published var lastTransfer: CoreSshOperation?
    var transferProgress: CoreSshOperation? { active?.kind == "files.transfer" ? active : lastTransfer }
    @Published var localPort = ""
    @Published var remoteHost = "127.0.0.1"
    @Published var remotePort = ""
    @Published var preview = ""
    @Published var previewPresented = false
    private var credential: String?
    private var baseline = ""
    private var roots: [String: JSONValue] = [:]
    private var polling: Task<Void, Never>?
    private var closed = false
    weak var ownerWindow: NSWindow?
    var dirty: Bool { fingerprint != baseline }
    var snapshotWorkspaceName: String { snapshot?.document.workspace["groups"].array.first { $0["id"].string == workspaceID }?["name"].string ?? workspaceID }
    var connected: Bool { remoteRoot != .null }
    var connections: [JSONValue] {
        snapshot?.document.workspace["groups"].array.first { $0["id"].string == workspaceID }?["sshConnections"].array ?? []
    }
    var profile: JSONValue { connections.first { $0["id"].string == selectedID } ?? .null }
    var forwards: [JSONValue] { profile["forwards"].array }
    var fingerprint: String { [connectionID, name, host, mode, port, username, authentication, identity, jump, remoteOS, rootPath, password, String(remember)].joined(separator: "\u{0}") }
    init(workspace: WorkspaceModel, bridge: CoreBridge) { self.workspace = workspace; self.workspaceID = workspace.groupID; self.bridge = bridge; baseline = fingerprint }
    func start(selected: String? = nil) async {
        await reload(select: selected)
        polling = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self, !self.closed else { return }
                do {
                    self.tunnels = try await self.bridge.call("ssh.tunnel.list").array
                    self.operations = try await self.decodeOperations()
                } catch { self.error = error.localizedDescription }
                do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            }
        }
    }
    func reload(select: String? = nil) async {
        do {
            snapshot = try await bridge.snapshot()
            let id = select ?? (selectedID.isEmpty ? connections.first?["id"].string : selectedID)
            if let id, connections.contains(where: { $0["id"].string == id }) { apply(id) }
            else { newDraft() }
        } catch { self.error = error.localizedDescription }
    }
    func newDraft() {
        lastTransfer = nil
        selectedID = ""; connectionID = UUID().uuidString; name = ""; host = ""; mode = "direct"; port = "22"; username = ""; authentication = "config"; identity = ""; jump = ""; remoteOS = "posix"; rootPath = ""; password = ""; remember = false; credential = nil; folder = ""; listing = []; selection = nil; remoteRoot = .null; baseline = fingerprint
    }
    func apply(_ id: String) {
        guard let value = connections.first(where: { $0["id"].string == id }) else { return }
        if selectedID != id { lastTransfer = nil }
        selectedID = id; connectionID = id; name = value["name"].string ?? ""; host = value["host"].string ?? ""; mode = value["mode"].string ?? "alias"; port = value["port"].number.map { String(Int($0)) } ?? ""; username = value["username"].string ?? ""; authentication = value["authentication"].string ?? "config"; identity = value["identity_file"].string ?? ""; jump = value["jump_host"].string ?? ""; remoteOS = value["os"].string ?? "posix"; rootPath = value["root"].string ?? ""; password = ""; remember = value["remember_password"].bool ?? false; credential = value["credential_id"].string; folder = ""; listing = []; selection = nil; remoteRoot = roots[id] ?? .null; baseline = fingerprint
    }
    func select(_ id: String?) async {
        guard !busy, !prepared, id != selectedID, await confirmDraft() else { return }
        if let id { apply(id); if connected { await list() } } else { newDraft() }
    }
    func target() throws -> JSONValue {
        var value: [String: JSONValue] = ["connection_id": .string(connectionID), "workspace_id": .string(workspaceID), "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? host : name), "host": .string(host), "mode": .string(mode), "os": .string(remoteOS), "root": .string(rootPath), "authentication": .string(authentication)]
        if !port.isEmpty {
            guard let number = UInt16(port), number > 0 else { throw BridgeFailure(code: "SSH_INVALID_CONNECTION", message: localized("Enter a port from 1 to 65535.", "端口应为 1 至 65535。")) }
            value["port"] = .number(Double(number))
        } else if mode == "direct" { value["port"] = .number(22) }
        if !username.isEmpty { value["username"] = .string(username) }
        if !identity.isEmpty { value["identity_file"] = .string(identity) }
        if !jump.isEmpty { value["jump_host"] = .string(jump) }
        if authentication == "password" {
            value["remember_password"] = .bool(remember)
            if let credential { value["credential_id"] = .string(credential) }
        }
        return .object(value)
    }
    private func decodeOperations() async throws -> [CoreSshOperation] {
        try JSONDecoder().decode([CoreSshOperation].self, from: JSONEncoder().encode(try await bridge.call("ssh.operations")))
    }
    func perform(_ values: [String: JSONValue]) async throws -> JSONValue {
        let created = try await bridge.call("ssh.operation.start", params: .object(values))
        let id = created["id"].string ?? ""
        let generation = created["generation"].string ?? ""
        while !closed {
            let response = try await bridge.call("ssh.operation.read", params: .object(["id": .string(id), "generation": .string(generation), "consume": .bool(true)]))
            let operation = try JSONDecoder().decode(CoreSshOperation.self, from: JSONEncoder().encode(response))
            guard operation.generation == generation else { throw BridgeFailure(code: "SSH_OPERATION_CHANGED", message: "SSH operation changed") }
            active = operation
            if operation.kind == "files.transfer" { lastTransfer = operation }
            if operation.state == "completed" { return operation.result ?? .null }
            if operation.state == "cancelled" { throw BridgeFailure(code: "SSH_TRANSFER_CANCELLED", message: localized("Transfer cancelled. The original destination is retained.", "传输已取消，原目标保持不变。")) }
            if operation.state != "running" { throw BridgeFailure(code: "SSH_OPERATION_FAILED", message: operation.error ?? operation.state) }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw BridgeFailure(code: "CLOSED", message: "SSH window closed")
    }
    func save() async -> Bool {
        guard !busy, !prepared, let snapshot else { return false }
        busy = true; error = ""; feedback = ""
        defer { busy = false; active = nil }
        let old = credential
        var created: String?
        do {
            var connection = try target()
            if authentication == "password" {
                var previous = connection
                if case .object(var object) = previous { object["remember_password"] = .bool(profile["remember_password"].bool ?? false); previous = .object(object) }
                created = try await perform(["kind": .string("auth.configure"), "connection": previous, "password": password.isEmpty ? .null : .string(password), "remember": .bool(remember)]).string
                if case .object(var object) = connection { object["credential_id"] = created.map(JSONValue.string) ?? .null; connection = .object(object) }
            }
            _ = try await bridge.call("ssh.profile.save", params: .object(["expectedRevision": .string(snapshot.revision), "connection": connection]))
            let saved = connectionID
            if let old, old != created {
                do { _ = try await perform(["kind": .string("auth.forget"), "reference": .string(old), "remember": .bool(profile["remember_password"].bool ?? false)]) }
                catch { self.error = localized("Saved, but old credential cleanup failed: ", "已保存，但旧凭据清理失败：") + error.localizedDescription }
            }
            await reload(select: saved); await workspace?.reload()
            feedback = localized("Connection saved.", "连接已保存。")
            return true
        } catch {
            if let created, created != old {
                do { _ = try await perform(["kind": .string("auth.forget"), "reference": .string(created), "remember": .bool(remember)]) }
                catch { self.error = localized("Credential cleanup failed: ", "凭据清理失败：") + error.localizedDescription }
            }
            self.error = error.localizedDescription + (self.error.isEmpty ? "" : "\n" + self.error)
            return false
        }
    }
    func resolve() async {
        await execute {
            let value = try await self.perform(["kind": .string("config.resolve"), "connection": self.target()])
            self.resolution = (value["username"].string ?? "") + "@" + (value["hostname"].string ?? "") + ":" + (value["port"].string ?? "") + (value["proxy"].bool == true ? localized(" · Proxy configured", " · 已配置代理") : "")
        }
    }
    func keepTemporary() async {
        guard !dirty, !selectedID.isEmpty, profile["temporary"].bool == true else { return }
        await execute {
            let snapshot = try await self.bridge.snapshot()
            _ = try await self.bridge.call("ssh.quick.keep", params: .object(["expectedRevision": .string(snapshot.revision), "id": .string(self.selectedID)]))
            await self.reload(select: self.selectedID); await self.workspace?.reload()
        }
    }
    func execute(_ operation: () async throws -> Void) async {
        guard !busy, !prepared else { return }
        busy = true; error = ""; feedback = ""
        defer { busy = false; active = nil }
        do { try await operation() }
        catch let failure as BridgeFailure where failure.code == "SSH_TRANSFER_CANCELLED" { feedback = failure.message }
        catch { self.error = error.localizedDescription }
    }
    func connectFiles() async {
        guard !dirty, !selectedID.isEmpty else { error = localized("Save the connection first.", "请先保存连接。"); return }
        await execute {
            let root = try await self.perform(["kind": .string("files.open"), "connection": self.target(), "expected": self.remoteRoot])
            self.remoteRoot = root; self.roots[self.selectedID] = root; self.folder = ""
            try await self.readListing()
        }
    }
    private func readListing() async throws {
        let value = try await perform(["kind": .string("files.list"), "root": remoteRoot, "path": .string(folder), "hidden": .bool(hidden)])
        listing = value["entries"].array; selection = nil
        var notices: [String] = []
        if value["partial"].bool == true { notices.append(localized("Showing the first 2,000 entries.", "仅显示前 2,000 项。")) }
        if let count = value["skipped"].number, count > 0 { notices.append(localized("Skipped unsupported names: ", "已跳过不支持的名称：") + String(Int(count))) }
        feedback = notices.joined(separator: " ")
    }
    func list() async { await execute { try await self.readListing() } }
    func enter(_ item: JSONValue) async {
        guard item["directory"].bool == true else { return }
        let previous = folder
        folder = item["path"].string ?? ""
        await list()
        if !error.isEmpty { folder = previous }
    }
    func up() async {
        guard !folder.isEmpty else { return }
        let previous = folder; folder = folder.split(separator: "/").dropLast().joined(separator: "/")
        await list(); if !error.isEmpty { folder = previous }
    }
    func disconnectFiles() async {
        await execute {
            _ = try await self.perform(["kind": .string("files.disconnect"), "connection_id": .string(self.selectedID)])
            self.roots.removeValue(forKey: self.selectedID); self.remoteRoot = .null; self.listing = []; self.selection = nil
        }
        await workspace?.cleanupQuickSSH()
        if !dirty { await reload(select: selectedID) }
    }
    func previewFile() async {
        guard let selection else { return }
        await execute {
            let document = try await self.perform(["kind": .string("files.read"), "root": self.remoteRoot, "path": .string(selection)])
            guard document["kind"].string == "text" else { throw BridgeFailure(code: "SSH_PREVIEW_UNSUPPORTED", message: localized("Download this file to open it.", "请下载此文件后打开。")) }
            self.preview = document["text"].string ?? ""; self.previewPresented = true
        }
    }
    func chooseIdentity() {
        let picker = NSOpenPanel(); picker.canChooseDirectories = false
        if picker.runModal() == .OK { identity = picker.url?.path ?? identity }
    }
    func transfer(direction: String, paths: [URL]? = nil, overwrite: Bool = false) async {
        guard connected, !busy, !prepared else { return }
        busy = true; error = ""; feedback = ""
        defer { busy = false; active = nil }
        var selected = paths
        if selected == nil {
            if direction == "upload" {
                let picker = NSOpenPanel(); picker.canChooseDirectories = false; picker.allowsMultipleSelection = true
                if picker.runModal() == .OK { selected = picker.urls }
            } else {
                guard let selection else { return }
                let picker = NSSavePanel(); picker.nameFieldStringValue = selection.split(separator: "/").last.map(String.init) ?? "download"
                if picker.runModal() == .OK, let url = picker.url { selected = [url] }
            }
        }
        guard let selected else { return }
        if overwrite {
            let alert = NSAlert(); alert.messageText = localized("Replace existing remote files?", "替换已有远端文件？"); alert.addButton(withTitle: localized("Cancel", "取消")); alert.addButton(withTitle: localized("Replace", "替换"))
            guard alert.runModal() == .alertSecondButtonReturn else { return }
        }
        do {
            _ = try await self.perform(["kind": .string("files.transfer"), "root": self.remoteRoot, "path": .string(direction == "upload" ? self.folder : (self.selection ?? "")), "direction": .string(direction), "paths": .array(selected.map { .string($0.path) }), "overwrite": .bool(overwrite)])
            try await self.readListing(); self.feedback = localized("Transfer completed.", "传输已完成。")
        } catch let failure as BridgeFailure where failure.code == "SSH_TRANSFER_CANCELLED" { feedback = failure.message }
        catch { self.error = error.localizedDescription }
    }
    func cancelTransfer() async {
        guard let active, active.kind == "files.transfer", active.state == "running" else { return }
        do { _ = try await bridge.call("ssh.operation.cancel", params: .object(["id": .string(active.id), "generation": .string(active.generation)])) }
        catch { self.error = error.localizedDescription }
    }
    func newTerminal() async {
        guard !dirty, !selectedID.isEmpty, let snapshot else { return }
        await execute {
            do {
                _ = try await self.bridge.call("ssh.session.create", params: .object(["id": .string(UUID().uuidString), "name": .string(self.name.isEmpty ? self.host : self.name), "sshConnectionId": .string(self.selectedID), "workspaceId": .string(self.workspaceID), "expectedRevision": .string(snapshot.revision)]))
            } catch { await self.workspace?.reload(); throw error }
            await self.workspace?.reload(); await self.reload(select: self.selectedID)
        }
    }
    func remove() async {
        guard !selectedID.isEmpty, let snapshot else { return }
        let alert = NSAlert(); alert.messageText = localized("Remove SSH connection?", "移除 SSH 连接？"); alert.informativeText = name; alert.addButton(withTitle: localized("Cancel", "取消")); alert.addButton(withTitle: localized("Remove", "移除"))
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        await execute {
            let reference = self.profile["credential_id"].string; let remembered = self.profile["remember_password"].bool ?? false
            _ = try await self.bridge.call("ssh.profile.remove", params: .object(["id": .string(self.selectedID), "expectedRevision": .string(snapshot.revision)]))
            if let reference { _ = try await self.perform(["kind": .string("auth.forget"), "reference": .string(reference), "remember": .bool(remembered)]) }
            await self.reload(); await self.workspace?.reload()
        }
    }
    func addForward() async {
        guard let snapshot, let local = UInt16(localPort), let remote = UInt16(remotePort), local > 0, remote > 0 else { error = localized("Enter valid ports.", "请填写有效端口。"); return }
        await execute {
            var rules = self.forwards
            rules.append(.object(["id": .string(UUID().uuidString), "local_port": .number(Double(local)), "remote_host": .string(self.remoteHost), "remote_port": .number(Double(remote))]))
            _ = try await self.bridge.call("ssh.profile.forwards", params: .object(["id": .string(self.selectedID), "expectedRevision": .string(snapshot.revision), "rules": .array(rules)]))
            self.snapshot = try await self.bridge.snapshot(); self.localPort = ""; self.remotePort = ""
        }
    }
    func startForward(_ rule: JSONValue) async {
        await execute { _ = try await self.bridge.call("ssh.tunnel.start", params: .object(["connection": self.target(), "rule": rule])) }
    }
    func stopForward(_ status: JSONValue) async {
        await execute { _ = try await self.bridge.call("ssh.tunnel.stop", params: .object(["connection_id": status["connection_id"], "id": status["id"], "generation": status["generation"]])) }
        await workspace?.cleanupQuickSSH()
        if !dirty { await reload(select: selectedID) }
    }
    func removeForward(_ rule: JSONValue) async {
        guard let snapshot else { return }
        await execute {
            _ = try await self.bridge.call("ssh.profile.forwards", params: .object(["id": .string(self.selectedID), "expectedRevision": .string(snapshot.revision), "rules": .array(self.forwards.filter { $0["id"] != rule["id"] })]))
            self.snapshot = try await self.bridge.snapshot()
        }
    }
    func confirmDraft() async -> Bool {
        guard dirty else { return true }
        let alert = NSAlert(); alert.messageText = localized("Save SSH connection changes?", "保存 SSH 连接修改？"); alert.addButton(withTitle: localized("Save", "保存")); alert.addButton(withTitle: localized("Cancel", "取消")); alert.addButton(withTitle: localized("Discard", "放弃"))
        switch alert.runModal() { case .alertFirstButtonReturn: return await save(); case .alertThirdButtonReturn: return true; default: return false }
    }
    func prepareForQuit() async -> Bool {
        if busy && active?.kind != "files.transfer" { error = localized("Wait for the SSH operation to finish.", "请等待 SSH 操作完成。"); return false }
        guard await confirmDraft() else { return false }
        if busy || tunnels.contains(where: { $0["state"].string != "error" }) {
            let alert = NSAlert(); alert.messageText = localized("Cancel transfers and stop forwarding?", "取消传输并停止转发？"); alert.informativeText = localized("Hosted SSH terminals will remain running.", "后台 SSH 终端将继续运行。"); alert.addButton(withTitle: localized("Keep window open", "保留窗口")); alert.addButton(withTitle: localized("Cancel and close", "取消并关闭"))
            guard alert.runModal() == .alertSecondButtonReturn else { return false }
        }
        do { _ = try await perform(["kind": .string("prepareQuit")]); roots.removeAll(); remoteRoot = .null; listing = []; selection = nil; prepared = true; return true }
        catch { self.error = error.localizedDescription; return false }
    }
    func resumeAfterQuit() async { prepared = false; _ = try? await bridge.call("ssh.resume") }
    func stop() async { closed = true; polling?.cancel(); await resumeAfterQuit() }
}

private struct SSHRow: Identifiable {
    let value: JSONValue
    var id: String { value["id"].string ?? value["path"].string ?? "" }
    init(_ value: JSONValue) { self.value = value }
}

@MainActor
struct SSHView: View {
    @ObservedObject var model: SSHModel
    @ViewBuilder private var profileForm: some View {
        Text(localized("Workspace: ", "工作区：") + model.snapshotWorkspaceName).font(.caption).foregroundStyle(.secondary)
        Grid(alignment: .leading) {
            GridRow { Text(localized("Name", "名称")); TextField("", text: $model.name) }
            GridRow { Text(localized("Mode", "模式")); Picker("", selection: Binding(get: { model.mode }, set: { value in model.mode = value; if value == "alias" { model.port = "" } else if model.port.isEmpty { model.port = "22" } })) { Text(localized("Host address", "主机地址")).tag("direct"); Text(localized("OpenSSH configuration", "OpenSSH 配置")).tag("alias") }.labelsHidden() }
            GridRow { Text(localized("Host", "主机")); TextField("", text: $model.host).accessibilityIdentifier("ssh-host") }
            GridRow { Text(localized("Port", "端口")); TextField("", text: $model.port) }
            GridRow { Text(localized("Username", "用户名")); TextField("", text: $model.username) }
            GridRow { Text(localized("Authentication", "认证")); Picker("", selection: $model.authentication) { Text("OpenSSH / ssh-agent").tag("config"); Text(localized("Private key", "私钥")).tag("key"); Text(localized("Password", "密码")).tag("password") }.labelsHidden() }
            if model.authentication == "key" { GridRow { Text(localized("Identity file", "私钥文件")); HStack { TextField("", text: $model.identity); Button(localized("Choose…", "选择…")) { model.chooseIdentity() } } } }
            if model.authentication == "password" {
                GridRow { Text(localized("Password", "密码")); SecureField(localized("Keep existing password", "保留已有密码"), text: $model.password) }
                GridRow { Text(""); Toggle(localized("Remember password", "记住密码"), isOn: $model.remember).toggleStyle(.checkbox) }
            }
            GridRow { Text(localized("Jump host", "跳板机")); TextField("", text: $model.jump) }
            GridRow { Text(localized("Remote system", "远端系统")); Picker("", selection: $model.remoteOS) { Text("Linux / macOS").tag("posix"); Text("Windows").tag("windows") }.labelsHidden() }
            GridRow { Text(localized("File root", "文件根目录")); TextField("", text: $model.rootPath) }
        }.disabled(model.busy || model.prepared)
        HStack {
            Button(localized("Show effective configuration", "显示生效配置")) { Task { await model.resolve() } }
            Spacer()
            Button(localized("Reload", "重新读取")) { Task { if await model.confirmDraft() { await model.reload() } } }
            Button(localized("Save connection", "保存连接")) { Task { _ = await model.save() } }.accessibilityIdentifier("ssh-save")
            if model.profile["temporary"].bool == true {
                Button(localized("Save connection", "保存为常用连接")) { Task { await model.keepTemporary() } }.disabled(model.dirty).accessibilityIdentifier("ssh-keep-temporary")
            }
            Button(localized("New SSH terminal", "新建 SSH 终端")) { Task { await model.newTerminal() } }.disabled(model.dirty || model.selectedID.isEmpty).accessibilityIdentifier("ssh-new-terminal")
        }.disabled(model.busy || model.prepared)
        if !model.resolution.isEmpty { Text(model.resolution).font(.caption).textSelection(.enabled) }
    }
    @ViewBuilder private var remoteFiles: some View {
        HStack {
            Text(localized("Remote files", "远程文件")).font(.headline); Spacer()
            Button(model.connected ? localized("Reconnect", "重新连接") : localized("Connect files", "连接文件")) { Task { await model.connectFiles() } }.disabled(model.busy || model.prepared || model.dirty || model.selectedID.isEmpty).accessibilityIdentifier("ssh-connect-files")
            Button(localized("Disconnect", "断开")) { Task { await model.disconnectFiles() } }.disabled(!model.connected || model.busy || model.prepared)
        }
        if model.connected {
            HStack { Button("↑") { Task { await model.up() } }.disabled(model.folder.isEmpty); Text(model.remoteRoot["path"].string ?? "").lineLimit(1); Text(model.folder).lineLimit(1); Spacer(); Toggle(localized("Hidden", "隐藏项"), isOn: $model.hidden).toggleStyle(.checkbox); Button(localized("Refresh", "刷新")) { Task { await model.list() } } }.disabled(model.busy || model.prepared)
            List(selection: $model.selection) {
                ForEach(model.listing.map(SSHRow.init)) { row in
                    let item = row.value
                    HStack { Image(systemName: item["directory"].bool == true ? "folder" : "doc"); Text(item["name"].string ?? ""); if item["symlink"].bool == true { Text("↗") }; Spacer(); if item["directory"].bool == true { Button(localized("Open", "打开")) { Task { await model.enter(item) } } } }.tag(item["path"].string ?? "")
                }
            }.frame(minHeight: 150, idealHeight: 190).disabled(model.busy || model.prepared).accessibilityIdentifier("ssh-files")
            HStack {
                Button(localized("Preview", "预览")) { Task { await model.previewFile() } }.disabled(model.selection == nil)
                Button(localized("Download…", "下载…")) { Task { await model.transfer(direction: "download") } }.disabled(model.selection == nil)
                Spacer()
                Button(localized("Upload…", "上传…")) { Task { await model.transfer(direction: "upload") } }
                Button(localized("Upload and replace…", "上传并替换…")) { Task { await model.transfer(direction: "upload", overwrite: true) } }
            }.disabled(model.busy || model.prepared)
        }
        if let active = model.transferProgress {
            HStack {
                if let progress = active.progress { Text(progress.name + " · " + progress.completed + " / " + progress.total).font(.caption) }
                Spacer(); Button(localized("Cancel transfer", "取消传输")) { Task { await model.cancelTransfer() } }.disabled(active.state != "running")
            }
        }
    }
    @ViewBuilder private var forwarding: some View {
        Text(localized("Port forwarding", "端口转发")).font(.headline)
        ForEach(model.forwards.map(SSHRow.init)) { row in
            let rule = row.value
            let status = model.tunnels.first { $0["id"] == rule["id"] && $0["connection_id"].string == model.selectedID }
            HStack {
                Text(verbatim: "127.0.0.1:\(Int(rule["local_port"].number ?? 0)) → \(rule["remote_host"].string ?? ""):\(Int(rule["remote_port"].number ?? 0))")
                Text(status?["state"].string == "running" ? localized("Listening", "正在监听") : status?["state"].string == "starting" ? localized("Starting", "正在启动") : status?["state"].string == "error" ? localized("Failed", "失败") : localized("Stopped", "已停止")).font(.caption); Spacer()
                if let status, status["state"].string != "error" { Button(localized("Stop forwarding", "停止转发")) { Task { await model.stopForward(status) } } }
                else { Button(localized("Start forwarding", "启动转发")) { Task { await model.startForward(rule) } }; Button(localized("Remove", "移除")) { Task { await model.removeForward(rule) } } }
            }.disabled(model.busy || model.prepared || model.dirty)
            if let message = status?["error"].string { Text(message).foregroundStyle(.red).font(.caption).textSelection(.enabled) }
        }
        HStack {
            TextField(localized("Local port", "本地端口"), text: $model.localPort).frame(width: 100)
            TextField(localized("Remote host", "远端地址"), text: $model.remoteHost)
            TextField(localized("Remote port", "远端端口"), text: $model.remotePort).frame(width: 100)
            Button(localized("Add forwarding", "添加转发")) { Task { await model.addForward() } }
        }.disabled(model.busy || model.prepared || model.dirty || model.selectedID.isEmpty)
    }
    var body: some View {
        HSplitView {
            VStack {
                List(model.connections.map(SSHRow.init)) { row in
                    let value = row.value
                    Button(value["name"].string ?? "SSH") { Task { await model.select(value["id"].string) } }.buttonStyle(.plain).accessibilityIdentifier("ssh-profile-" + (value["id"].string ?? ""))
                }
                HStack { Button(localized("Add", "添加")) { Task { await model.select(nil) } }; Button(localized("Remove", "移除")) { Task { await model.remove() } }.disabled(model.selectedID.isEmpty); Spacer() }.padding(8)
            }.frame(minWidth: 150, idealWidth: 180, maxWidth: 240).disabled(model.busy || model.prepared)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if model.busy { HStack { ProgressView().controlSize(.small); Text(localized("Working…", "正在处理…")) } }
                    profileForm
                    Divider()
                    remoteFiles
                    Divider()
                    forwarding
                    if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled).accessibilityIdentifier("ssh-error") }
                    if !model.feedback.isEmpty { Text(model.feedback).foregroundStyle(.secondary).accessibilityIdentifier("ssh-feedback") }
                }.padding(12)
            }.frame(minWidth: 550)
        }.sheet(isPresented: $model.previewPresented) {
            VStack { ScrollView { Text(model.preview).font(.system(.body, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }; Button(localized("Close", "关闭")) { model.previewPresented = false } }.padding().frame(minWidth: 480, minHeight: 300)
        }
    }
}

@MainActor
final class SSHWindow: NSWindowController, NSWindowDelegate, NativeWorkspacePanelContent {
    let model: SSHModel
    private(set) var workspacePanelView: NSView?
    var didClose: (() -> Void)?
    private var closing = false
    init(model: SSHModel) {
        self.model = model
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init(window: window)
        window.title = localized("SSH connections", "SSH 连接"); window.minSize = NSSize(width: 760, height: 520); window.delegate = self
        workspacePanelView = NSHostingView(rootView: SSHView(model: model))
        window.contentView = workspacePanelView; model.ownerWindow = window
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closing { return true }
        Task { @MainActor in if await model.prepareForQuit() { await forceClose() } }
        return false
    }
    func forceClose() async { closing = true; await model.stop(); window?.close() }
    func windowWillClose(_ notification: Notification) { didClose?() }
}
