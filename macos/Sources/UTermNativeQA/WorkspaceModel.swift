import AppKit
import SwiftUI
import UTermBridge

struct NativeListItem: Identifiable { let id: String; let name: String }
struct NameDraft: Identifiable {
    let id = UUID()
    let target: String?
    var name: String
    var revision: String
}

@MainActor
final class WorkspaceModel: ObservableObject {
    @Published private(set) var state: CoreViewSnapshot?
    @Published private(set) var environment: JSONValue = .null
    private(set) var settingsCatalog: JSONValue = .null
    private(set) var commandItems: [JSONValue] = []
    private var resolvedShortcuts: JSONValue = .null
    @Published private(set) var busy = false
    @Published var error = ""
    @Published private(set) var terminalError = ""
    @Published var settingsPresented = false
    @Published var editorRecoveryPresented = false
    @Published var gitFavoritesRecoveryPresented = false
    @Published var worktreeDeletionPresented = false
    @Published var nameDraft: NameDraft?
    @Published var fullScreen = false
    @Published var sidebarVisible = true
    @Published private(set) var focusRevision = 0
    @Published private(set) var toolbarHeight: CGFloat = 0
    @Published var controlStatus: JSONValue = .null
    @Published var controlError = ""
    @Published var controlBusy = false
    var controlTask: Task<Void, Never>?
    var requestActivation: (() -> Void)?
    private(set) var bridge: CoreBridge?
    // Retain temporary SSH credentials when only the terminal transport is reopened.
    // 仅重建终端传输时保留临时 SSH 凭据。
    private(set) var sshBridge: CoreBridge?
    private(set) var terminals: [String: TerminalSession] = [:]
    var languageChanged: (() -> Void)?
    var appearanceChanged: ((String) -> Void)?
    var commandsChanged: (() -> Void)?
    var deleteWorktreeRequested: ((String, String) -> Void)?
    var openSSHRequested: ((String?) -> Void)?
    var openDatabasesRequested: (() -> Void)?
    var openRedisRequested: (() -> Void)?
    var openAgentsRequested: (() -> Void)?
    var openSettingsRequested: (() -> Void)?
    var prepareSSHTransportReconnect: (() async -> Bool)?
    var sshTrustTask: Task<Void, Never>?
    var sshTrustAlert: NSAlert?
    var sshTrustID: String?
    @Published var sshTrustPresented = false
    private var events: Task<Void, Never>?
    private var frames: Task<Void, Never>?
    private var failures: Task<Void, Never>?
    private var operation: Task<Bool, Never>?
    private var loadEpoch = 0
    private var shuttingDown = false
    private var helperReady = false
    private var needsReload = false
    lazy var agentNotifications = AgentNotifications(workspace: self)

    var workspace: JSONValue { state?.snapshot.document.workspace ?? .null }
    var settings: JSONValue { state?.snapshot.document.settings ?? .null }
    var selectedID: String? { workspace["selectedSession"].string }
    var groupID: String { workspace["selectedWorkspace"].string ?? "local" }
    var ready: Bool { state != nil && helperReady && bridge != nil }
    var selectedTerminal: TerminalSession? { selectedID.flatMap { terminals[$0] } }
    var groups: [JSONValue] { workspace["groups"].array }
    var projects: [JSONValue] {
        let values = workspace["projects"].array.filter { $0["workspaceId"].string == groupID }
        return settings["projectOrder"].string == "name" ? values.sorted { ($0["name"].string ?? "").localizedStandardCompare($1["name"].string ?? "") == .orderedAscending } : values
    }
    var groupItems: [NativeListItem] { groups.map { NativeListItem(id: $0["id"].string ?? "", name: $0["name"].string ?? "") } }
    var projectItems: [NativeListItem] { projects.map { NativeListItem(id: $0["id"].string ?? "", name: $0["name"].string ?? "") } }
    var sessionEntries: [CoreSessionEntry] { (state?.sessions ?? []).filter { $0.workspaceId == groupID } }
    func measureToolbar(_ height: CGFloat) { if abs(toolbarHeight - height) > 0.1 { toolbarHeight = height } }

