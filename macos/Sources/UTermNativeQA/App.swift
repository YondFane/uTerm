import AppKit
import SwiftUI
import UTermBridge

@MainActor
enum NativeLocale { static var preference = "system" }

@MainActor
func localized(_ english: String, _ chinese: String) -> String {
    let chinesePreferred = NativeLocale.preference == "zh-Hans" || (NativeLocale.preference == "system" && Locale.preferredLanguages.first?.hasPrefix("zh") == true)
    return chinesePreferred ? chinese : english
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation {
    private var window: NSWindow?
    private var contentWindows: [UUID: ContentWindow] = [:]
    private var fileClipboard: JSONValue = .null
    private var fileWindowOrder: [UUID] = []
    private var changingFileTabs = false
    private var pendingFileTabTrim = false
    private var previousFileTabLimit = 10
    private var pythonWindows: [String: PythonWindow] = [:]
    private var javaWindows: [String: JavaWindow] = [:]
    private var sshWindow: SSHWindow?
    private var agentsWindow: AgentSettingsWindow?
    private var fullSettingsWindow: NativeSettingsWindow?
    private var commandPalette: NativeCommandPalette?
    private let model = WorkspaceModel()
    private var terminating = false
    private var preparingQuit = false
    private var mutatingRepository = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        do { try NativeBundledFonts.register() }
        catch {
            let alert = NSAlert()
            alert.messageText = localized("Could not load the bundled terminal font. Reinstall the app.", "无法加载内置终端字体，请重新安装应用。")
            alert.informativeText = error.localizedDescription
            alert.runModal(); NSApp.terminate(nil); return
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = WorkspaceModel.applicationProfile.displayName
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 640, height: 420)
        window.delegate = self
        window.contentView = NSHostingView(rootView: WorkspaceView(model: model))
        window.center()
        self.window = window
        model.languageChanged = { [weak self] in
            self?.configureMenu()
            self?.sshWindow?.window?.title = localized("SSH connections", "SSH 连接")
            self?.sshWindow?.model.objectWillChange.send()
            self?.agentsWindow?.window.title = localized("Agent settings", "Agent 设置")
            self?.agentsWindow?.model.objectWillChange.send()
            self?.fullSettingsWindow?.window.title = localized("Settings", "设置")
            self?.fullSettingsWindow?.model.objectWillChange.send()
            self?.contentWindows.values.filter { $0.workbenchHost != nil }.forEach { $0.window?.title = nativeWorkbenchTitle($0.workbenchHost!.kind) }
        }
        model.requestActivation = { [weak window] in
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        model.appearanceChanged = { [weak self, weak window] appearance in
            let value = appearance == "dark" ? NSAppearance(named: .darkAqua) : appearance == "light" ? NSAppearance(named: .aqua) : nil
            window?.appearance = value; self?.sshWindow?.window?.appearance = value
            if let self {
                let opacity = self.model.settings["opacity"].number ?? 1
                window?.isOpaque = opacity >= 1 && self.model.settings["blur"].bool != true
                window?.backgroundColor = window?.isOpaque == true ? .windowBackgroundColor : .clear
                for run in self.pythonWindows.values { run.model.applySettings(self.model.settings, catalog: self.model.settingsCatalog); run.window?.appearance = value }
                for run in self.javaWindows.values { run.model.applySettings(self.model.settings, catalog: self.model.settingsCatalog); run.window?.appearance = value }
            }
            self?.agentsWindow?.window.appearance = value
            self?.fullSettingsWindow?.window.appearance = value
            if let self {
                let limit = self.model.settings["fileTabLimit"].number.flatMap { Int(exactly: $0) } ?? 10
                if limit != self.previousFileTabLimit {
                    self.previousFileTabLimit = limit; self.pendingFileTabTrim = true
                    Task { await self.trimFileTabs() }
                }
                for content in self.contentWindows.values {
                    content.window?.appearance = value
                    content.workbenchHost?.settingsChanged(self.model.settings)
                    content.settingsChanged(self.model.settings)
                }
            }
        }
        model.deleteWorktreeRequested = { [weak self] project, tree in self?.confirmWorktreeDeletion(projectID: project, worktreeID: tree) }
        model.openSSHRequested = { [weak self] id in Task { @MainActor in try? await self?.makeSSHWindow(selected: id) } }
        model.openQuickSSHRequested = { [weak self] in
            Task { @MainActor in
                do { _ = try await self?.makeQuickSSHWindow() }
                catch { self?.model.error = error.localizedDescription }
            }
        }
        model.canPruneQuickSSH = { [weak self] in self?.sshWindow?.model.dirty != true && self?.sshWindow?.model.busy != true }
        model.openDatabasesRequested = { [weak self] in self?.openDatabases() }
        model.openRedisRequested = { [weak self] in self?.openRedis() }
        model.openAgentsRequested = { [weak self] in self?.openAgents() }
        model.openSettingsRequested = { [weak self] in self?.openFullSettings() }
        model.openFileRequested = { [weak self] in self?.openFile() }
        model.performCommandRequested = { [weak self] in self?.performCommand($0) }
        model.commandIsAvailable = { [weak self] in self?.commandAvailable($0) == true }
        model.openJavaRequested = { [weak self] in self?.openJava() }
        model.openPythonRequested = { [weak self] in self?.openPython() }
        model.openGitRequested = { [weak self] in self?.openGit() }
        model.openGitHubRequested = { [weak self] in self?.openGitHub() }
        model.makeGitHubTools = { [weak self] root, scope in
            guard let self, self.model.inspectorContextKey == scope else { throw BridgeFailure(code: "CONFLICT", message: "GitHub tools no longer own the selected project") }
            return try await self.makeGitHubContentWindow(directory: root, present: false)
        }
        model.makeFileTools = { [weak self] root, scope in
            guard let self else { throw BridgeFailure(code: "CLOSED", message: "Client is closed") }
            return try await self.makeFileToolsWindow(directory: root, scope: scope)
        }
        model.openInspectorFile = { [weak self] directory, path, line in
            guard let self else { throw BridgeFailure(code: "CLOSED", message: "Client is closed") }
            let root = try await self.selectedProjectDirectory()
            guard root.standardizedFileURL.resolvingSymlinksInPath() == URL(fileURLWithPath: directory).standardizedFileURL.resolvingSymlinksInPath() else { throw BridgeFailure(code: "CONFLICT", message: localized("Project selection changed. Search again.", "项目选择已变化，请重新搜索。")) }
            guard let bridge = self.model.bridge else { throw BridgeFailure(code: "CLOSED", message: "Client is closed") }
            _ = try await bridge.call("files.read", params: .object(["directory": .string(root.path), "path": .string(path)]))
            guard try await self.selectedProjectDirectory() == root else { throw BridgeFailure(code: "CONFLICT", message: localized("Project selection changed. Search again.", "项目选择已变化，请重新搜索。")) }
            let content = try await self.makeEditableContentWindow(directory: root, path: path)
            if line > 0 { content.focusFileLine(line) }
        }
        model.commandsChanged = { [weak self] in self?.configureMenu() }
        model.prepareSSHTransportReconnect = { [weak self] in
            guard let current = self?.sshWindow else { return true }
            guard await current.model.prepareForQuit() else { return false }
            await current.forceClose(); return true
        }
        configureMenu()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task { @MainActor in
            await model.start()
            if let path = UpdatesSmoke.reportPath {
                var report = baseReport()
                do {
                    if Bundle.main.object(forInfoDictionaryKey: "UTermUpdateTestMode") as? String == "install" {
                        try await UpdateInstallationSmoke.run(model: model, window: window,
                            openFile: { directory, path in try await self.makeEditableContentWindow(directory: directory, path: path, embedded: false) },
                            openSSH: { try await self.makeSSHWindow() }, openDatabase: { try await self.makeDatabaseWindow() },
                            attemptQuit: { _ = self.applicationShouldTerminate(NSApp) }, report: &report)
                    } else { try await UpdatesSmoke.run(model: model, window: window, report: &report) }
                }
                catch { report["failure"] = error.localizedDescription }
                // Installation already closes its fixture host; querying it again races shutdown or restarts it.
                // 安装检查已关闭自己的样例宿主，再次查询会与退出竞争或重新启动宿主。
                if report["explicitFixtureCloseAndIdleHostShutdown"] as? Bool != true, let bridge = model.bridge {
                    do {
                        for session in try await bridge.call("host.status")["sessions"].array { _ = try await bridge.call("host.close", params: .object(["id": session["spec"]["id"], "generation": session["generation"]])) }
                        _ = try await bridge.call("host.shutdownIdle")
                    } catch { report["cleanupError"] = error.localizedDescription }
                }
                await model.shutdown(); terminating = true
                finishReport(report, path: path); return
            }
            #if UTERM_PERSONAL
            if WorkspaceModel.applicationProfile.personalFixture {
                await PersonalSmoke.run(model: model, window: window, openSettings: { self.openFullSettings(); return self.fullSettingsWindow! }, openFile: { directory, path in try await self.makeEditableContentWindow(directory: directory, path: path) })
                terminating = true
                NSApp.terminate(nil)
            }
            #else
            if let path = WorkspaceModel.argument("--transition-smoke-report") {
                var report = baseReport()
                do { try await TransitionSmoke.run(model: model, window: window, openFile: { directory, path in try await self.makeEditableContentWindow(directory: directory, path: path, embedded: false) }, report: &report) }
                catch { report["failure"] = error.localizedDescription }
                let checkpoint = WorkspaceModel.argument("--transition-smoke-phase") == "checkpoint" && report["failure"] == nil
                if !checkpoint {
                    for content in Array(contentWindows.values) { content.forceClose() }
                    await model.shutdown(); terminating = true
                }
                finishReport(report, path: path, keepRunning: checkpoint)
                return
            }
            if let path = WorkspaceModel.argument("--performance-smoke-report") {
                var report = baseReport()
                do { try await PerformanceSmoke.run(model: model, window: window, report: &report) }
                catch { report["failure"] = error.localizedDescription }
                if report["explicitCloseAndIdleHostShutdown"] as? Bool != true, let bridge = model.bridge {
                    do {
                        for session in try await bridge.call("host.status")["sessions"].array { _ = try await bridge.call("host.close", params: .object(["id": session["spec"]["id"], "generation": session["generation"]])) }
                        _ = try await bridge.call("host.shutdownIdle")
                    } catch { report["cleanupError"] = error.localizedDescription }
                }
                await model.shutdown(); terminating = true
                finishReport(report, path: path); return
            }
            if let path = WorkspaceModel.argument("--candidate-smoke-report") {
                var report = baseReport()
                do { try await CandidateSmoke.run(model: model, window: window, report: &report) }
                catch {
                    report["failure"] = error.localizedDescription
                    try? await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("candidate-installed-native-failure.png"))
                }
                if report["explicitFixtureCloseAndIdleHostShutdown"] as? Bool != true, let bridge = model.bridge {
                    do {
                        for session in try await bridge.call("host.status")["sessions"].array { _ = try await bridge.call("host.close", params: .object(["id": session["spec"]["id"], "generation": session["generation"]])) }
                        _ = try await bridge.call("host.shutdownIdle")
                    } catch { report["cleanupError"] = error.localizedDescription }
                }
                await model.shutdown(); terminating = true
                finishReport(report, path: path); return
            }
            if let path = WorkspaceModel.argument("--github-smoke-report") {
                var report = baseReport()
                do { try await GitHubSmoke.run(model: model, parent: window, open: { try await self.makeGitHubContentWindow(directory: $0) }, report: &report) }
                catch {
                    report["failure"] = error.localizedDescription
                    if let current = contentWindows.values.first(where: { $0.workbenchHost?.kind == "github" })?.window { try? await TerminalSmoke.capture(window: current, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("native-github-failure.png")) }
                }
                for content in Array(contentWindows.values) { content.forceClose() }
                if report["explicitFixtureCloseAndIdleHostShutdown"] as? Bool != true, let bridge = model.bridge {
                    do {
                        for session in try await bridge.call("host.status")["sessions"].array { _ = try await bridge.call("host.close", params: .object(["id": session["spec"]["id"], "generation": session["generation"]])) }
                        _ = try await bridge.call("host.shutdownIdle")
                    } catch { report["cleanupError"] = error.localizedDescription }
                }
                await model.shutdown(); terminating = true
                finishReport(report, path: path); return
            }
            if let path = WorkspaceModel.argument("--inspector-smoke-report") {
                var report = baseReport()
                do { try await InspectorSmoke.run(model: model, window: window, lookup: { self.existingContent(directory: $0, path: $1, editable: true) }, quickLookup: { self.contentWindows.values.first { $0.workbenchHost?.kind == "ssh-quick" } }, report: &report) }
                catch {
                    report["failure"] = error.localizedDescription
                    try? await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("native-inspector-failure.png"))
                }
                for content in Array(contentWindows.values) { content.forceClose() }
                if report["explicitFixtureCloseAndIdleHostShutdown"] as? Bool != true, let bridge = model.bridge {
                    do {
                        for session in try await bridge.call("host.status")["sessions"].array { _ = try await bridge.call("host.close", params: .object(["id": session["spec"]["id"], "generation": session["generation"]])) }
                        _ = try await bridge.call("host.shutdownIdle")
                    } catch { report["cleanupError"] = error.localizedDescription }
                }
                await model.shutdown(); terminating = true
                finishReport(report, path: path); return
            }
            if let path = WorkspaceModel.argument("--settings-smoke-report") {
                var report = baseReport()
                do {
                    try await SettingsSmoke.run(workspace: model, open: { self.openFullSettings(); return self.fullSettingsWindow! }, report: &report)
                    try await PreferencesSmoke.run(workspace: model, parent: window, openFile: { directory, path in try await self.makeEditableContentWindow(directory: directory, path: path, embedded: false) }, report: &report)
                }
                catch {
                    report["failure"] = error.localizedDescription
                    if let current = fullSettingsWindow {
                        try? await TerminalSmoke.capture(window: current.window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("native-settings-full-failure.png"))
                        await current.model.reload()
                    }
                    if let current = NSApp.keyWindow { try? await TerminalSmoke.capture(window: current, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("native-settings-active-failure.png")) }
                }
                for content in Array(contentWindows.values) { content.forceClose() }
                await model.shutdown()
                if report["failure"] != nil { terminating = true }
                finishReport(report, path: path); return
            }
            if let path = WorkspaceModel.argument("--agent-smoke-report") {
                var report = baseReport()
                do { try await AgentSmoke.run(model: model, open: { self.openAgents(); return self.agentsWindow! }, report: &report) }
                catch {
                    report["failure"] = error.localizedDescription
                    if let current = agentsWindow?.window {
                        try? await TerminalSmoke.capture(window: current, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("native-agent-failure.png"))
                    }
                }
                if let bridge = model.bridge {
                    do {
                        for session in try await bridge.call("host.status")["sessions"].array {
                            _ = try await bridge.call("host.close", params: .object(["id": session["spec"]["id"], "generation": session["generation"]]))
                        }
                        _ = try await bridge.call("host.shutdownIdle")
                    } catch { report["cleanupError"] = error.localizedDescription }
                }
                await model.shutdown()
                finishReport(report, path: path)
                return
            }
            if let path = WorkspaceModel.argument("--redis-smoke-report") {
                var report = baseReport()
                do { try await RedisSmoke.run(model: model, open: { try await self.makeRedisWindow() }, lookup: { self.contentWindows.values.first { $0.workbenchHost?.kind == "redis" } }, report: &report) }
                catch {
                    report["failure"] = error.localizedDescription
                    if let content = contentWindows.values.first(where: { $0.workbenchHost?.kind == "redis" }), let window = content.window {
                        try? await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("native-redis-failure.png"))
                    }
                }
                for content in Array(contentWindows.values) { content.forceClose() }
                await model.sshBridge?.close()
                if let bridge = model.bridge {
                    do { _ = try await bridge.call("host.shutdownIdle") }
                    catch { report["cleanupError"] = error.localizedDescription }
                }
                await model.shutdown()
                finishReport(report, path: path)
                return
            }
            if let path = WorkspaceModel.argument("--database-smoke-report") {
                var report = baseReport()
                do { try await DatabaseSmoke.run(model: model, open: { try await self.makeDatabaseWindow() }, lookup: { self.contentWindows.values.first { $0.workbenchHost?.kind == "database" } }, report: &report) }
                catch {
                    report["failure"] = error.localizedDescription
                    if let content = contentWindows.values.first(where: { $0.workbenchHost?.kind == "database" }), let window = content.window {
                        try? await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("native-database-failure.png"))
                    }
                }
                for content in Array(contentWindows.values) { content.forceClose() }
                await model.sshBridge?.close()
                if let bridge = model.bridge {
                    do { _ = try await bridge.call("host.shutdownIdle") }
                    catch { report["cleanupError"] = error.localizedDescription }
                }
                await model.shutdown()
                finishReport(report, path: path)
                return
            }
            if let path = WorkspaceModel.argument("--ssh-smoke-report") {
                var report = baseReport()
                do { try await SSHSmoke.run(model: model, open: { try await self.makeSSHWindow() }, lookup: { self.sshWindow }, report: &report) }
                catch {
                    report["failure"] = error.localizedDescription
                    if let current = sshWindow?.window {
                        try? await TerminalSmoke.capture(window: current, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("native-ssh-failure.png"))
                    }
                }
                if let current = model.bridge {
                    do {
                        for prompt in try await current.call("ssh.trust.pending").array {
                            _ = try await current.call("ssh.trust.confirm", params: .object(["id": prompt["id"], "approve": .bool(false)]))
                        }
                        let status = try await current.call("host.status")
                        for session in status["sessions"].array {
                            _ = try await current.call("host.close", params: .object(["id": session["spec"]["id"], "generation": session["generation"]]))
                        }
                        _ = try await current.call("host.shutdownIdle")
                    } catch { report["cleanupError"] = error.localizedDescription }
                }
                await model.shutdown()
                await sshWindow?.forceClose()
                finishReport(report, path: path)
                return
            }
            if let path = WorkspaceModel.argument("--java-smoke-report") {
                var report = baseReport()
                do {
                    try await JavaSmoke.run(model: model, open: { try await self.makeJavaWindow(directory: $0) }, lookup: { self.javaWindows[$0] }, report: &report)
                } catch {
                    report["failure"] = error.localizedDescription
                    if let current = javaWindows.values.first?.window {
                        let name = "native-java-failure.png"
                        try? await TerminalSmoke.capture(window: current, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name))
                        report["failureCapture"] = name
                    }
                }
                if let cleanup = model.bridge, let sharedRoot = try? WorkspaceModel.dataRoot() {
                    let directory = sharedRoot.deletingLastPathComponent().appendingPathComponent("java-project 中文").path
                    do {
                        let tasks = try await cleanup.call("java.tasks", params: .object(["directory": .string(directory)]))
                        for task in tasks.array where task["running"].bool == true {
                            _ = try await cleanup.call("java.stop", params: .object(["id": task["spec"]["id"], "generation": task["generation"], "force": .bool(true)]))
                        }
                        var running = false
                        for _ in 0..<100 {
                            running = try await cleanup.call("java.tasks", params: .object(["directory": .string(directory)])).array.contains { $0["running"].bool == true }
                            if !running { break }
                            try await Task.sleep(for: .milliseconds(50))
                        }
                        if running { throw BridgeFailure(code: "JAVA_QA_CLEANUP", message: "Disposable Java task did not stop") }
                        if FileManager.default.fileExists(atPath: sharedRoot.deletingLastPathComponent().appendingPathComponent("local-daemon-v1/endpoint.json").path) {
                            _ = try await cleanup.call("host.shutdownIdle")
                        }
                    } catch { report["cleanupError"] = error.localizedDescription }
                }
                for run in Array(javaWindows.values) { run.model.dirty = false; await run.forceClose() }
                finishReport(report, path: path)
                return
            }
            if let path = WorkspaceModel.argument("--python-smoke-report") {
                var report = baseReport()
                do {
                    try await PythonSmoke.run(model: model, open: { try await self.makePythonWindow(directory: $0) }, lookup: { self.pythonWindows[$0] }, report: &report)
                } catch { report["failure"] = error.localizedDescription }
                for run in Array(pythonWindows.values) {
                    if let tasks = try? await run.model.bridge.call("python.tasks", params: .object(["directory": .string(run.model.directory)])) {
                        for task in tasks.array where task["running"].bool == true {
                            _ = try? await run.model.bridge.call("python.stop", params: .object(["id": task["spec"]["id"], "generation": task["generation"], "force": .bool(true)]))
                        }
                        for _ in 0..<100 {
                            let current = try? await run.model.bridge.call("python.tasks", params: .object(["directory": .string(run.model.directory)]))
                            if current?.array.contains(where: { $0["running"].bool == true }) == false { break }
                            try? await Task.sleep(for: .milliseconds(50))
                        }
                        if let root = try? WorkspaceModel.dataRoot(), FileManager.default.fileExists(atPath: root.deletingLastPathComponent().appendingPathComponent("local-daemon-v1/endpoint.json").path) {
                            do { _ = try await run.model.bridge.call("host.shutdownIdle") }
                            catch { report["cleanupError"] = error.localizedDescription }
                        }
                    }
                    run.model.dirty = false
                    await run.forceClose()
                }
                finishReport(report, path: path)
                return
            }
            if let path = WorkspaceModel.argument("--git-smoke-report") {
                var report = baseReport()
                do { try await GitSmoke.run(model: model, parent: window, open: { directory in try await self.makeGitContentWindow(directory: directory) }, openFile: { directory, path in try await self.makeEditableContentWindow(directory: directory, path: path, embedded: false) }, report: &report) }
                catch { report["failure"] = error.localizedDescription }
                finishReport(report, path: path)
                return
            }
            if let path = WorkspaceModel.argument("--editor-smoke-report") {
                var report = baseReport()
                do { try await EditorSmoke.run(model: model, parent: window, open: { directory, path in try await self.makeEditableContentWindow(directory: directory, path: path, embedded: false) }, lookup: { directory, path in self.existingContent(directory: directory, path: path, editable: true) }, report: &report) }
                catch { report["failure"] = error.localizedDescription }
                finishReport(report, path: path, keepRunning: WorkspaceModel.argument("--editor-smoke-phase") == "checkpoint" && report["failure"] == nil)
                return
            }
            if let path = WorkspaceModel.argument("--control-smoke-report") {
                var report = baseReport()
                do { try await ControlSmoke.run(model: model, window: window, report: &report) }
                catch { report["failure"] = error.localizedDescription }
                finishReport(report, path: path)
            }
            if let report = WorkspaceModel.argument("--content-smoke-report") {
                var result = baseReport()
                do { try await ContentSmoke.run(model: model, open: { directory, path in try self.makeContentWindow(directory: directory, path: path) }, report: &result) }
                catch { result["failure"] = error.localizedDescription }
                finishReport(result, path: report)
            }
            if let report = WorkspaceModel.argument("--smoke-report") {
                try? await Task.sleep(for: .milliseconds(150))
                await writeSmokeReport(report)
            }
            if let report = WorkspaceModel.argument("--terminal-smoke-report") { await runTerminalSmoke(report, reconnect: false) }
            if let report = WorkspaceModel.argument("--terminal-reconnect-report") { await runTerminalSmoke(report, reconnect: true) }
            if let path = WorkspaceModel.argument("--input-control-report") {
                var result = baseReport()
                do { try await InputControlSmoke.run(model: model, window: window, report: &result) }
                catch {
                    result["failure"] = error.localizedDescription
                    result["terminalDiagnostics"] = model.terminals.values.map { ["id": $0.id, "generation": $0.generation ?? "", "error": $0.error, "inputOwned": $0.inputControl?.owned ?? false, "renderedFrames": $0.qaRenderedFrames] as [String: Any] }
                }
                finishReport(result, path: path)
            }
            #endif
        }
    }

    private func configureMenu() {
        let main = NSMenu()
        func menu(_ title: String) -> NSMenu {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let submenu = NSMenu(title: title)
            item.submenu = submenu
            main.addItem(item)
            return submenu
        }
        func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: modifiers.contains(.shift) ? key.uppercased() : key)
            item.keyEquivalentModifierMask = modifiers
            item.target = self
            menu.addItem(item)
        }
        let app = menu(WorkspaceModel.applicationProfile.displayName)
        add(app, localized("Settings…", "设置…"), #selector(settings), ",")
        if model.updates.controlsVisible { add(app, localized("Check for updates…", "检查更新…"), #selector(checkForUpdates)) }
        app.addItem(.separator())
        add(app, localized("Quit ", "退出 ") + WorkspaceModel.applicationProfile.displayName, #selector(quit), "q")
        let file = menu(localized("File", "文件"))
        add(file, localized("Open project…", "打开项目…"), #selector(openProject), "o")
        add(file, localized("Open file…", "打开文件…"), #selector(openFile), "o", [.command, .shift])
        add(file, "Git…", #selector(openGit))
        add(file, localized("Databases…", "数据库…"), #selector(openDatabases))
        add(file, localized("Redis connections…", "Redis 连接…"), #selector(openRedis))
        add(file, localized("Java build and run…", "Java 构建与运行…"), #selector(openJava))
        add(file, localized("Python run…", "Python 运行…"), #selector(openPython))
        add(file, localized("SSH connections…", "SSH 连接…"), #selector(openSSH))
        add(file, localized("Recover editor drafts…", "恢复编辑器草稿…"), #selector(recoverEditorDrafts))
        add(file, localized("Restore editor recovery copy…", "恢复编辑器备份副本…"), #selector(restoreEditorRecovery))
        add(file, localized("Recover Git favorites…", "恢复 Git 收藏…"), #selector(recoverGitFavorites))
        add(file, localized("New workspace…", "新建工作区…"), #selector(newWorkspace), "n", [.command, .shift])
        add(file, localized("New terminal", "新建终端"), #selector(newTerminal), "t")
        add(file, localized("New Agent session", "新建 Agent 会话"), #selector(newAgent), "n")
        add(file, localized("Agent settings…", "Agent 设置…"), #selector(openAgents))
        add(file, localized("All settings…", "全部设置…"), #selector(openFullSettings))
        file.addItem(.separator())
        add(file, localized("Close session", "关闭会话"), #selector(closeSession), "w")
        let edit = menu(localized("Edit", "编辑"))
        for (title, action, key) in [(localized("Copy", "复制"), #selector(NSText.copy(_:)), "c"), (localized("Paste", "粘贴"), #selector(NSText.paste(_:)), "v"), (localized("Select all", "全选"), #selector(NSText.selectAll(_:)), "a")] {
            edit.addItem(withTitle: title, action: action, keyEquivalent: key)
        }
        let view = menu(localized("View", "显示"))
        add(view, localized("Toggle sidebar", "显示或隐藏侧栏"), #selector(toggleSidebar), "s", [.command, .control])
        add(view, localized("Split right", "向右分屏"), #selector(splitRight), "d")
        add(view, localized("Split down", "向下分屏"), #selector(splitDown), "d", [.command, .shift])
        add(view, localized("Increase font size", "增大字号"), #selector(increaseFont), "=")
        add(view, localized("Decrease font size", "减小字号"), #selector(decreaseFont), "-")
        let managed: Set<String> = ["settings", "openFullSettings", "openProject", "openFile", "newTerminal", "newAgent", "openAgents", "openGit", "closeSession", "toggleSidebar", "splitRight", "splitDown", "increaseFont", "decreaseFont"]
        for submenu in main.items.compactMap(\.submenu) {
            for item in submenu.items where item.action.map(NSStringFromSelector).map(managed.contains) == true { item.keyEquivalent = "" }
        }
        let commands = menu(localized("Commands", "命令"))
        for command in model.commandItems {
            let item = NSMenuItem(title: localized(command["labels"]["en"].string ?? "", command["labels"]["zh-Hans"].string ?? ""), action: #selector(performSemanticCommand(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = command["id"].string
            NativeCommandKey.apply(command["shortcut"].string ?? "", to: item)
            commands.addItem(item)
        }
        let windows = menu(localized("Window", "窗口"))
        windows.addItem(withTitle: localized("Minimize", "最小化"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        add(windows, localized("Close window", "关闭窗口"), #selector(hideWindow), "w", [.command, .shift])
        let fullScreen = windows.addItem(withTitle: localized("Enter full screen", "进入全屏"), action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        let occupied = Set(commands.items.filter { !$0.keyEquivalent.isEmpty }.map { $0.keyEquivalent + String($0.keyEquivalentModifierMask.rawValue) })
        for submenu in main.items.compactMap(\.submenu) where submenu !== commands {
            for item in submenu.items where !item.keyEquivalent.isEmpty && occupied.contains(item.keyEquivalent + String(item.keyEquivalentModifierMask.rawValue)) { item.keyEquivalent = "" }
        }
        NSApp.mainMenu = main
        NSApp.windowsMenu = windows
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if preparingQuit || mutatingRepository || model.editorRecoveryPresented || model.worktreeDeletionPresented || model.gitFavoritesRecoveryPresented { return false }
        if model.workspaceModalContent != nil {
            if menuItem.action == #selector(quit) { return true }
            if menuItem.action == #selector(closeSession) { menuItem.title = localized("Close dialog", "关闭对话框"); return !model.workspaceModalPending }
            if menuItem.action != #selector(performSemanticCommand(_:)) { return false }
        }
        if menuItem.action == #selector(performSemanticCommand(_:)) { return (menuItem.representedObject as? String).map(commandAvailable) == true }
        if menuItem.action == #selector(closeSession) {
            if let fullSettingsWindow, fullSettingsWindow.window === NSApp.keyWindow {
                menuItem.title = localized("Close window", "关闭窗口")
                return !fullSettingsWindow.model.frozen
            }
            if let agentsWindow, agentsWindow.window === NSApp.keyWindow {
                menuItem.title = localized("Close window", "关闭窗口")
                return !agentsWindow.model.frozen
            }
            if let sshWindow, sshWindow.window === NSApp.keyWindow {
                menuItem.title = localized("Close window", "关闭窗口")
                return !sshWindow.model.prepared
            }
            if let run = javaWindows.values.first(where: { $0.window === NSApp.keyWindow }) {
                menuItem.title = localized("Close window", "关闭窗口")
                return !run.model.busy && !run.model.prepared
            }
            if let run = pythonWindows.values.first(where: { $0.window === NSApp.keyWindow }) {
                menuItem.title = localized("Close window", "关闭窗口")
                return !run.model.busy && !run.model.prepared
            }
            let fileFocused = contentWindows.values.contains { $0.window === NSApp.keyWindow } || (NSApp.keyWindow === window && !model.inspectorOwnsFocus && model.documents.active(in: model.inspectorContextKey) != nil)
            menuItem.title = fileFocused ? localized("Close file", "关闭文件") : model.inspectorOwnsFocus ? localized("Close tools", "关闭工具") : localized("Close session", "关闭会话")
            if fileFocused { return true }
            if model.inspectorOwnsFocus { return true }
        }
        if contentWindows.values.contains(where: { $0.window === NSApp.keyWindow }) || agentsWindow?.window === NSApp.keyWindow || fullSettingsWindow?.window === NSApp.keyWindow, let action = menuItem.action,
           [#selector(splitRight), #selector(splitDown)].contains(action) { return false }
        if menuItem.action == #selector(increaseFont) { return commandAvailable("fontIncrease") }
        if menuItem.action == #selector(decreaseFont) { return commandAvailable("fontDecrease") }
        if menuItem.action == #selector(quit) || menuItem.action == #selector(hideWindow) { return true }
        if model.nameDraft != nil || model.settingsPresented { return false }
        if menuItem.action == #selector(settings) { return model.state != nil }
        if menuItem.action == #selector(closeSession) || menuItem.action == #selector(splitRight) || menuItem.action == #selector(splitDown) { return model.selectedID != nil && !model.busy }
        return model.ready && !model.busy
    }

    @objc private func toggleSidebar() { model.sidebarVisible.toggle() }
    @objc private func settings() { openFullSettings() }
    @objc private func checkForUpdates() {
        model.updates.check()
        if !model.updates.error.isEmpty {
            let alert = NSAlert(); alert.messageText = localized("Could not check for updates", "无法检查更新")
            alert.informativeText = model.updates.error
            alert.addButton(withTitle: localized("OK", "好")); alert.runModal()
        }
    }
    private func commandAvailable(_ id: String) -> Bool {
        guard model.ready, !model.busy, !preparingQuit, !mutatingRepository, model.nameDraft == nil, NSApp.modalWindow == nil, NSApp.keyWindow?.sheetParent == nil else { return false }
        if model.workspaceModalContent != nil { return id == "close" && NSApp.keyWindow === window && !model.workspaceModalPending }
        let origin = NSApp.keyWindow === commandPalette?.window ? commandPalette?.returnWindow : NSApp.keyWindow
        // Settings blocks external writes, while commands owned by that window remain available.
        // 设置窗口阻止外部写入，但属于该窗口的命令仍可使用。
        let settingsOrigin = fullSettingsWindow.map { $0.window === origin && $0.window.isVisible && !$0.model.frozen } == true
        guard !model.settingsPresented || settingsOrigin else { return false }
        if ["palette", "settings", "project", "agents", "nextWorkspace", "previousWorkspace"].contains(id) { return true }
        if id == "close", NSApp.keyWindow === commandPalette?.window { return true }
        if id == "close" {
            if origin === window { return model.inspectorOwnsFocus || model.selectedID != nil || model.documents.active(in: model.inspectorContextKey) != nil }
            return origin != nil && (origin === commandPalette?.window || origin === fullSettingsWindow?.window || origin === agentsWindow?.window || origin === sshWindow?.window || contentWindows.values.contains { $0.window === origin } || pythonWindows.values.contains { $0.window === origin } || javaWindows.values.contains { $0.window === origin })
        }
        if ["fontIncrease", "fontDecrease"].contains(id) {
            if let content = focusedContent(in: origin) { return content.workbenchHost == nil }
            return origin === window && model.selectedTerminal != nil && !model.inspectorOwnsFocus
        }
        if id == "git", contentWindows.values.contains(where: { $0.gitMode && $0.window === origin }) { return true }
        if id == "github", contentWindows.values.contains(where: { $0.workbenchHost?.kind == "github" && $0.window === origin }) { return true }
        guard origin === window else { return false }
        if id == "terminalSearch", model.documents.active(in: model.inspectorContextKey) != nil { return false }
        if ["terminal", "chat", "toggleSidebar", "toggleInspector"].contains(id) { return true }
        if ["quick", "git", "github", "files", "search"].contains(id) { return model.workspace["selectedProject"].string != nil }
        if id == "swapPanes" { return model.inspectorVisible }
        if id == "zoom" { return model.selectedTerminal != nil && (model.paneZoomed || model.state?.layout["kind"].string == "split") }
        return model.selectedTerminal != nil
    }
    @objc private func performSemanticCommand(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        performCommand(id)
    }
    private func performCommand(_ id: String) {
        guard commandAvailable(id) else { NSSound.beep(); return }
        if NSApp.keyWindow === commandPalette?.window, id != "palette" {
            commandPalette?.dismiss()
            if id == "close" { return }
        }
        switch id {
        case "palette":
            if commandPalette == nil { commandPalette = NativeCommandPalette() }
            commandPalette?.open(commands: model.commandItems, available: { [weak self] in self?.commandAvailable($0) == true }, perform: { [weak self] in self?.performCommand($0) })
        case "settings": openFullSettings()
        case "project": openProject()
        case "terminal": newTerminal()
        case "chat": newAgent()
        case "quick": model.showInspector(.quick)
        case "files": if model.inspectorVisible && model.inspector.mode == .files { model.hideInspector() } else { model.showInspector(.files) }
        case "search": model.showInspector(.search)
        case "toggleInspector": if model.inspectorVisible { model.hideInspector() } else { model.showInspector(model.inspector.mode) }
        case "swapPanes": Task { await model.mutate("settings.patch", ["patch": .object(["inspectorPosition": .string(model.settings["inspectorPosition"].string == "left" ? "right" : "left")])]) }
        case "zoom": model.paneZoomed.toggle()
        case "git": if let current = contentWindows.values.first(where: { $0.gitMode && $0.window === NSApp.keyWindow }) { current.window?.orderOut(nil) } else { openGit() }
        case "github": if model.inspectorVisible && model.inspector.mode == .github { model.hideInspector() } else { openGitHub() }
        case "agents": openAgents()
        case "toggleSidebar": toggleSidebar()
        case "splitRight": splitRight()
        case "splitDown": splitDown()
        case "close": closeSession()
        case "fontIncrease": increaseFont()
        case "fontDecrease": decreaseFont()
        case "ungroup": if let id = model.selectedID { let revision = model.state?.snapshot.revision; Task { await model.ungroupSession(id, revision: revision) } }
        case "link":
            if let id = model.selectedID?.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")) {
                NSPasteboard.general.clearContents(); NSPasteboard.general.setString("uterm://session/" + id, forType: .string)
            }
        case "terminalSearch":
            if let session = model.selectedTerminal {
                session.search.open()
            }
        case "next", "previous":
            let selected = model.sessionEntries.first { $0.sessionID == model.selectedID }
            let entries = model.sessionEntries.filter { $0.rosterId == selected?.rosterId && $0.session["worktreeId"] == selected?.session["worktreeId"] }
            if let index = entries.firstIndex(where: { $0.sessionID == model.selectedID }), !entries.isEmpty {
                let next = entries[(index + (id == "next" ? 1 : -1) + entries.count) % entries.count].sessionID
                Task { await model.selectSession(next) }
            }
        case "nextWorkspace", "previousWorkspace":
            let groups = model.groupItems
            if let index = groups.firstIndex(where: { $0.id == model.groupID }), !groups.isEmpty {
                let next = groups[(index + (id == "nextWorkspace" ? 1 : -1) + groups.count) % groups.count].id
                Task { await model.mutate("workspace.switch", ["id": .string(next)]) }
            }
        case "left", "right", "up", "down": focusPane(id)
        default: break
        }
    }
    private func focusPane(_ direction: String) {
        guard let selected = model.selectedTerminal else { return }
        let origin = selected.view.convert(selected.view.bounds, to: nil)
        let candidates = model.terminals.values.compactMap { terminal -> (String, CGFloat)? in
            guard terminal.id != selected.id, terminal.view.window === window, !terminal.view.isHiddenOrHasHiddenAncestor else { return nil }
            let rect = terminal.view.convert(terminal.view.bounds, to: nil)
            let dx = rect.midX - origin.midX, dy = rect.midY - origin.midY
            let primary = direction == "left" ? -dx : direction == "right" ? dx : direction == "up" ? dy : -dy
            guard primary > 1 else { return nil }
            return (terminal.id, primary + abs(direction == "left" || direction == "right" ? dy : dx) * 2)
        }
        if let next = candidates.min(by: { $0.1 < $1.1 }) { Task { await model.selectSession(next.0) } }
    }
    @objc private func openFullSettings() {
        if fullSettingsWindow == nil { fullSettingsWindow = NativeSettingsWindow(workspace: model) }
        fullSettingsWindow?.window.appearance = window?.appearance
        model.settingsPresented = true
        fullSettingsWindow?.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc private func openAgents() {
        if agentsWindow == nil { agentsWindow = AgentSettingsWindow(workspace: model) }
        agentsWindow?.window.appearance = window?.appearance
        agentsWindow?.model.visible = true
        agentsWindow?.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func hideWindow() {
        if commandPalette?.window === NSApp.keyWindow { commandPalette?.dismiss(); return }
        if fullSettingsWindow?.window === NSApp.keyWindow { fullSettingsWindow?.window.performClose(nil); return }
        if agentsWindow?.window === NSApp.keyWindow { agentsWindow?.window.performClose(nil); return }
        if let run = javaWindows.values.first(where: { $0.window === NSApp.keyWindow }) { run.window?.performClose(nil); return }
        if let run = pythonWindows.values.first(where: { $0.window === NSApp.keyWindow }) { run.window?.performClose(nil); return }
        if let content = contentWindows.values.first(where: { $0.window === NSApp.keyWindow }) { content.window?.performClose(nil) }
        else { window?.performClose(nil) }
    }
    @objc private func openProject() { model.openProject() }
    @objc private func openGit() {
        Task { @MainActor in
            do {
                let directory = try await selectedProjectDirectory()
                _ = try await makeGitContentWindow(directory: directory)
            }
            catch { model.error = error.localizedDescription }
        }
    }
    @objc private func openDatabases() {
        Task { @MainActor in
            do { _ = try await makeDatabaseWindow() }
            catch { model.error = error.localizedDescription }
        }
    }
    private func makeQuickSSHWindow() async throws -> ContentWindow {
        guard !preparingQuit, !mutatingRepository, !model.busy, !model.settingsPresented, !model.editorRecoveryPresented,
              !model.worktreeDeletionPresented, !model.gitFavoritesRecoveryPresented, model.githubPRContent == nil, model.nameDraft == nil,
              let bridge = model.bridge, let parent = window else { throw BridgeFailure(code: "SSH_OPERATION_BUSY", message: localized("Finish the current operation first.", "请先完成当前操作。")) }
        if let current = contentWindows.values.first(where: { $0.workbenchHost?.kind == "ssh-quick" }) { current.reveal(); return current }
        let workspaceID = model.groupID
        let host = QuickSSHHost(workspaceID: workspaceID)
        host.connect = { [weak self] connection in
            guard let self, !self.preparingQuit else { throw BridgeFailure(code: "CLOSED", message: "Quick SSH is closed") }
            return try await self.model.createQuickSSH(connection, workspaceID: workspaceID)
        }
        let content = try ContentWindow(bridge: bridge, directory: WorkspaceModel.dataRoot().deletingLastPathComponent(), path: "", workbenchHost: host)
        model.quickSSHHeight = 240
        host.layoutChanged = { [weak self, weak content] height in
            guard let self, let content, self.model.quickSSHContent === content else { return }
            if abs(self.model.quickSSHHeight - height) >= 0.5 { self.model.quickSSHHeight = height }
        }
        host.close = { [weak content] in content?.forceClose() }
        content.window?.appearance = window?.appearance
        let previous = parent.firstResponder as? NSView
        parent.makeFirstResponder(nil)
        content.window?.contentView = NSView()
        content.window?.orderOut(nil)
        content.presentEmbedded = { [weak parent, weak content] in
            guard let parent, let content else { return }
            parent.makeKeyAndOrderFront(nil)
            DispatchQueue.main.async { [weak parent, weak content] in
                guard let parent, let content, content.webView.window === parent else { return }
                parent.makeFirstResponder(content.webView)
            }
        }
        let id = UUID(); contentWindows[id] = content; model.quickSSHPresented = true
        model.quickSSHContent = content
        content.closed = { [weak self, weak parent, weak previous] in
            guard let self else { return }
            self.contentWindows.removeValue(forKey: id); self.model.quickSSHContent = nil; self.model.quickSSHPresented = false
            DispatchQueue.main.async { [weak self, weak parent, weak previous] in
                guard let self, let parent, parent.isKeyWindow else { return }
                if let previous, previous.window === parent, parent.makeFirstResponder(previous) { return }
                if let active = self.model.documents.active(in: self.model.inspectorContextKey)?.content, active.webView.window === parent { parent.makeFirstResponder(active.webView) }
                else if let terminal = self.model.selectedTerminal, terminal.view.window === parent { parent.makeFirstResponder(terminal.view) }
            }
        }
        content.reveal(); return content
    }
    private func makeDatabaseWindow() async throws -> ContentWindow {
        guard !preparingQuit, let bridge = model.sshBridge else { throw BridgeFailure(code: "DB_CLOSED", message: localized("Database client is unavailable.", "数据库客户端不可用。")) }
        if let content = contentWindows.values.first(where: { $0.workbenchHost?.kind == "database" }) { content.reveal(); return content }
        let host = try model.sharedDatabaseHost()
        host.report = { [weak self] message in self?.model.error = message }
        host.changed = { [weak self] in await self?.model.reload() }
        let content = try ContentWindow(bridge: bridge, directory: WorkspaceModel.dataRoot().deletingLastPathComponent(), path: "Databases", stateBridge: bridge, workbenchHost: host)
        content.window?.appearance = window?.appearance
        let id = UUID(); contentWindows[id] = content
        content.closed = { [weak self] in self?.contentWindows.removeValue(forKey: id) }
        content.reveal()
        return content
    }
    @objc private func openRedis() {
        Task { @MainActor in
            do { _ = try await makeRedisWindow() }
            catch { model.error = error.localizedDescription }
        }
    }
    private func makeRedisWindow() async throws -> ContentWindow {
        guard !preparingQuit, let bridge = model.sshBridge else { throw BridgeFailure(code: "REDIS_CLOSED", message: localized("Redis client is unavailable.", "Redis 客户端不可用。")) }
        if let content = contentWindows.values.first(where: { $0.workbenchHost?.kind == "redis" }) { content.reveal(); return content }
        let host = RedisHost(bridge: bridge)
        host.report = { [weak self] message in self?.model.error = message }
        host.changed = { [weak self] in await self?.model.reload() }
        let content = try ContentWindow(bridge: bridge, directory: WorkspaceModel.dataRoot().deletingLastPathComponent(), path: "Redis", stateBridge: bridge, workbenchHost: host)
        content.window?.appearance = window?.appearance
        let id = UUID(); contentWindows[id] = content
        content.closed = { [weak self] in self?.contentWindows.removeValue(forKey: id) }
        content.reveal(); return content
    }
    @objc private func openJava() {
        Task { @MainActor in
            do {
                let directory = try await selectedProjectDirectory()
                _ = try await makeJavaWindow(directory: directory)
            }
            catch { model.error = error.localizedDescription }
        }
    }
    private func makeJavaWindow(directory: URL) async throws -> JavaWindow {
        let root = directory.standardizedFileURL.resolvingSymlinksInPath().path
        if let existing = javaWindows[root] { existing.showWindow(nil); existing.window?.makeKeyAndOrderFront(nil); return existing }
        guard !preparingQuit, let resources = Bundle.main.resourceURL else { throw BridgeFailure(code: "CLOSED", message: localized("The client is closing.", "客户端正在关闭。")) }
        let worker = try await CoreBridge.open(root: WorkspaceModel.dataRoot())
        do {
            _ = try await worker.call("host.configure", params: .object(["helper": .string(resources.appendingPathComponent("bin/utermd-local").path)]))
            let run = JavaRunModel(directory: root, bridge: worker, settings: model.settings)
            let controller = JavaWindow(model: run)
            controller.didClose = { [weak self] in self?.javaWindows.removeValue(forKey: root) }
            javaWindows[root] = controller
            controller.showWindow(nil); controller.window?.makeKeyAndOrderFront(nil)
            await run.start()
            return controller
        } catch { await worker.close(); throw error }
    }
    @objc private func openPython() {
        Task { @MainActor in
            do {
                let directory = try await selectedProjectDirectory()
                _ = try await makePythonWindow(directory: directory)
            }
            catch { model.error = error.localizedDescription }
        }
    }
    @objc private func openSSH() {
        Task { @MainActor in
            do { _ = try await makeSSHWindow() }
            catch { model.error = error.localizedDescription }
        }
    }
    private func makeSSHWindow(selected: String? = nil) async throws -> SSHWindow {
        guard !preparingQuit, let bridge = model.sshBridge else { throw BridgeFailure(code: "CLOSED", message: "The client is closing") }
        if let current = sshWindow, current.model.workspaceID != model.groupID {
            guard await current.model.prepareForQuit() else { throw BridgeFailure(code: "SSH_CONNECTION_BUSY", message: localized("Resolve the other workspace's SSH window first.", "请先处理另一工作区的 SSH 窗口。")) }
            await current.forceClose()
        }
        if let sshWindow {
            if let selected { await sshWindow.model.select(selected) }
            sshWindow.showWindow(nil); sshWindow.window?.makeKeyAndOrderFront(nil)
            return sshWindow
        }
        let ssh = SSHModel(workspace: model, bridge: bridge)
        let controller = SSHWindow(model: ssh)
        controller.didClose = { [weak self] in
            self?.sshWindow = nil
            Task { await self?.model.cleanupQuickSSH() }
        }
        controller.window?.appearance = window?.appearance
        sshWindow = controller
        controller.showWindow(nil); controller.window?.makeKeyAndOrderFront(nil)
        await ssh.start(selected: selected)
        return controller
    }
    private func makePythonWindow(directory: URL) async throws -> PythonWindow {
        let root = directory.standardizedFileURL.resolvingSymlinksInPath().path
        if let existing = pythonWindows[root] { existing.showWindow(nil); existing.window?.makeKeyAndOrderFront(nil); return existing }
        guard !preparingQuit, let resources = Bundle.main.resourceURL else { throw BridgeFailure(code: "CLOSED", message: localized("The client is closing.", "客户端正在关闭。")) }
        let worker = try await CoreBridge.open(root: WorkspaceModel.dataRoot())
        do {
            _ = try await worker.call("host.configure", params: .object(["helper": .string(resources.appendingPathComponent("bin/utermd-local").path)]))
            let run = PythonRunModel(directory: root, bridge: worker, settings: model.settings)
            let controller = PythonWindow(model: run)
            controller.didClose = { [weak self] in self?.pythonWindows.removeValue(forKey: root) }
            pythonWindows[root] = controller
            controller.showWindow(nil); controller.window?.makeKeyAndOrderFront(nil)
            await run.start()
            return controller
        } catch { await worker.close(); throw error }
    }
    private func validateFileTools(directory: URL, scope: String, bridge: CoreBridge) async throws {
        for attempt in 0..<3 {
            guard model.inspectorContextKey == scope else { throw BridgeFailure(code: "CONFLICT", message: localized("Project selection changed. Refresh the file tools.", "项目选择已变化，请刷新文件面板。")) }
            do {
                let snapshot = try await bridge.snapshot()
                let saved = snapshot.document.workspace
                let actualScope = [saved["selectedWorkspace"].string ?? "local", saved["selectedProject"].string ?? "", saved["selectedWorktree"].string ?? ""].joined(separator: "\u{0}")
                guard actualScope == scope else { throw BridgeFailure(code: "ROOT_DENIED", message: "File tools no longer own the selected project") }
                let context = try await bridge.projectContext(expectedRevision: snapshot.revision)
                guard let path = context.directory, URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath() == directory.standardizedFileURL.resolvingSymlinksInPath(), model.inspectorContextKey == scope else { throw BridgeFailure(code: "ROOT_DENIED", message: "File tools cannot select another project root") }
                return
            } catch let failure as BridgeFailure where attempt < 2 && ["CONFLICT", "WRITER_BUSY"].contains(failure.code) {
                try await Task.sleep(for: .milliseconds(25 * (attempt + 1)))
            }
        }
    }
    private func fileToolsSourceRoot(_ source: String, bridge: CoreBridge) async throws -> URL {
        let state = try await bridge.snapshot()
        let saved = state.document.workspace
        var candidates: [String] = []
        for project in saved["projects"].array {
            if let directory = project["directory"].string { candidates.append(directory) }
            for tree in project["worktrees"].array { if let path = tree["path"].string { candidates.append(path) } }
        }
        let requested = URL(fileURLWithPath: source).standardizedFileURL.resolvingSymlinksInPath()
        guard source.hasPrefix("/"), candidates.contains(where: { URL(fileURLWithPath: $0).standardizedFileURL.resolvingSymlinksInPath() == requested }) else { throw BridgeFailure(code: "ROOT_DENIED", message: localized("Copy source must be a saved project or Worktree.", "复制来源必须是已保存的项目或 Worktree。")) }
        return requested
    }
    private func makeFileToolsWindow(directory: URL, scope: String) async throws -> ContentWindow {
        guard !preparingQuit, let stateBridge = model.bridge else { throw BridgeFailure(code: "CLOSED", message: "File tools are closed") }
        let root = directory.standardizedFileURL.resolvingSymlinksInPath()
        try await validateFileTools(directory: root, scope: scope, bridge: stateBridge)
        if let content = contentWindows.values.first(where: { $0.workbenchHost?.kind == "files" && $0.gitProjectID == scope && $0.directory == root }) { return content }
        for previous in Array(contentWindows.values) where previous.workbenchHost?.kind == "files" {
            guard try await previous.prepareForQuit() else { throw BridgeFailure(code: "FILES_BUSY", message: localized("Finish the current file operation first.", "请先完成当前文件操作。")) }
            previous.forceClose()
        }
        let worker = try await CoreBridge.open(root: WorkspaceModel.dataRoot())
        do {
            let host = try FilesHost(bridge: worker, directory: root)
            host.validate = { [weak self] in
                guard let self else { throw BridgeFailure(code: "CLOSED", message: "File tools are closed") }
                // Serialize canonical reads with UI writes; filesystem work stays on the worker.
                // 规范数据读取与界面写入串行执行；文件系统工作仍使用工作桥接。
                try await self.validateFileTools(directory: root, scope: scope, bridge: stateBridge)
            }
            host.context = { [weak self, weak model] in
                let mode = model?.inspector.mode ?? .files
                let fileMode = mode == .search || mode == .quick ? mode.rawValue : "tree"
                return .object(["mode": .string(fileMode), "request": .number(Double(model?.inspector.request ?? 0)), "clipboard": self?.fileClipboard ?? .null])
            }
            host.copySource = { [weak self] value in
                guard let self else { throw BridgeFailure(code: "CLOSED", message: "File tools are closed") }
                self.fileClipboard = value
            }
            host.changeMode = { [weak model] mode in
                let modes: [String: NativeInspectorModel.Mode] = ["tree": .files, "quick": .quick, "search": .search]
                guard let model, let value = modes[mode] else { throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Unknown file mode") }
                model.showInspector(value)
            }
            host.toolbar = { [weak model] kind in
                guard let model else { throw BridgeFailure(code: "CLOSED", message: "File tools are closed") }
                switch kind {
                case "files": model.showInspector(.files)
                case "git": model.openGitRequested?()
                case "github": model.openGitHubRequested?()
                case "directory": NSWorkspace.shared.activateFileViewerSelecting([root])
                default: throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Unknown file toolbar action")
                }
            }
            host.openFile = { [weak model] path, line in
                guard let open = model?.openInspectorFile else { throw BridgeFailure(code: "CLOSED", message: "File editor is closed") }
                try await open(root.path, path, line)
            }
            host.sourceRoot = { [weak self] source in
                guard let self else { throw BridgeFailure(code: "CLOSED", message: "File tools are closed") }
                return try await self.fileToolsSourceRoot(source, bridge: stateBridge)
            }
            host.mutate = { [weak self] method, params, bridge in
                guard let self else { throw BridgeFailure(code: "CLOSED", message: "File tools are closed") }
                return try await self.performFileMutation(method: method, params: params, bridge: bridge, directory: root, scope: scope)
            }
            let content = try ContentWindow(bridge: worker, directory: root, path: "Files", gitProjectID: scope, stateBridge: stateBridge, ownsBridge: true, workbenchHost: host)
            content.window?.contentView = NSView(); content.window?.orderOut(nil)
            content.presentEmbedded = { [weak model] in if model?.inspectorContextKey == scope { model?.showInspector(.files) } }
            let id = UUID(); contentWindows[id] = content
            content.closed = { [weak self] in self?.contentWindows.removeValue(forKey: id) }
            host.settingsChanged(model.settings)
            return content
        } catch { await worker.close(); throw error }
    }
    private func performFileMutation(method: String, params: JSONValue, bridge: CoreBridge, directory: URL, scope: String) async throws -> JSONValue {
        guard !preparingQuit, !mutatingRepository, model.beginRepositoryMutation() else { throw BridgeFailure(code: "FILES_BUSY", message: localized("Finish the current file operation first.", "请先完成当前文件操作。")) }
        mutatingRepository = true
        let contents = contentWindows.values.filter { $0.editable }
        var started = false
        defer {
            for content in contents {
                content.resumeAfterQuit()
                if started { content.refreshAfterRepositoryMutation() }
            }
            mutatingRepository = false; model.finishRepositoryMutation()
        }
        for content in contents {
            guard try await content.prepareForQuit() else { throw BridgeFailure(code: "CONTENT_CHANGED", message: localized("Save or resolve open file changes before the file operation.", "执行文件操作前请保存或处理已打开文件的修改。")) }
        }
        try Task.checkCancellation()
        guard let stateBridge = model.bridge else { throw BridgeFailure(code: "CLOSED", message: "File tools are closed") }
        try await validateFileTools(directory: directory, scope: scope, bridge: stateBridge)
        if method == "files.copy", let source = params["source_directory"].string { _ = try await fileToolsSourceRoot(source, bridge: stateBridge) }
        guard contents.allSatisfy({ $0.isPreparedForQuit }) else { throw BridgeFailure(code: "CONTENT_CHANGED", message: "A file changed during mutation preparation") }
        started = true
        // Keep dispatched writes alive through document cancellation until the actual result.
        // 文档取消后，已分发的写入仍保持保护，直至取得实际结果。
        return try await Task.detached { try await bridge.call(method, params: params) }.value
    }
    private func selectedProjectDirectory() async throws -> URL {
        guard let bridge = model.bridge, let state = model.state else { throw BridgeFailure(code: "CLOSED", message: localized("Client is closed.", "客户端已关闭。")) }
        let context = try await bridge.projectContext(expectedRevision: state.snapshot.revision)
        guard let path = context.directory, path.hasPrefix("/") else { throw BridgeFailure(code: "LOCAL_PROJECT", message: localized("Select a local project or Worktree first.", "请先选择本地项目或 Worktree。")) }
        return URL(fileURLWithPath: path)
    }
    @objc private func openFile() {
        Task { @MainActor in
            do { try await presentFilePicker() }
            catch { model.error = error.localizedDescription }
        }
    }
    private func presentFilePicker() async throws {
        let root = try await selectedProjectDirectory()
        guard !preparingQuit, !mutatingRepository, let window, window.attachedSheet == nil else { throw BridgeFailure(code: "CONTENT_BUSY", message: localized("Finish the current client operation first.", "请先完成当前客户端操作。")) }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = root
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let self, let file = panel.url else { return }
            guard let fileRoot = try? ContentFileRoot(directory: root), let path = fileRoot.relativePath(for: file) else { self.model.error = localized("Choose a file inside the selected project.", "请选择所选项目中的文件。") ; return }
            Task { @MainActor in
                do { _ = try await self.makeEditableContentWindow(directory: root, path: path) }
                catch { self.model.error = error.localizedDescription }
            }
        }
    }
    private func makeEditableContentWindow(directory: URL, path: String, embedded: Bool = true) async throws -> ContentWindow {
        guard !changingFileTabs else { throw BridgeFailure(code: "CONTENT_BUSY", message: localized("Finish the current file operation first.", "请先完成当前文件操作。")) }
        changingFileTabs = true; defer { changingFileTabs = false; if pendingFileTabTrim { Task { await self.trimFileTabs() } } }
        guard !mutatingRepository, !model.worktreeDeletionPresented, !model.gitFavoritesRecoveryPresented else { throw BridgeFailure(code: "GIT_BUSY", message: localized("Finish the current repository operation first.", "请先完成当前仓库操作。")) }
        if let content = existingContent(directory: directory, path: path, editable: true) {
            if embedded { model.documents.retarget(content, scope: model.inspectorContextKey) }
            content.reveal()
            return content
        }
        guard let bridge = model.bridge else { throw BridgeFailure(code: "CLOSED", message: "Client is closed") }
        do { _ = try await bridge.call("editor.drafts.list", params: .object(["directory": .string(directory.path)])) }
        catch let error as BridgeFailure where error.code == "DRAFTS_NOT_IMPORTED" {
            _ = try await bridge.call("editor.drafts.import", params: .object([:]))
        }
        do { _ = try await bridge.call("files.read", params: .object(["directory": .string(directory.path), "path": .string(path)])) }
        catch {
            let draft = try await bridge.call("editor.drafts.document", params: .object(["directory": .string(directory.path), "path": .string(path)]))
            guard draft != .null else { throw error }
        }
        let root = directory.standardizedFileURL.resolvingSymlinksInPath()
        let limit = model.settings["fileTabLimit"].number.flatMap { Int(exactly: $0) } ?? 10
        let siblings = fileWindowOrder.compactMap { contentWindows[$0] }.filter { $0.editable && !$0.gitMode && $0.directory == root }
        let excess = Array(siblings.prefix(max(0, siblings.count - limit + 1)))
        do {
            for content in excess {
                guard try await content.prepareForQuit() else { throw BridgeFailure(code: "FILE_TAB_CANCELLED", message: localized("File opening cancelled. Existing tabs are retained.", "已取消打开文件，现有标签已保留。")) }
            }
        } catch { excess.forEach { $0.resumeAfterQuit() }; throw error }
        guard !preparingQuit else { excess.forEach { $0.resumeAfterQuit() }; throw BridgeFailure(code: "QUIT_BUSY", message: localized("The client is preparing to quit.", "客户端正在准备退出。")) }
        // Construct successfully before removing prepared tabs, so a failed open retains existing editors.
        // 成功创建后才移除已确认的标签，打开失败时保留现有编辑器。
        let content: ContentWindow
        do { content = try makeContentWindow(directory: directory, path: path, editable: true, embedded: embedded) }
        catch { excess.forEach { $0.resumeAfterQuit() }; throw error }
        excess.forEach { $0.forceClose() }
        return content
    }
    private func trimFileTabs() async {
        guard pendingFileTabTrim, !changingFileTabs, !preparingQuit else { return }
        pendingFileTabTrim = false; changingFileTabs = true
        defer { changingFileTabs = false; if pendingFileTabTrim { Task { await self.trimFileTabs() } } }
        let ordered = fileWindowOrder.compactMap { contentWindows[$0] }.filter { $0.editable && !$0.gitMode }
        let limit = model.settings["fileTabLimit"].number.flatMap { Int(exactly: $0) } ?? 10
        var counts: [URL: Int] = [:]
        let excess = ordered.reversed().filter { content in
            counts[content.directory, default: 0] += 1
            return counts[content.directory, default: 0] > limit
        }.reversed()
        do {
            for content in excess {
                guard try await content.prepareForQuit() else { excess.forEach { $0.resumeAfterQuit() }; return }
            }
            guard !preparingQuit, limit == (model.settings["fileTabLimit"].number.flatMap { Int(exactly: $0) } ?? 10) else { excess.forEach { $0.resumeAfterQuit() }; return }
            excess.forEach { $0.forceClose() }
        } catch { excess.forEach { $0.resumeAfterQuit() }; model.error = error.localizedDescription }
    }
    private func makeContentWindow(directory: URL, path: String, editable: Bool = false, embedded: Bool = false) throws -> ContentWindow {
        guard !preparingQuit else { throw BridgeFailure(code: "QUIT_BUSY", message: localized("The client is preparing to quit.", "客户端正在准备退出。")) }
        guard let bridge = model.bridge else { throw BridgeFailure(code: "CLOSED", message: localized("Client is closed.", "客户端已关闭。")) }
        if let content = existingContent(directory: directory, path: path, editable: editable) {
            content.reveal()
            return content
        }
        let content = try ContentWindow(bridge: bridge, directory: directory, path: path, editable: editable)
        content.window?.appearance = window?.appearance
        if editable, !embedded, let next = content.window {
            let siblings = contentWindows.values.filter { $0.editable && !$0.gitMode && $0.directory == content.directory }
            if let anchor = NSApp.orderedWindows.first(where: { window in siblings.contains { $0.window === window } }) {
                // Append after the group's last tab; dictionary iteration must not choose the tab order.
                // 在分组末尾追加标签，避免由字典遍历顺序决定标签位置。
                (anchor.tabbedWindows?.last ?? anchor).addTabbedWindow(next, ordered: .above)
            }
        }
        let id = UUID()
        contentWindows[id] = content
        fileWindowOrder.append(id)
        content.closed = { [weak self] in self?.contentWindows.removeValue(forKey: id); self?.fileWindowOrder.removeAll { $0 == id }; self?.model.documents.remove(id) }
        if embedded, let window { model.documents.attach(content, id: id, scope: model.inspectorContextKey, parent: window) }
        content.reveal()
        return content
    }

    private func existingContent(directory: URL, path: String, editable: Bool) -> ContentWindow? {
        let root = directory.standardizedFileURL.resolvingSymlinksInPath()
        return contentWindows.values.first { !$0.gitMode && $0.workbenchHost == nil && $0.directory == root && $0.documentDirectory == directory.path && $0.path == path && $0.editable == editable }
    }
    private func openGitHub() {
        model.showInspector(.github)
    }
    private func embedGitHubTools(_ content: ContentWindow, scope: String) throws {
        guard let parent = window, model.inspectorContextKey == scope else { throw BridgeFailure(code: "CONFLICT", message: localized("Project selection changed. Open GitHub again.", "项目选择已变化，请重新打开 GitHub。")) }
        content.window?.contentView = NSView(); content.window?.orderOut(nil)
        (content.workbenchHost as? GitHubHost)?.window = parent
        (content.workbenchHost as? GitHubHost)?.toolbar = { [weak self, weak content] kind in
            guard let self, let content, self.model.inspectorContextKey == scope else { throw BridgeFailure(code: "CONFLICT", message: localized("Project selection changed. Open GitHub again.", "项目选择已变化，请重新打开 GitHub。")) }
            switch kind {
            case "files": self.model.showInspector(.files)
            case "git": self.openGit()
            case "github": self.model.showInspector(.github)
            case "directory": NSWorkspace.shared.activateFileViewerSelecting([content.directory])
            default: throw BridgeFailure(code: "INVALID_ARGUMENT", message: "Unknown GitHub toolbar action")
            }
        }
        content.presentEmbedded = { [weak model, weak content] in
            guard let model, let content, model.inspectorContextKey == scope else { return }
            model.inspector.presentGitHub(content, scope: scope); model.inspectorVisible = true
        }
    }
    private func makeGitHubContentWindow(directory: URL, present: Bool = true) async throws -> ContentWindow {
        guard !preparingQuit, !mutatingRepository, let bridge = model.bridge, let state = model.state else { throw BridgeFailure(code: "GIT_BUSY", message: localized("Finish the current client operation first.", "请先完成当前客户端操作。")) }
        let scope = model.inspectorContextKey
        let root = directory.standardizedFileURL.resolvingSymlinksInPath()
        let selected = try await bridge.projectContext(expectedRevision: state.snapshot.revision)
        guard model.inspectorContextKey == scope, let projectID = selected.projectId, let path = selected.directory, URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath() == root else { throw BridgeFailure(code: "CONFLICT", message: localized("Project selection changed. Open GitHub again.", "项目选择已变化，请重新打开 GitHub。")) }
        if let current = contentWindows.values.first(where: { $0.workbenchHost?.kind == "github" && $0.directory == root && $0.gitProjectID == projectID }) {
            try embedGitHubTools(current, scope: scope)
            current.workbenchHost?.emit?("github-context-changed", .null)
            if present { current.reveal() }
            return current
        }
        let worker = try await CoreBridge.open(root: WorkspaceModel.dataRoot())
        do {
            guard model.inspectorContextKey == scope, window != nil else { throw BridgeFailure(code: "CONFLICT", message: localized("Project selection changed. Open GitHub again.", "项目选择已变化，请重新打开 GitHub。")) }
            let host = GitHubHost(bridge: worker, directory: root.path)
            host.context = { [weak self] in
                guard let self, self.model.workspace["selectedProject"].string == projectID else { return .object(["canAssociate": .bool(false), "canInsert": .bool(false)]) }
                let active = self.model.state?.sessions.first { $0.sessionID == self.model.selectedID }
                return .object(["canAssociate": .bool(active != nil), "canInsert": .bool(active?.session["agent"].string != nil)])
            }
            host.sessionAction = { [weak self] action, item in
                guard let self, !self.preparingQuit, !self.mutatingRepository, self.model.workspace["selectedProject"].string == projectID, try await self.selectedProjectDirectory().standardizedFileURL.resolvingSymlinksInPath() == root else { throw BridgeFailure(code: "CONFLICT", message: localized("Project selection changed. Open GitHub again.", "项目选择已变化，请重新打开 GitHub。")) }
                guard case .object(let fields) = item, fields.count == 2, let url = item["url"].string, let title = item["title"].string,
                      url.utf8.count <= 2000, title.utf8.count <= 1000,
                      url.range(of: "^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(issues|pull)/[0-9]+$", options: .regularExpression) != nil else { throw BridgeFailure(code: "GITHUB_ARGUMENT", message: localized("Invalid GitHub issue or PR link.", "GitHub 议题或 PR 链接无效。")) }
                switch action {
                case "associate":
                    guard let id = self.model.selectedID, await self.model.mutate("session.issue", ["id": .string(id), "issue": item]) else { throw BridgeFailure(code: "CONFLICT", message: self.model.error.isEmpty ? localized("Select a session first.", "请先选择会话。") : self.model.error) }
                case "create":
                    let name = "#" + (url.split(separator: "/").last.map(String.init) ?? "") + " " + title
                    guard await self.model.mutate("session.create", ["id": .string(UUID().uuidString), "name": .string(String(name.prefix(100))), "issue": item]) else { throw BridgeFailure(code: "CONFLICT", message: self.model.error) }
                case "insert":
                    guard let terminal = self.model.selectedTerminal, self.model.state?.sessions.first(where: { $0.sessionID == terminal.id })?.session["agent"].string != nil,
                          terminal.inputControl?.owned == true else { throw BridgeFailure(code: "READ_ONLY", message: localized("Select an Agent session with input control first.", "请先选择拥有输入控制权的 Agent 会话。")) }
                    terminal.enqueue(Data(url.utf8))
                    await terminal.drainInput()
                    guard terminal.error.isEmpty else { throw BridgeFailure(code: "GITHUB_INPUT", message: terminal.error) }
                default: throw BridgeFailure(code: "METHOD_DENIED", message: "Unknown GitHub session action")
                }
            }
            let content = try ContentWindow(bridge: worker, directory: root, path: "", gitProjectID: projectID, stateBridge: bridge, ownsBridge: true, workbenchHost: host)
            content.window?.appearance = window?.appearance
            try embedGitHubTools(content, scope: scope)
            let id = UUID(); contentWindows[id] = content
            host.openPR = { [weak self, weak content] repository in
                guard let self, let content, !self.preparingQuit, !self.mutatingRepository, self.model.inspector.content === content, self.model.inspectorContextKey == scope, self.model.quickSSHContent == nil else { throw BridgeFailure(code: "CONFLICT", message: localized("Project selection changed. Open GitHub again.", "项目选择已变化，请重新打开 GitHub。")) }
                try await self.presentGitHubPR(owner: content, repository: repository)
            }
            content.closed = { [weak self, weak host] in
                guard let self else { return }
                for child in Array(self.contentWindows.values) where (child.workbenchHost as? GitHubPRHost)?.owner === host { child.forceClose() }
                self.contentWindows.removeValue(forKey: id)
            }
            if present { content.reveal() }
            return content
        } catch { await worker.close(); throw error }
    }
    private func presentGitHubPR(owner: ContentWindow, repository: String) async throws {
        guard let host = owner.workbenchHost as? GitHubHost, let bridge = model.bridge, let parent = window else { throw BridgeFailure(code: "CLOSED", message: "GitHub workbench is closed") }
        let scope = model.inspectorContextKey
        if let cached = contentWindows.values.first(where: { ($0.workbenchHost as? GitHubPRHost)?.owner === host }) {
            model.githubPRContent = cached; cached.reveal(); return
        }
        let context = try await host.execute("github_prepare_pr", params: ["directory": .string(host.directory), "repository": .string(repository)])
        guard !preparingQuit, !mutatingRepository, model.inspectorContextKey == scope, model.inspector.content === owner else { throw BridgeFailure(code: "CONFLICT", message: localized("Project selection changed. Open GitHub again.", "项目选择已变化，请重新打开 GitHub。")) }
        let form = GitHubPRHost(owner: host, repository: repository, context: context)
        let content = try ContentWindow(bridge: bridge, directory: owner.directory, path: "", workbenchHost: form)
        content.window?.appearance = parent.appearance
        content.window?.contentView = NSView(); content.window?.orderOut(nil)
        let id = UUID(); contentWindows[id] = content; host.formActive = true
        model.githubPRHeight = 520; model.githubPRContent = content
        form.layoutChanged = { [weak self, weak content] height in
            guard let self, let content, self.model.githubPRContent === content else { return }
            if abs(self.model.githubPRHeight - height) >= 0.5 { self.model.githubPRHeight = height }
        }
        func restoreToolsFocus() {
            DispatchQueue.main.async { [weak parent, weak owner] in
                guard let parent, let owner, parent.isKeyWindow, owner.webView.window === parent else { return }
                parent.makeFirstResponder(owner.webView)
            }
        }
        form.dismiss = { [weak self, weak content] in
            guard let self, self.model.githubPRContent === content else { return }
            self.model.githubPRContent = nil; restoreToolsFocus()
        }
        form.close = { [weak content] in content?.forceClose() }
        content.closed = { [weak self, weak content, weak host] in
            guard let self else { return }
            host?.formActive = false
            if self.model.githubPRContent === content { self.model.githubPRContent = nil }
            self.contentWindows.removeValue(forKey: id); restoreToolsFocus()
        }
        content.presentEmbedded = { [weak parent, weak content] in
            guard let parent else { return }
            parent.makeKeyAndOrderFront(nil)
            DispatchQueue.main.async { [weak parent, weak content] in
                guard let parent, let content, content.webView.window === parent else { return }
                parent.makeFirstResponder(content.webView)
            }
        }
        content.reveal()
    }
    private func makeGitContentWindow(directory: URL) async throws -> ContentWindow {
        guard !preparingQuit, !mutatingRepository, let stateBridge = model.bridge else {
            throw BridgeFailure(code: "GIT_BUSY", message: localized("Finish the current client operation first.", "请先完成当前客户端操作。"))
        }
        let worker = try await CoreBridge.open(root: WorkspaceModel.dataRoot())
        do {
            let snapshot = try await worker.call("git.snapshot", params: .object(["directory": .string(directory.path)]))
            guard let path = snapshot["root"].string else { throw BridgeFailure(code: "GIT_ROOT", message: "Git did not return its repository root") }
            let root = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
            let fileDirectory = directory.standardizedFileURL.resolvingSymlinksInPath() == root ? directory : root
            guard !preparingQuit, !mutatingRepository else { throw BridgeFailure(code: "GIT_BUSY", message: "Client is preparing another operation") }
            guard let state = model.state else { throw BridgeFailure(code: "CLOSED", message: "Client is closed") }
            let context = try await stateBridge.projectContext(expectedRevision: state.snapshot.revision)
            guard let projectID = context.projectId, let selected = context.directory,
                  URL(fileURLWithPath: selected).standardizedFileURL.resolvingSymlinksInPath() == directory.standardizedFileURL.resolvingSymlinksInPath() else {
                throw BridgeFailure(code: "CONFLICT", message: localized("Project selection changed. Open Git again.", "项目选择已变化，请重新打开 Git。"))
            }
            if let current = contentWindows.values.first(where: { $0.gitMode && $0.directory == root && $0.gitProjectID == projectID }) {
                await worker.close()
                current.showWindow(nil)
                return current
            }
            let content = try ContentWindow(bridge: worker, directory: root, path: "", gitMode: true, gitProjectID: projectID, stateBridge: stateBridge, ownsBridge: true)
            content.window?.appearance = window?.appearance
            content.mutateGit = { [weak self] method, params, bridge in
                guard let self else { throw BridgeFailure(code: "CLOSED", message: "Client is closed") }
                return try await self.performRepositoryMutation(method: method, params: params, bridge: bridge, projectID: projectID)
            }
            content.openRepositoryFile = { [weak self] path in
                guard let self else { throw BridgeFailure(code: "CLOSED", message: "Client is closed") }
                _ = try await self.makeEditableContentWindow(directory: fileDirectory, path: path)
            }
            content.recoverGitFavorites = { [weak self] in
                guard let self else { throw BridgeFailure(code: "CLOSED", message: "Client is closed") }
                try self.beginGitFavoritesRecovery()
            }
            let id = UUID()
            contentWindows[id] = content
            content.closed = { [weak self] in self?.contentWindows.removeValue(forKey: id) }
            content.showWindow(nil)
            return content
        } catch {
            await worker.close()
            throw error
        }
    }
    private func performRepositoryMutation(method: String, params: JSONValue, bridge: CoreBridge, projectID: String) async throws -> JSONValue {
        guard !preparingQuit, !mutatingRepository, !model.worktreeDeletionPresented else { throw BridgeFailure(code: "GIT_BUSY", message: localized("Finish the current repository operation first.", "请先完成当前仓库操作。")) }
        try Task.checkCancellation()
        guard model.beginRepositoryMutation() else { throw BridgeFailure(code: "GIT_BUSY", message: localized("Finish the current client operation first.", "请先完成当前客户端操作。")) }
        mutatingRepository = true
        let contents = contentWindows.values.filter { $0.editable }
        var started = false
        defer {
            for content in contents {
                content.resumeAfterQuit()
                if started { content.refreshAfterRepositoryMutation() }
            }
            mutatingRepository = false
            model.finishRepositoryMutation()
        }
        for content in contents {
            guard try await content.prepareForQuit() else {
                throw BridgeFailure(code: "GIT_FILES", message: localized("Save or resolve open file changes before the Git operation.", "执行 Git 操作前请保存或处理已打开文件的修改。"))
            }
        }
        try Task.checkCancellation()
        guard contents.allSatisfy({ $0.isPreparedForQuit }) else { throw BridgeFailure(code: "CONTENT_CHANGED", message: localized("A file window changed. Retry the Git operation.", "文件窗口已变化，请重试 Git 操作。")) }
        started = true
        let result = try await bridge.call(method, params: params)
        do {
            if method != "project.worktrees.delete" {
                let snapshot = try await bridge.snapshot()
                _ = try await bridge.call("project.worktrees.refresh", params: .object(["id": .string(projectID), "expectedRevision": .string(snapshot.revision)]))
            }
            await model.reload()
        } catch {
            throw BridgeFailure(code: "WORKTREE_SYNC", message: localized("The Git operation completed, but the project tree could not be refreshed. Refresh the project: ", "Git 操作已完成，但项目树刷新失败，请刷新项目：") + error.localizedDescription)
        }
        return result
    }
    private func confirmWorktreeDeletion(projectID: String, worktreeID: String) {
        guard !preparingQuit, !mutatingRepository, !model.busy, !model.worktreeDeletionPresented,
              !model.editorRecoveryPresented, !model.gitFavoritesRecoveryPresented, !model.settingsPresented, model.nameDraft == nil,
              let window, window.attachedSheet == nil, let state = model.state,
              let project = model.projects.first(where: { $0["id"].string == projectID }),
              let tree = project["worktrees"].array.first(where: { $0["id"].string == worktreeID }) else { return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = localized("Delete Worktree “", "删除 Worktree “") + (tree["name"].string ?? "") + localized("”?", "”？")
        alert.informativeText = (tree["path"].string ?? "") + "\n\n" + localized("Delete this Worktree and its folder? Sessions, running tasks and uncommitted files prevent deletion.", "删除此 Worktree 及其文件夹？会话、运行任务和未提交文件会阻止删除。")
        alert.addButton(withTitle: localized("Cancel", "取消"))
        alert.addButton(withTitle: localized("Delete Worktree", "删除 Worktree"))
        alert.buttons[1].hasDestructiveAction = true
        model.worktreeDeletionPresented = true
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            guard response == .alertSecondButtonReturn, !self.preparingQuit, !self.mutatingRepository else { self.model.worktreeDeletionPresented = false; return }
            Task { @MainActor in
                var worker: CoreBridge?
                do {
                    let bridge = try await CoreBridge.open(root: WorkspaceModel.dataRoot())
                    worker = bridge
                    self.model.worktreeDeletionPresented = false
                    _ = try await self.performRepositoryMutation(method: "project.worktrees.delete", params: .object([
                        "id": .string(projectID), "worktreeId": .string(worktreeID), "expectedRevision": .string(state.snapshot.revision)
                    ]), bridge: bridge, projectID: projectID)
                } catch { self.model.worktreeDeletionPresented = false; self.model.error = error.localizedDescription }
                await worker?.close()
            }
        }
    }
    @objc private func recoverEditorDrafts() { showEditorRecovery(restoring: false) }
    @objc private func restoreEditorRecovery() { showEditorRecovery(restoring: true) }
    @objc private func recoverGitFavorites() {
        do { try beginGitFavoritesRecovery() }
        catch { model.error = GitFavoritesRecovery.message(error) }
    }
    private func beginGitFavoritesRecovery() throws {
        guard !preparingQuit, !mutatingRepository, !model.busy, !model.gitFavoritesRecoveryPresented,
              !model.editorRecoveryPresented, !model.worktreeDeletionPresented, !model.settingsPresented, model.nameDraft == nil,
              let window, window.attachedSheet == nil, let bridge = model.bridge else {
            throw BridgeFailure(code: "RECOVERY_BUSY", message: localized("Finish the current dialog or operation first.", "请先完成当前对话框或操作。"))
        }
        model.gitFavoritesRecoveryPresented = true
        let previousKey = NSApp.keyWindow
        window.makeKeyAndOrderFront(nil)
        Task { @MainActor in
            defer {
                model.gitFavoritesRecoveryPresented = false
                if let previousKey, previousKey.isVisible { previousKey.makeKeyAndOrderFront(nil) }
            }
            do {
                if try await GitFavoritesRecovery.present(bridge: bridge, window: window) {
                    for content in contentWindows.values where content.gitMode { content.favoritesDidRestore() }
                }
                model.error = ""
            } catch { model.error = GitFavoritesRecovery.message(error) }
        }
    }
    private func showEditorRecovery(restoring: Bool) {
        guard !preparingQuit, !model.busy, !model.editorRecoveryPresented, !model.gitFavoritesRecoveryPresented, !model.settingsPresented, model.nameDraft == nil,
              let window, window.attachedSheet == nil, let bridge = model.bridge else { return }
        model.editorRecoveryPresented = true
        window.makeKeyAndOrderFront(nil)
        Task { @MainActor in
            defer { model.editorRecoveryPresented = false }
            do {
                if restoring { try await EditorRecovery.restoreCopy(bridge: bridge, window: window) }
                else if let draft = try await EditorRecovery.chooseDraft(bridge: bridge, window: window) {
                    _ = try await self.makeEditableContentWindow(directory: URL(fileURLWithPath: draft.directory), path: draft.path)
                }
                model.error = ""
            } catch { model.error = error.localizedDescription }
        }
    }

    @objc private func newWorkspace() { model.newWorkspace() }
    @objc private func newTerminal() { Task { await model.newTerminal() } }
    @objc private func newAgent() { Task { await model.newDefaultAgent() } }
    @objc private func closeSession() {
        if let quick = model.workspaceModalContent { quick.window?.performClose(nil); return }
        if commandPalette?.window === NSApp.keyWindow { commandPalette?.dismiss(); return }
        if let fullSettingsWindow, fullSettingsWindow.window === NSApp.keyWindow { fullSettingsWindow.window.performClose(nil); return }
        if let agentsWindow, agentsWindow.window === NSApp.keyWindow { agentsWindow.window.performClose(nil); return }
        if let sshWindow, sshWindow.window === NSApp.keyWindow { sshWindow.window?.performClose(nil); return }
        if let run = javaWindows.values.first(where: { $0.window === NSApp.keyWindow }) { run.window?.performClose(nil); return }
        if let run = pythonWindows.values.first(where: { $0.window === NSApp.keyWindow }) { run.window?.performClose(nil); return }
        if let content = contentWindows.values.first(where: { $0.window === NSApp.keyWindow }) { content.window?.performClose(nil) }
        else if NSApp.keyWindow === window, !model.inspectorOwnsFocus, let document = model.documents.active(in: model.inspectorContextKey) { model.documents.close(document.id) }
        else if NSApp.keyWindow === window && model.inspectorOwnsFocus { model.hideInspector() }
        else { Task { await model.closeSession() } }
    }
    @objc private func splitRight() { Task { await model.split("horizontal") } }
    @objc private func splitDown() { Task { await model.split("vertical") } }
    private func focusedContent(in origin: NSWindow?) -> ContentWindow? {
        guard let origin else { return nil }
        if origin === window, !model.inspectorOwnsFocus { return model.documents.active(in: model.inspectorContextKey)?.content }
        return contentWindows.values.first { $0.window === origin }
    }
    private func adjustFocusedFont(_ delta: Int) {
        if let content = focusedContent(in: NSApp.keyWindow) { content.adjustContentFont(delta); return }
        Task { await model.mutate("settings.font.adjust", ["key": .string("fontSize"), "delta": .number(Double(delta))]) }
    }
    @objc private func increaseFont() { adjustFocusedFont(1) }
    @objc private func decreaseFont() { adjustFocusedFont(-1) }

    func windowDidUpdate(_ notification: Notification) {
        guard let responder = window?.firstResponder else { return }
        DispatchQueue.main.async { [weak self, weak responder] in
            guard let self, let responder, self.window?.firstResponder === responder,
                  self.model.ready, !self.model.busy, !self.model.settingsPresented, !self.model.workspaceModalPresented, !self.model.editorRecoveryPresented, self.model.nameDraft == nil,
                  let session = self.model.terminals.values.first(where: { $0.view === responder }),
                  session.id != self.model.selectedID else { return }
            Task { await self.model.selectSession(session.id, focus: false) }
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if let quick = model.workspaceModalContent { quick.window?.performClose(nil); return false }
        if !model.worktreeDeletionPresented && !model.gitFavoritesRecoveryPresented { sender.orderOut(nil) }
        return false
    }
    func windowDidEnterFullScreen(_ notification: Notification) { model.fullScreen = true }
    func windowDidExitFullScreen(_ notification: Notification) { model.fullScreen = false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window?.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if let fullSettingsWindow, fullSettingsWindow.model.busy || fullSettingsWindow.model.login.busy {
            fullSettingsWindow.model.error = localized("Wait for the settings operation to finish.", "请等待设置操作完成。")
            fullSettingsWindow.window.makeKeyAndOrderFront(nil)
            return .terminateCancel
        }
        if let agentsWindow, agentsWindow.model.busy {
            agentsWindow.model.error = localized("Wait for the Agent operation to finish.", "请等待 Agent 操作完成。")
            agentsWindow.window.makeKeyAndOrderFront(nil)
            return .terminateCancel
        }
        if terminating { return .terminateNow }
        if model.sshTrustPresented { return .terminateCancel }
        if let run = javaWindows.values.first(where: { $0.model.busy }) {
            run.model.error = localized("Wait for the Java operation to finish.", "请等待 Java 操作完成。")
            run.window?.makeKeyAndOrderFront(nil)
            return .terminateCancel
        }
        if let run = pythonWindows.values.first(where: { $0.model.busy }) {
            run.model.error = localized("Wait for the Python operation to finish.", "请等待 Python 操作完成。")
            run.window?.makeKeyAndOrderFront(nil)
            return .terminateCancel
        }
        if preparingQuit || mutatingRepository || changingFileTabs || model.editorRecoveryPresented || model.worktreeDeletionPresented || model.gitFavoritesRecoveryPresented || pythonWindows.values.contains(where: { $0.model.busy }) { return .terminateCancel }
        preparingQuit = true
        Task { @MainActor in
            guard await model.confirmQuit() else { self.preparingQuit = false; return }
            let contents = Array(self.contentWindows.values)
            let runs = Array(self.pythonWindows.values)
            let javaRuns = Array(self.javaWindows.values)
            do {
                if let fullSettingsWindow = self.fullSettingsWindow, !(await fullSettingsWindow.prepareForQuit()) {
                    throw BridgeFailure(code: "SETTINGS_QUIT_REFUSED", message: localized("Resolve settings changes before quitting.", "退出前请处理设置修改。"))
                }
                if let agentsWindow = self.agentsWindow, !(await agentsWindow.prepareForQuit()) {
                    throw BridgeFailure(code: "AGENT_QUIT_REFUSED", message: localized("Resolve Agent configuration changes before quitting.", "退出前请处理 Agent 配置修改。"))
                }
                if let current = self.sshWindow, !(await current.model.prepareForQuit()) { throw BridgeFailure(code: "SSH_QUIT_REFUSED", message: localized("Finish the SSH operation before quitting.", "退出前请完成 SSH 操作。")) }
                for run in runs {
                    guard await run.prepareForQuit() else { throw BridgeFailure(code: "PYTHON_QUIT_REFUSED", message: localized("Resolve Python configuration changes before quitting.", "退出前请处理 Python 配置修改。")) }
                }
                for run in javaRuns {
                    guard await run.prepareForQuit() else { throw BridgeFailure(code: "JAVA_QUIT_REFUSED", message: localized("Resolve Java configuration changes before quitting.", "退出前请处理 Java 配置修改。")) }
                }
                for content in contents {
                    guard try await content.prepareForQuit() else {
                        let message: String
                        if content.workbenchHost?.kind == "ssh-quick" { message = localized("Wait for the Quick SSH operation to finish.", "请等待快速 SSH 操作完成。") }
                        else if content.workbenchHost?.kind == "redis" { message = localized("Finish Redis operations and resolve drafts before quitting.", "退出前请完成 Redis 操作并处理草稿。") }
                        else if content.workbenchHost != nil { message = localized("Finish database operations and commit or roll back transactions before quitting.", "退出前请完成数据库操作，并提交或回滚事务。") }
                        else { message = localized("Save or resolve file changes before quitting.", "退出前请保存或处理文件修改。") }
                        throw BridgeFailure(code: "QUIT_REFUSED", message: message)
                    }
                }
                guard contents.allSatisfy({ $0.isPreparedForQuit }) else {
                    throw BridgeFailure(code: "CONTENT_CHANGED", message: localized("A file window changed while preparing to quit. Try again.", "准备退出时文件窗口已变化，请重试。"))
                }
            } catch {
                self.agentsWindow?.resumeAfterQuit()
                self.fullSettingsWindow?.resumeAfterQuit()
                await self.sshWindow?.model.resumeAfterQuit()
                for content in contents { content.resumeAfterQuit() }
                for run in runs { run.resumeAfterQuit() }
                for run in javaRuns { run.resumeAfterQuit() }
                self.model.error = error.localizedDescription
                self.window?.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                self.preparingQuit = false
                return
            }
            for content in contents { content.forceClose() }
            self.agentsWindow?.window.orderOut(nil)
            self.fullSettingsWindow?.window.orderOut(nil)
            await self.sshWindow?.forceClose()
            for run in runs { await run.forceClose() }
            for run in javaRuns { await run.forceClose() }
            await model.shutdown()
            self.terminating = true
            sender.terminate(nil)
        }
        return .terminateCancel
    }

    private func baseReport() -> [String: Any] {
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x86_64"
        #endif
        return ["captureMethod": "WindowServer screencapture -l", "platform": "macOS", "architecture": architecture, "system": ProcessInfo.processInfo.operatingSystemVersionString,
         "sourceHeadSHA": Bundle.main.object(forInfoDictionaryKey: "UTermSourceHeadSHA") ?? "",
         "windowVisible": window?.isVisible == true, "screenCount": NSScreen.screens.count,
         "bundleIdentifier": Bundle.main.bundleIdentifier ?? "", "minimumOS": Bundle.main.object(forInfoDictionaryKey: "LSMinimumSystemVersion") ?? "",
         "sourceSHA": Bundle.main.object(forInfoDictionaryKey: "UTermSourceSHA") ?? "", "productionDataAccess": false,
         "hostStarted": !model.terminals.isEmpty, "coreReady": model.ready, "sessionCount": model.state?.sessions.count ?? 0,
         "error": model.error]
    }
    private func writeSmokeReport(_ path: String) async {
        var report = baseReport()
        do {
            guard let window else { throw BridgeFailure(code: "SMOKE_WINDOW", message: "Native window is missing") }
            let name = "native-empty-window.png"
            try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name))
            report["captures"] = [name]
        } catch { report["failure"] = error.localizedDescription }
        finishReport(report, path: path)
    }
    private func finishReport(_ report: [String: Any], path: String, keepRunning: Bool = false) {
        do {
            try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: path), options: .atomic)
            if keepRunning { return }
            // Dismiss QA sheets before asking AppKit to terminate after a failed scenario.
            // 失败场景先关闭 QA sheet，避免 AppKit 延后退出而掩盖原始报告。
            model.settingsPresented = false
            model.nameDraft = nil
            Task { @MainActor in
                for _ in 0..<40 {
                    guard self.window?.attachedSheet != nil else { break }
                    try? await Task.sleep(for: .milliseconds(50))
                }
                if let sheet = self.window?.attachedSheet { self.window?.endSheet(sheet) }
                NSApp.terminate(nil)
            }
        } catch { fputs("Native smoke report failed: \(error)\n", stderr); exit(1) }
    }

    private func runTerminalSmoke(_ path: String, reconnect: Bool) async {
        var report = baseReport()
        do {
            try await TerminalSmoke.run(model: model, window: window, reconnect: reconnect, report: &report)
            finishReport(report, path: path)
        } catch {
            report["failure"] = error.localizedDescription
            report["terminalDiagnostics"] = model.terminals.values.map { ["id": $0.id, "generation": $0.generation ?? "", "error": $0.error, "exited": $0.exited, "suppressedRendererReplyBytes": $0.qaSuppressedReplyBytes, "text": String($0.text.suffix(4096))] as [String: Any] }
            if let window {
                let name = "native-terminal-failure.png"
                do {
                    try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name))
                    report["failureCapture"] = name
                } catch { report["failureCaptureError"] = error.localizedDescription }
            }
            finishReport(report, path: path)
        }
    }
}

@main
enum NativeMain {
    @MainActor static func main() {
        if let status = CoreBridge.runSSHAskpassIfRequested() { exit(status) }
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}
