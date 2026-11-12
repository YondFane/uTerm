import AppKit
import SwiftUI
import UTermBridge

struct NativeListItem: Identifiable { let id: String; let name: String }
enum NameDraftOwner: Equatable { case workspace, settings }
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
    @Published var quickSSHPresented = false
    @Published var quickSSHContent: ContentWindow?
    @Published var quickSSHHeight: Double = 240
    @Published var githubPRContent: ContentWindow?
    @Published var githubPRHeight: Double = 520
    var workspaceModalContent: ContentWindow? { quickSSHContent ?? githubPRContent }
    var workspaceModalPresented: Bool { workspaceModalContent != nil }
    var workspaceModalPending: Bool {
        if let host = workspaceModalContent?.workbenchHost as? QuickSSHHost { return host.pending }
        if let host = workspaceModalContent?.workbenchHost as? GitHubPRHost { return host.pending }
        return false
    }
    @Published var nameDraft: NameDraft?
    @Published var nameDraftOwner: NameDraftOwner = .workspace
    private(set) var qaNameSaveCompletions = 0
    @Published var fullScreen = false
    @Published var sidebarVisible = true
    @Published var sidebarSection = "all"
    @Published var sidebarQuery = ""
    @Published var sidebarCollapsed: Set<String> = []
    @Published var inspectorVisible = false
    @Published var paneZoomed = false
    @Published private(set) var breakReminderVisible = false
    private var breakSchedule = BreakReminderSchedule()
    private var breakTimer: Task<Void, Never>?
    @Published private(set) var focusRevision = 0
    @Published private(set) var toolbarHeight: CGFloat = 0
    @Published private(set) var toolbarTop: CGFloat = -1
    @Published private(set) var viewportWidth: CGFloat = 1100
    @Published private(set) var sidebarWidth: CGFloat = 0
    private(set) var sidebarRailFrame: CGRect = .zero
    private(set) var sidebarAllButtonFrame: CGRect = .zero
    @Published private(set) var inspectorWidth: CGFloat = 0
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
    var openQuickSSHRequested: (() -> Void)?
    var canPruneQuickSSH: (() -> Bool)?
    var openDatabasesRequested: (() -> Void)?
    var openRedisRequested: (() -> Void)?
    var openDatabaseProfileRequested: ((String, String) -> Void)?
    var openRedisProfileRequested: ((String, String) -> Void)?
    lazy var branchPicker = NativeBranchPickerModel(self)
    lazy var projectRuns = NativeProjectRunsModel(self)
    var revealProjectRunRequested: ((String, JSONValue) -> Void)?
    var openAgentsRequested: (() -> Void)?
    var openSettingsRequested: (() -> Void)?
    var openJavaToolsRequested: ((JavaRunModel) -> Bool)?
    var openFileRequested: (() -> Void)?
    var performCommandRequested: ((String) -> Void)?
    var commandIsAvailable: ((String) -> Bool)?
    var openJavaRequested: (() -> Void)?
    var openPythonRequested: (() -> Void)?
    private var databaseHostCache: DatabaseHost?
    var openGitRequested: (() -> Void)?
    var openGitHubRequested: (() -> Void)?
    var makeGitTools: ((URL, String) async throws -> ContentWindow)?
    var makeGitHubTools: ((URL, String) async throws -> ContentWindow)?
    var openInspectorFile: ((String, String, Int) async throws -> Void)?
    var makeFileTools: ((URL, String) async throws -> ContentWindow)?
    var prepareSSHTransportReconnect: (() async -> Bool)?
    var sshTrustTask: Task<Void, Never>?
    var sshTrustAlert: NSAlert?
    var sshTrustID: String?
    @Published var sshTrustPresented = false
    private var events: Task<Void, Never>?
    private var frames: Task<Void, Never>?
    private var failures: Task<Void, Never>?
    private var operation: Task<Bool, Never>?
    private let refreshCycle = WorkspaceRefreshCycle()
    private var loadEpoch = 0
    private var snapshotReadError: String?
    private var shuttingDown = false
    private var helperReady = false
    private var needsReload = false
    lazy var agentNotifications = AgentNotifications(workspace: self)
    lazy var documents: NativeWorkspaceDocuments = {
        let value = NativeWorkspaceDocuments()
        value.selectionChanged = { [weak self] content in
            guard let self else { return }
            if content.workbenchHost != nil || self.panels.active(in: self.inspectorContextKey)?.runKind == nil { self.panels.showTerminal(in: self.inspectorContextKey) }
        }
        value.terminalFocusRequested = { [weak self] in self?.focusRevision += 1 }
        return value
    }()
    lazy var panels: NativeWorkspacePanels = {
        let value = NativeWorkspacePanels()
        value.terminalFocusRequested = { [weak self] in self?.focusRevision += 1 }
        return value
    }()
    lazy var inspector = NativeInspectorModel(workspace: self)
    lazy var updates = NativeUpdates()
    var inspectorContextKey: String { [groupID, workspace["selectedProject"].string ?? "", workspace["selectedWorktree"].string ?? ""].joined(separator: "\u{0}") }
    var inspectorOwnsFocus: Bool {
        guard inspectorVisible, let responder = NSApp.keyWindow?.firstResponder as? NSView else { return false }
        var view: NSView? = (responder as? NSTextView).flatMap { $0.isFieldEditor ? $0.delegate as? NSView : nil } ?? responder
        while let current = view { if current is InspectorContainer { return true }; view = current.superview }
        return false
    }
    func showInspector(_ mode: NativeInspectorModel.Mode) { inspector.show(mode); inspectorVisible = true }
    func hideInspector() { inspectorVisible = false; inspector.invalidate(); focusRevision += 1 }
    func sharedDatabaseHost() throws -> DatabaseHost {
        if let databaseHostCache { return databaseHostCache }
        guard let sshBridge else { throw BridgeFailure(code: "DB_CLOSED", message: localized("Database client is unavailable.", "数据库客户端不可用。")) }
        let host = DatabaseHost(bridge: sshBridge)
        host.report = { [weak self] in self?.error = $0 }
        host.changed = { [weak self] in await self?.reload() }
        databaseHostCache = host
        return host
    }

    var workspace: JSONValue { state?.snapshot.document.workspace ?? .null }
    var settings: JSONValue { state?.snapshot.document.settings ?? .null }
    var selectedID: String? { workspace["selectedSession"].string }
    var groupID: String { workspace["selectedWorkspace"].string ?? "local" }
    var ready: Bool { state != nil && helperReady && bridge != nil }
    var selectedTerminal: TerminalSession? { selectedID.flatMap { terminals[$0] } }
    var groups: [JSONValue] { workspace["groups"].array }
    var projects: [JSONValue] {
        let values = workspace["projects"].array.filter { $0["workspaceId"].string == groupID }
        return values.sorted {
            if ($0["pinned"].bool == true) != ($1["pinned"].bool == true) { return $0["pinned"].bool == true }
            if settings["projectOrder"].string == "name" { return ($0["name"].string ?? "").localizedStandardCompare($1["name"].string ?? "") == .orderedAscending }
            return false
        }
    }
    var groupItems: [NativeListItem] { groups.map { NativeListItem(id: $0["id"].string ?? "", name: $0["name"].string ?? "") } }
    var projectItems: [NativeListItem] { projects.map { NativeListItem(id: $0["id"].string ?? "", name: $0["name"].string ?? "") } }
    var sessionEntries: [CoreSessionEntry] { (state?.sessions ?? []).filter { $0.workspaceId == groupID } }
    func revealSelectedPane() { paneZoomed = false; focusRevision += 1 }
    func measureViewport(_ width: CGFloat) { if abs(viewportWidth - width) > 0.1 { viewportWidth = width } }
    func measureInspector(_ width: CGFloat) { if abs(inspectorWidth - width) > 0.1 { inspectorWidth = width } }
    func measureSidebar(_ width: CGFloat) { if abs(sidebarWidth - width) > 0.1 { sidebarWidth = width } }
    func measureSidebarRail(_ frame: CGRect) { sidebarRailFrame = frame }
    func measureSidebarAllButton(_ frame: CGRect) { sidebarAllButtonFrame = frame }
    func measureToolbarTop(_ top: CGFloat) { if abs(toolbarTop - top) > 0.1 { toolbarTop = top } }
    func measureToolbar(_ height: CGFloat) { if abs(toolbarHeight - height) > 0.1 { toolbarHeight = height } }

    static var applicationProfile: NativeApplicationProfile {
        NativeApplicationProfile(mode: NativeApplicationProfile.compiledMode, identifier: Bundle.main.bundleIdentifier ?? "", embeddedQARoot: Bundle.main.object(forInfoDictionaryKey: "UTermQADataRoot") as? String)
    }

    static func dataRoot() throws -> URL {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return try applicationProfile.dataRoot(applicationSupport: support, temporaryDirectory: FileManager.default.temporaryDirectory, qaOverride: argument("--qa-data-root"))
    }

    static func argument(_ name: String) -> String? {
        #if UTERM_PERSONAL
        return nil
        #else
        guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
        return CommandLine.arguments[index + 1]
        #endif
    }

    func start() async {
        do {
            let root = try Self.dataRoot()
            if Self.applicationProfile.mode == .personal {
                try FileManager.default.createDirectory(at: root.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            }
            let bridge = try await CoreBridge.open(root: root)
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
            if Self.argument("--qa-data-root") != nil || Self.applicationProfile.personalFixture {
                let home = try Self.dataRoot().deletingLastPathComponent().appendingPathComponent("agent-home").path
                _ = try await bridge.call("agent.configure", params: .object(["home": .string(home)]))
            }
            helperReady = true
            if sshBridge == nil {
                let ssh = try await CoreBridge.open(root: Self.dataRoot())
                do {
                    _ = try await ssh.call("host.configure", params: .object(["helper": .string(helper.path)]))
                    if Self.argument("--qa-data-root") != nil || Self.applicationProfile.personalFixture {
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
            await reload(clearOperationError: true)
            guard state != nil else { throw BridgeFailure(code: "BOOTSTRAP", message: error) }
            await cleanupQuickSSH()
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

    func reload(clearOperationError: Bool = false) async {
        if clearOperationError { error = ""; snapshotReadError = nil }
        guard bridge != nil, !shuttingDown else { return }
        await refreshCycle.run { [weak self] in
            if let self { await self.readWorkspaceSnapshot() }
        }
    }

    private func readWorkspaceSnapshot() async {
        guard let bridge, !shuttingDown else { return }
        loadEpoch += 1
        let epoch = loadEpoch
        do {
            if settingsCatalog == .null { settingsCatalog = try await bridge.call("settings.catalog") }
            let state = try await bridge.viewSnapshot()
            guard epoch == loadEpoch, bridge === self.bridge, !shuttingDown else { return }
            let settings = state.snapshot.document.settings
            var refreshedCommands: [JSONValue]?
            if commandItems.isEmpty || resolvedShortcuts != settings["shortcuts"] {
                refreshedCommands = try await bridge.call("settings.commands", params: .object(["settings": settings, "platform": .string("macos")])).array
            }
            guard epoch == loadEpoch, bridge === self.bridge, !shuttingDown else { return }
            // Publish the snapshot and its commands together, before notifying menu observers.
            // 同时发布快照及其命令，再通知菜单观察者。
            self.state = state
            if let refreshedCommands { commandItems = refreshedCommands; resolvedShortcuts = settings["shortcuts"] }
            let language = state.snapshot.document.settings["language"].string ?? "system"
            if NativeLocale.preference != language { NativeLocale.preference = language; languageChanged?() }
            if refreshedCommands != nil { commandsChanged?() }
            appearanceChanged?(settings["appearance"].string ?? "system")
            updates.apply(settings)
            breakSchedule.configure(enabled: settings["breakReminder"].bool == true, minutes: settings["breakInterval"].number ?? 60, now: ProcessInfo.processInfo.systemUptime)
            breakReminderVisible = breakSchedule.visible
            if breakTimer == nil && settings["breakReminder"].bool == true {
                breakTimer = Task { @MainActor [weak self] in
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .seconds(1)) } catch { return }
                        self?.tickBreakReminder(now: ProcessInfo.processInfo.systemUptime)
                    }
                }
            } else if settings["breakReminder"].bool != true { breakTimer?.cancel(); breakTimer = nil }
            let existing = Set(state.sessions.map { $0.session["id"].string ?? "" })
            agentNotifications.retain(existing)
            for (id, terminal) in terminals where !existing.contains(id) {
                _ = try await bridge.call("terminal.action", params: .object(["attachment": .string(terminal.attachment), "action": .string("detach")]))
                guard bridge === self.bridge, !shuttingDown else { return }
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
            // Background snapshots clear only their own read error, preserving the last failed operation.
            // 后台快照仅清除自身读取错误，保留最近操作的失败反馈。
            if let snapshotReadError, error == snapshotReadError { error = "" }
            snapshotReadError = nil
        } catch {
            if epoch == loadEpoch, bridge === self.bridge, !shuttingDown { snapshotReadError = error.localizedDescription; self.error = error.localizedDescription }
        }
    }

    @discardableResult
    func mutate(_ method: String, _ values: [String: JSONValue], revision: String? = nil) async -> Bool {
        guard !busy, !shuttingDown, !worktreeDeletionPresented, !gitFavoritesRecoveryPresented, let bridge, let state else { return false }
        let actionBridge: CoreBridge
        if method.hasPrefix("ssh."), !["ssh.quick.create", "ssh.quick.keep"].contains(method) {
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
                await self.reload(clearOperationError: true)
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

    func flushWorkspaceOperations() async {
        if let operation { _ = await operation.value }
    }

    func createQuickSSH(_ connection: JSONValue, workspaceID: String) async throws -> Bool {
        await flushWorkspaceOperations()
        guard !busy, !shuttingDown, groupID == workspaceID, let bridge, let sshBridge,
              let directory = environment["home"].string else { throw BridgeFailure(code: "CONFLICT", message: localized("Workspace changed. Reopen Quick SSH.", "工作区已变化，请重新打开快速 SSH。")) }
        let snapshot = try await bridge.snapshot()
        let id = UUID().uuidString
        guard await mutate("ssh.quick.create", ["connection": connection, "id": .string(id), "directory": .string(directory)], revision: snapshot.revision) else {
            throw BridgeFailure(code: "SSH_SAVE_FAILED", message: error.isEmpty ? localized("Could not save the connection.", "无法保存连接。") : error)
        }
        do {
            _ = try await sshBridge.call("ssh.session.start", params: .object(["id": .string(id)]))
            await reload()
        } catch {
            // Metadata is already committed; a transport failure must not invite duplicate creation.
            // 元数据已提交，传输失败不能引导用户重复创建连接。
            self.error = localized("Connection saved. SSH could not start: ", "连接已保存，SSH 无法启动：") + error.localizedDescription
        }
        return true
    }

    func keepQuickSSH(_ id: String) async {
        guard let bridge, !busy else { return }
        do {
            let snapshot = try await bridge.snapshot()
            _ = await mutate("ssh.quick.keep", ["id": .string(id)], revision: snapshot.revision)
        } catch { self.error = error.localizedDescription }
    }

    func cleanupQuickSSH() async {
        await flushWorkspaceOperations()
        guard !busy, !shuttingDown, canPruneQuickSSH?() != false, let bridge,
              groups.contains(where: { $0["sshConnections"].array.contains { $0["temporary"].bool == true && $0["sessions"].array.isEmpty } }) else { return }
        do {
            let snapshot = try await bridge.snapshot()
            _ = await mutate("ssh.quick.prune", [:], revision: snapshot.revision)
        } catch { self.error = error.localizedDescription }
    }

    func selectSession(_ id: String, focus: Bool = true) async {
        if focus { documents.showTerminal(in: inspectorContextKey); panels.showTerminal(in: inspectorContextKey) }
        if selectedID == id { if focus { focusRevision += 1 }; return }
        if let operation { _ = await operation.value }
        if await mutate("session.select", ["id": .string(id)]), focus { focusRevision += 1 }
    }

    func performControlAction(_ request: JSONValue) async throws -> JSONValue {
        guard !busy, !shuttingDown, !settingsPresented, !editorRecoveryPresented, !worktreeDeletionPresented, !gitFavoritesRecoveryPresented, !workspaceModalPresented, nameDraft == nil,
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
            await reload(clearOperationError: true)
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
            if await mutate("ssh.session.create", values) { documents.showTerminal(in: inspectorContextKey); panels.showTerminal(in: inspectorContextKey); focusRevision += 1 }
            else { let failure = error; await reload(); error = failure }
            return
        }
        if let agent { values["agent"] = .string(agent); values["projectId"] = .null }
        if await mutate("session.create", values) { documents.showTerminal(in: inspectorContextKey); panels.showTerminal(in: inspectorContextKey); focusRevision += 1 }
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

    func closeSession(id target: String? = nil) async {
        guard !busy, let id = target ?? selectedID, let terminal = terminals[id], let bridge else { return }
        let isSSH = sessionEntries.contains { $0.sessionID == id && $0.session["ssh"] != .null }
        if let operation { _ = await operation.value }
        do {
            await terminal.drainInput()
            await terminal.finishConnection()
            _ = try await bridge.call("host.close", params: .object(["id": .string(id), "generation": terminal.generation.map(JSONValue.string) ?? .null]))
            if await mutate("session.remove", ["id": .string(id)]) {
                focusRevision += 1
                if isSSH { await cleanupQuickSSH() }
            }
        } catch { self.error = error.localizedDescription }
    }

    func renameSession(_ id: String) {
        guard !busy, !gitFavoritesRecoveryPresented, let state,
              let entry = sessionEntries.first(where: { $0.sessionID == id }) else { return }
        let revision = state.snapshot.revision
        let alert = NSAlert()
        alert.messageText = localized("Rename session", "重命名会话")
        let field = NSTextField(string: entry.session["name"].string ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: localized("Save", "保存"))
        alert.addButton(withTitle: localized("Cancel", "取消"))
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task { await mutate("session.rename", ["id": .string(id), "name": .string(name)], revision: revision) }
    }

    func newWorkspace(owner: NameDraftOwner = .workspace) {
        guard nameDraft == nil, let state else { return }
        nameDraftOwner = owner
        if owner == .workspace { requestActivation?() }
        nameDraft = NameDraft(target: nil, name: "", revision: state.snapshot.revision)
    }

    var canRemoveWorkspace: Bool {
        canRemoveWorkspace(groupID)
    }
    func canRemoveWorkspace(_ id: String) -> Bool {
        guard groups.count > 1, !workspace["projects"].array.contains(where: { $0["workspaceId"].string == id }),
              let group = groups.first(where: { $0["id"].string == id }) else { return false }
        return ["terminals", "chats", "sshConnections", "databaseConnections", "redisConnections"].allSatisfy { group[$0].array.isEmpty }
    }

    func removeWorkspace(id target: String? = nil) {
        let id = target ?? groupID
        guard canRemoveWorkspace(id), !busy, let revision = state?.snapshot.revision else { return }
        let alert = NSAlert()
        alert.messageText = localized("Delete empty workspace?", "删除空工作区？")
        alert.informativeText = groups.first(where: { $0["id"].string == id })?["name"].string ?? ""
        alert.addButton(withTitle: localized("Delete workspace", "删除工作区"))
        alert.addButton(withTitle: localized("Cancel", "取消"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task { await mutate("workspace.remove", ["id": .string(id)], revision: revision) }
    }

    func renameProject(_ id: String) {
        guard !busy, let project = projects.first(where: { $0["id"].string == id }), let revision = state?.snapshot.revision else { return }
        let alert = NSAlert()
        alert.messageText = localized("Rename project", "重命名项目")
        let field = NSTextField(string: project["name"].string ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: localized("Save", "保存")); alert.addButton(withTitle: localized("Cancel", "取消"))
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task { await mutate("project.rename", ["id": .string(id), "name": .string(name)], revision: revision) }
    }

    @discardableResult
    func setProjectFlag(_ id: String, key: String, value: Bool, revision: String? = nil) async -> Bool {
        guard ["pinned", "collapsed"].contains(key), let state,
              case .object(var document) = workspace,
              let index = document["projects"]?.array.firstIndex(where: { $0["id"].string == id && $0["workspaceId"].string == groupID }),
              var projects = document["projects"]?.array, case .object(var project) = projects[index] else { return false }
        project[key] = .bool(value); projects[index] = .object(project); document["projects"] = .array(projects)
        return await mutate("snapshot.replace", ["workspace": .object(document), "settings": settings], revision: revision ?? state.snapshot.revision)
    }

    func projectOrderPeers(_ id: String) -> [String] {
        guard settings["projectOrder"].string != "name", let project = projects.first(where: { $0["id"].string == id }) else { return [] }
        return projects.filter { ($0["pinned"].bool == true) == (project["pinned"].bool == true) }.compactMap { $0["id"].string }
    }

    @discardableResult
    func moveProjectOrder(_ id: String, before target: String?, revision: String? = nil) async -> Bool {
        let peers = projectOrderPeers(id)
        guard peers.contains(id), target == nil || (target != id && peers.contains(target!)),
              case .object(var document) = workspace, var values = document["projects"]?.array else { return false }
        var reordered = peers.filter { $0 != id }
        reordered.insert(id, at: target.flatMap { reordered.firstIndex(of: $0) } ?? reordered.count)
        let originals = Dictionary(uniqueKeysWithValues: values.compactMap { project -> (String, JSONValue)? in
            guard let id = project["id"].string, peers.contains(id) else { return nil }
            return (id, project)
        })
        var next = 0
        for index in values.indices where values[index]["id"].string.map({ peers.contains($0) }) == true {
            values[index] = originals[reordered[next]]!; next += 1
        }
        document["projects"] = .array(values)
        return await mutate("snapshot.replace", ["workspace": .object(document), "settings": settings], revision: revision)
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

    func renameWorkspace(id target: String? = nil, owner: NameDraftOwner = .workspace) {
        let id = target ?? groupID
        guard nameDraft == nil, !busy, let state, let group = groups.first(where: { $0["id"].string == id }) else { return }
        nameDraftOwner = owner
        if owner == .workspace { requestActivation?() }
        nameDraft = NameDraft(target: id, name: group["name"].string ?? "", revision: state.snapshot.revision)
    }

    func saveNameDraft() async {
        guard !busy, let draft = nameDraft else { return }
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        // QA observes the complete naming action, including draft cleanup after the mutation task.
        // QA 观察完整命名动作，包含写入任务结束后的草稿清理。
        defer { qaNameSaveCompletions += 1 }
        let method = draft.target == nil ? "workspace.create" : "workspace.rename"
        if await mutate(method, ["id": .string(draft.target ?? draft.id.uuidString), "name": .string(name), "select": .bool(nameDraftOwner == .workspace)], revision: draft.revision) { nameDraft = nil }
    }

    func reloadNameDraft() async {
        await reload(clearOperationError: true)
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
                if self.helperReady { await self.reload(clearOperationError: true) }
                else { await bridge.close(); self.bridge = nil; await self.start() }
            } catch { self.error = error.localizedDescription }
        }
    }

    func shutdown() async {
        if let operation { _ = await operation.value }
        shuttingDown = true
        breakTimer?.cancel(); breakTimer = nil
        agentNotifications.retain([])
        stopSSHTrust()
        await stopControl()
        for terminal in terminals.values { terminal.cancelConnection() }
        for terminal in terminals.values { await terminal.drainInput() }
        events?.cancel()
        frames?.cancel()
        failures?.cancel()
        await sshBridge?.close()
        databaseHostCache?.shutdownEvents(); databaseHostCache = nil
        sshBridge = nil
        await bridge?.close()
        bridge = nil
    }

    func tickBreakReminder(now: TimeInterval) {
        breakSchedule.tick(now: now)
        if breakReminderVisible != breakSchedule.visible { breakReminderVisible = breakSchedule.visible }
    }
    func dismissBreakReminder() {
        breakSchedule.dismiss(now: ProcessInfo.processInfo.systemUptime)
        breakReminderVisible = false
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