    static func dataRoot() throws -> URL {
        guard Bundle.main.bundleIdentifier == "sh.uterm.desktop.qa.native" else {
            throw BridgeFailure(code: "QA_IDENTITY", message: "Native QA requires its isolated bundle identity")
        }
        if let path = argument("--qa-data-root") {
            let root = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
            let temporary = FileManager.default.temporaryDirectory.standardizedFileURL.resolvingSymlinksInPath()
            guard root.path.hasPrefix(temporary.path + "/"), root.lastPathComponent.hasPrefix("uterm-native-qa-") else {
                throw BridgeFailure(code: "QA_DIRECTORY", message: "QA override must be a private temporary test directory")
            }
            return root.appendingPathComponent("shared-state-v1", isDirectory: true)
        }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return support.appendingPathComponent("sh.uterm.desktop.qa.native/shared-state-v1", isDirectory: true)
    }

    static func argument(_ name: String) -> String? {
        guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
        return CommandLine.arguments[index + 1]
    }

    func start() async {
        do {
            let bridge = try await CoreBridge.open(root: Self.dataRoot())
            self.bridge = bridge
            do { _ = try await bridge.snapshot() }
            catch let failure as BridgeFailure where failure.code == "NOT_IMPORTED" {
                let defaults = try await bridge.call("state.defaults")
                _ = try await bridge.call("migration.import", params: .object([
                    "workspace": defaults["workspace"], "settings": defaults["settings"], "legacy": .object([:])
                ]))
            }
            guard let resources = Bundle.main.resourceURL else { throw BridgeFailure(code: "HELPER", message: "Application resources are missing") }
            let helper = resources.appendingPathComponent("bin/utermd-local")
            _ = try await bridge.call("host.configure", params: .object(["helper": .string(helper.path)]))
            if Self.argument("--qa-data-root") != nil {
                let home = try Self.dataRoot().deletingLastPathComponent().appendingPathComponent("agent-home").path
                _ = try await bridge.call("agent.configure", params: .object(["home": .string(home)]))
            }
            helperReady = true
            if sshBridge == nil {
                let ssh = try await CoreBridge.open(root: Self.dataRoot())
                do {
                    _ = try await ssh.call("host.configure", params: .object(["helper": .string(helper.path)]))
                    if Self.argument("--qa-data-root") != nil {
                        let home = try Self.dataRoot().deletingLastPathComponent().appendingPathComponent("agent-home").path
                        _ = try await ssh.call("agent.configure", params: .object(["home": .string(home)]))
                    }
                    _ = try await ssh.call("ssh.configure", params: .object(["credentialService": .string((Bundle.main.bundleIdentifier ?? "sh.uterm.desktop.qa.native") + ".ssh")]))
                    _ = try await ssh.call("database.configure", params: .object(["identifier": .string(Bundle.main.bundleIdentifier ?? "sh.uterm.desktop.qa.native")]))
                    _ = try await ssh.call("redis.configure", params: .object(["identifier": .string(Bundle.main.bundleIdentifier ?? "sh.uterm.desktop.qa.native")]))
                    sshBridge = ssh
                } catch { await ssh.close(); throw error }
            }
            if let sshBridge { startSSHTrust(sshBridge) }
            for session in terminals.values { session.rebind(bridge) }
            environment = try await bridge.call("host.environment")
            await reload()
            guard state != nil else { throw BridgeFailure(code: "BOOTSTRAP", message: error) }
            events = Task { @MainActor [weak self, bridge] in
                for await event in bridge.events {
                    guard let self, !Task.isCancelled else { return }
                    guard event.version == 1, event.kind == "snapshot.changed" else { continue }
                    if self.busy { self.needsReload = true }
                    else { await self.reload() }
                }
            }
            frames = Task { @MainActor [weak self, bridge] in
                do {
                    for try await packet in bridge.terminalFrames {
                        guard let self, !Task.isCancelled else { bridge.consumed(packet); return }
                        if let terminal = self.terminals.values.first(where: { $0.attachment == packet.header.attachment }) {
                            await terminal.receive(packet)
                        }
                        bridge.consumed(packet)
                    }
                } catch { self?.terminalError = error.localizedDescription }
            }
            failures = Task { @MainActor [weak self, bridge] in
                for await failure in bridge.terminalFailures {
                    guard let self, !Task.isCancelled else { return }
                    if let terminal = self.terminals.values.first(where: { $0.attachment == failure.attachment }) { terminal.reportFailure(failure) }
                    else if failure.attachment == nil { self.terminalError = failure.message }
                }
            }
            if ready { terminalError = "" }
            await startControl()
        } catch { self.error = error.localizedDescription }
    }

    func reload() async {
        guard let bridge, !shuttingDown else { return }
        loadEpoch += 1
        let epoch = loadEpoch
        do {
            if settingsCatalog == .null { settingsCatalog = try await bridge.call("settings.catalog") }
            let state = try await bridge.viewSnapshot()
            guard epoch == loadEpoch else { return }
            let language = state.snapshot.document.settings["language"].string ?? "system"
            if NativeLocale.preference != language { NativeLocale.preference = language; languageChanged?() }
            self.state = state
            if commandItems.isEmpty || resolvedShortcuts != settings["shortcuts"] {
                let items = try await bridge.call("settings.commands", params: .object(["settings": settings, "platform": .string("macos")])).array
                guard epoch == loadEpoch else { return }
                commandItems = items
                resolvedShortcuts = settings["shortcuts"]
                commandsChanged?()
            }
            appearanceChanged?(settings["appearance"].string ?? "system")
            let existing = Set(state.sessions.map { $0.session["id"].string ?? "" })
            agentNotifications.retain(existing)
            for (id, terminal) in terminals where !existing.contains(id) {
                _ = try await bridge.call("terminal.action", params: .object(["attachment": .string(terminal.attachment), "action": .string("detach")]))
            }
            terminals = terminals.filter { existing.contains($0.key) }
            for entry in state.sessions {
                guard let id = entry.session["id"].string else { continue }
                if terminals[id] == nil {
                    let session = TerminalSession(entry: entry, bridge: bridge)
                    session.changed = { [weak self] in self?.objectWillChange.send() }
                    session.activity = { [weak self] header in self?.agentNotifications.consume(header, session: id) }
                    terminals[id] = session
                }
                terminals[id]?.update(entry: entry)
                terminals[id]?.apply(settings: settings, catalog: settingsCatalog)
                if let session = terminals[id] { Task { await session.connect() } }
            }
            error = ""
        } catch { if epoch == loadEpoch { self.error = error.localizedDescription } }
    }

    @discardableResult
    func mutate(_ method: String, _ values: [String: JSONValue], revision: String? = nil) async -> Bool {
        guard !busy, !shuttingDown, !worktreeDeletionPresented, !gitFavoritesRecoveryPresented, let bridge, let state else { return false }
        let actionBridge: CoreBridge
        if method.hasPrefix("ssh.") {
            guard let sshBridge else { return false }
            actionBridge = sshBridge
        } else { actionBridge = bridge }
        busy = true
        var params = values
        params["expectedRevision"] = .string(revision ?? state.snapshot.revision)
        let task = Task { @MainActor [weak self, actionBridge] in
            guard let self else { return false }
            defer { self.busy = false; self.operation = nil }
            do {
                _ = try await actionBridge.call(method, params: .object(params))
                await self.reload()
                if self.needsReload { self.needsReload = false; await self.reload() }
                return true
            } catch { self.error = error.localizedDescription; return false }
        }
        operation = task
        return await task.value
    }

    func beginRepositoryMutation() -> Bool {
        guard !busy, !shuttingDown, !worktreeDeletionPresented, !gitFavoritesRecoveryPresented else { return false }
        busy = true
        return true
    }
    func finishRepositoryMutation() {
        busy = false
    }

    func selectSession(_ id: String, focus: Bool = true) async {
        if selectedID == id { return }
        if let operation { _ = await operation.value }
        if await mutate("session.select", ["id": .string(id)]), focus { focusRevision += 1 }
    }

    func performControlAction(_ request: JSONValue) async throws -> JSONValue {
        guard !busy, !shuttingDown, !settingsPresented, !editorRecoveryPresented, !worktreeDeletionPresented, !gitFavoritesRecoveryPresented, nameDraft == nil,
              let bridge, let state else {
            throw BridgeFailure(code: "CONTROL_BUSY", message: localized("Finish the current dialog or operation first.", "请先完成当前对话框或操作。"))
        }
        busy = true
        defer { busy = false }
        let method = request["method"].string ?? ""
        let target = request["params"]["id"].string
        let generation = target.flatMap { terminals[$0]?.generation }
        do {
            let result = try await bridge.call("control.execute", params: .object([
                "requestId": request["id"], "expectedRevision": .string(state.snapshot.revision),
                "generation": generation.map(JSONValue.string) ?? .null
            ]))
            await reload()
            if needsReload { needsReload = false; await reload() }
            if ["sessions.new", "sessions.focus", "open"].contains(method) {
                focusRevision += 1
                requestActivation?()
            }
            return result["result"]
        } catch {
            let message = error.localizedDescription
            await reload()
            self.error = message
            throw error
        }
    }

    func selectProject(_ id: String, worktree: String? = nil, focus: Bool = true) async {
        if let operation { _ = await operation.value }
        if await mutate("project.select", ["id": .string(id), "worktreeId": worktree.map(JSONValue.string) ?? .null]), focus { focusRevision += 1 }
    }

    func refreshWorktrees(_ id: String) async {
        if let operation { _ = await operation.value }
        _ = await mutate("project.worktrees.refresh", ["id": .string(id)])
    }

    func newTerminal(agent: String? = nil) async {
        let id = UUID().uuidString
        var values: [String: JSONValue] = ["id": .string(id), "name": .string(agent ?? localized("Terminal", "终端"))]
        if agent == nil, let selected = sessionEntries.first(where: { $0.sessionID == selectedID }), let connection = selected.session["ssh"]["connection_id"].string {
            values["sshConnectionId"] = .string(connection)
            values["workspaceId"] = .string(selected.workspaceId)
            if await mutate("ssh.session.create", values) { focusRevision += 1 }
            else { let failure = error; await reload(); error = failure }
            return
        }
        if let agent { values["agent"] = .string(agent); values["projectId"] = .null }
        if await mutate("session.create", values) { focusRevision += 1 }
    }
    func newDefaultAgent() async {
        if await mutate("session.createChat", ["id": .string(UUID().uuidString)]) { focusRevision += 1 }
    }

    func split(_ axis: String) async {
        guard let id = selectedID else { return }
        let splitID = UUID().uuidString
        if await mutate("session.split", [
            "anchor": .string(id), "id": .string(splitID), "splitId": .string(UUID().uuidString),
            "axis": .string(axis), "name": .string(localized("Terminal", "终端"))
        ]) {
            if let created = sessionEntries.first(where: { $0.sessionID == splitID }), created.session["ssh"] != .null {
                do {
                    guard let sshBridge else { throw BridgeFailure(code: "CLOSED", message: "SSH client is unavailable") }
                    _ = try await sshBridge.call("ssh.session.start", params: .object(["id": .string(splitID)])); await reload()
                }
                catch { self.error = error.localizedDescription }
            }
            focusRevision += 1
        }
    }

    func closeSession() async {
        guard let id = selectedID, let terminal = terminals[id], let bridge else { return }
        if let operation { _ = await operation.value }
        do {
            await terminal.drainInput()
            await terminal.finishConnection()
            _ = try await bridge.call("host.close", params: .object(["id": .string(id), "generation": terminal.generation.map(JSONValue.string) ?? .null]))
            if await mutate("session.remove", ["id": .string(id)]) { focusRevision += 1 }
        } catch { self.error = error.localizedDescription }
    }

    func newWorkspace() {
        guard let state else { return }
        nameDraft = NameDraft(target: nil, name: "", revision: state.snapshot.revision)
    }

    func openProject() {
        let picker = NSOpenPanel()
        picker.title = localized("Open a project", "打开项目")
        picker.canChooseDirectories = true
        picker.canChooseFiles = false
        picker.allowsMultipleSelection = false
        picker.begin { [weak self] response in
            guard response == .OK, let url = picker.url, let self else { return }
            Task { @MainActor in
                do {
                    guard let bridge = self.bridge else { return }
                    let directory = try await bridge.call("directory.resolve", params: .object(["directory": .string(url.path)]))
                    await self.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string(url.lastPathComponent), "directory": directory, "workspaceId": .string(self.groupID)])
                } catch { self.error = error.localizedDescription }
            }
        }
    }

    func patchSettings(_ patch: [String: JSONValue]) async {
        if let operation { _ = await operation.value }
        await mutate("settings.patch", ["patch": .object(patch)])
    }
    func refreshAgentEnvironment() async {
        guard let bridge else { return }
        do { environment = try await bridge.call("host.environment") }
        catch { self.error = localized("Could not refresh Agent availability.", "无法刷新 Agent 可用状态。") }
    }

    func renameWorkspace() {
        guard let state else { return }
        let current = groups.first { $0["id"].string == groupID }?["name"].string ?? ""
        nameDraft = NameDraft(target: groupID, name: current, revision: state.snapshot.revision)
    }

    func saveNameDraft() async {
        guard let draft = nameDraft else { return }
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let method = draft.target == nil ? "workspace.create" : "workspace.rename"
        if await mutate(method, ["id": .string(draft.target ?? draft.id.uuidString), "name": .string(name), "select": .bool(true)], revision: draft.revision) { nameDraft = nil }
    }

    func reloadNameDraft() async {
        await reload()
        if let state { nameDraft?.revision = state.snapshot.revision }
    }

    func recover() {
        guard let bridge else { return }
        Task { @MainActor in
            do {
                let listing = try await bridge.call("recovery.list")
                let revisions = listing["backups"].array.compactMap(\.string)
                guard !revisions.isEmpty else { self.error = localized("No valid recovery copies are available.", "没有可用的有效恢复副本。"); return }
                let choice = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 340, height: 28))
                choice.addItems(withTitles: revisions.map { String($0.prefix(12)) })
                let alert = NSAlert()
                alert.messageText = localized("Restore saved data", "恢复保存数据")
                alert.informativeText = localized("The damaged file will be retained.", "将保留损坏文件。")
                alert.accessoryView = choice
                alert.addButton(withTitle: localized("Restore", "恢复"))
                alert.addButton(withTitle: localized("Cancel", "取消"))
                guard alert.runModal() == .alertFirstButtonReturn else { return }
                _ = try await bridge.call("recovery.restore", params: .object(["expectedRevision": listing["currentRevision"], "backupRevision": .string(revisions[choice.indexOfSelectedItem])]))
                if self.helperReady { await self.reload() }
                else { await bridge.close(); self.bridge = nil; await self.start() }
            } catch { self.error = error.localizedDescription }
        }
    }

    func shutdown() async {
        if let operation { _ = await operation.value }
        shuttingDown = true
        agentNotifications.retain([])
        stopSSHTrust()
        await stopControl()
        for terminal in terminals.values { terminal.cancelConnection() }
        for terminal in terminals.values { await terminal.drainInput() }
        events?.cancel()
        frames?.cancel()
        failures?.cancel()
        await sshBridge?.close()
        sshBridge = nil
        await bridge?.close()
        bridge = nil
    }

    func reconnectTransport() async {
        if let operation { _ = await operation.value }
        guard !shuttingDown else { return }
        if let prepareSSHTransportReconnect, !(await prepareSSHTransportReconnect()) { return }
        stopSSHTrust()
        busy = true
        defer { busy = false }
        await stopControl()
        for terminal in terminals.values { terminal.pauseForRebind() }
        for terminal in terminals.values { await terminal.finishConnection(); await terminal.drainInput() }
        events?.cancel(); frames?.cancel(); failures?.cancel()
        await bridge?.close()
        bridge = nil
        helperReady = false
        await start()
    }

    func confirmQuit() async -> Bool {
        if let operation { _ = await operation.value }
        guard nameDraft != nil else { return true }
        let alert = NSAlert()
        alert.messageText = localized("The name has not been saved.", "名称尚未保存。")
        alert.addButton(withTitle: localized("Keep editing", "继续编辑"))
        alert.addButton(withTitle: localized("Quit", "退出"))
        return alert.runModal() == .alertSecondButtonReturn
    }
}
