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
    private var pythonWindows: [String: PythonWindow] = [:]
    private var javaWindows: [String: JavaWindow] = [:]
    private let model = WorkspaceModel()
    private var terminating = false
    private var preparingQuit = false
    private var mutatingRepository = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "uTerm Native QA"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 640, height: 420)
        window.delegate = self
        window.contentView = NSHostingView(rootView: WorkspaceView(model: model))
        window.center()
        self.window = window
        model.languageChanged = { [weak self] in self?.configureMenu() }
        model.requestActivation = { [weak window] in
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        model.appearanceChanged = { [weak window] appearance in
            window?.appearance = appearance == "dark" ? NSAppearance(named: .darkAqua) : appearance == "light" ? NSAppearance(named: .aqua) : nil
        }
        model.deleteWorktreeRequested = { [weak self] project, tree in self?.confirmWorktreeDeletion(projectID: project, worktreeID: tree) }
        configureMenu()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task { @MainActor in
            await model.start()
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
                do { try await GitSmoke.run(model: model, parent: window, open: { directory in try await self.makeGitContentWindow(directory: directory) }, openFile: { directory, path in try await self.makeEditableContentWindow(directory: directory, path: path) }, report: &report) }
                catch { report["failure"] = error.localizedDescription }
                finishReport(report, path: path)
                return
            }
            if let path = WorkspaceModel.argument("--editor-smoke-report") {
                var report = baseReport()
                do { try await EditorSmoke.run(model: model, parent: window, open: { directory, path in try await self.makeEditableContentWindow(directory: directory, path: path) }, lookup: { directory, path in self.existingContent(directory: directory, path: path, editable: true) }, report: &report) }
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
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
            item.target = self
            menu.addItem(item)
        }
        let app = menu("uTerm Native QA")
        add(app, localized("Settings…", "设置…"), #selector(settings), ",")
        app.addItem(.separator())
        add(app, localized("Quit uTerm Native QA", "退出 uTerm 原生 QA"), #selector(quit), "q")
        let file = menu(localized("File", "文件"))
        add(file, localized("Open project…", "打开项目…"), #selector(openProject), "o")
        add(file, localized("Open file…", "打开文件…"), #selector(openFile), "o", [.command, .shift])
        add(file, "Git…", #selector(openGit))
        add(file, localized("Java build and run…", "Java 构建与运行…"), #selector(openJava))
        add(file, localized("Python run…", "Python 运行…"), #selector(openPython))
        add(file, localized("Recover editor drafts…", "恢复编辑器草稿…"), #selector(recoverEditorDrafts))
        add(file, localized("Restore editor recovery copy…", "恢复编辑器备份副本…"), #selector(restoreEditorRecovery))
        add(file, localized("Recover Git favorites…", "恢复 Git 收藏…"), #selector(recoverGitFavorites))
        add(file, localized("New workspace…", "新建工作区…"), #selector(newWorkspace), "n", [.command, .shift])
        add(file, localized("New terminal", "新建终端"), #selector(newTerminal), "t")
        add(file, localized("New Agent session", "新建 Agent 会话"), #selector(newAgent), "n")
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
        let windows = menu(localized("Window", "窗口"))
        windows.addItem(withTitle: localized("Minimize", "最小化"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        add(windows, localized("Close window", "关闭窗口"), #selector(hideWindow), "w", [.command, .shift])
        let fullScreen = windows.addItem(withTitle: localized("Enter full screen", "进入全屏"), action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        NSApp.mainMenu = main
        NSApp.windowsMenu = windows
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if preparingQuit || mutatingRepository || model.editorRecoveryPresented || model.worktreeDeletionPresented || model.gitFavoritesRecoveryPresented { return false }
        if menuItem.action == #selector(closeSession) {
            if let run = javaWindows.values.first(where: { $0.window === NSApp.keyWindow }) {
                menuItem.title = localized("Close window", "关闭窗口")
                return !run.model.busy && !run.model.prepared
            }
            if let run = pythonWindows.values.first(where: { $0.window === NSApp.keyWindow }) {
                menuItem.title = localized("Close window", "关闭窗口")
                return !run.model.busy && !run.model.prepared
            }
            let fileFocused = contentWindows.values.contains { $0.window === NSApp.keyWindow }
            menuItem.title = fileFocused ? localized("Close file", "关闭文件") : localized("Close session", "关闭会话")
            if fileFocused { return true }
        }
        if contentWindows.values.contains(where: { $0.window === NSApp.keyWindow }), let action = menuItem.action,
           [#selector(splitRight), #selector(splitDown), #selector(increaseFont), #selector(decreaseFont)].contains(action) { return false }
        if menuItem.action == #selector(quit) || menuItem.action == #selector(hideWindow) { return true }
        if model.nameDraft != nil || model.settingsPresented { return false }
        if menuItem.action == #selector(settings) { return model.state != nil }
        if menuItem.action == #selector(closeSession) || menuItem.action == #selector(splitRight) || menuItem.action == #selector(splitDown) { return model.selectedID != nil && !model.busy }
        return model.ready && !model.busy
    }

    @objc private func toggleSidebar() { model.sidebarVisible.toggle() }
    @objc private func settings() { model.settingsPresented = true }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func hideWindow() {
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
    private func selectedProjectDirectory() async throws -> URL {
        guard let bridge = model.bridge, let state = model.state else { throw BridgeFailure(code: "CLOSED", message: localized("Client is closed.", "客户端已关闭。")) }
        let context = try await bridge.projectContext(expectedRevision: state.snapshot.revision)
        guard let path = context.directory, path.hasPrefix("/") else { throw BridgeFailure(code: "LOCAL_PROJECT", message: localized("Select a local project or Worktree first.", "请先选择本地项目或 Worktree。")) }
        return URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
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
            let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
            guard file.standardizedFileURL.path.hasPrefix(prefix) else { self.model.error = localized("Choose a file inside the selected project.", "请选择所选项目中的文件。") ; return }
            let path = String(file.standardizedFileURL.path.dropFirst(prefix.count))
            Task { @MainActor in
                do { _ = try await self.makeEditableContentWindow(directory: root, path: path) }
                catch { self.model.error = error.localizedDescription }
            }
        }
    }
    private func makeEditableContentWindow(directory: URL, path: String) async throws -> ContentWindow {
        guard !mutatingRepository, !model.worktreeDeletionPresented, !model.gitFavoritesRecoveryPresented else { throw BridgeFailure(code: "GIT_BUSY", message: localized("Finish the current repository operation first.", "请先完成当前仓库操作。")) }
        if let content = existingContent(directory: directory, path: path, editable: true) {
            content.showWindow(nil)
            return content
        }
        guard let bridge = model.bridge else { throw BridgeFailure(code: "CLOSED", message: "Client is closed") }
        do { _ = try await bridge.call("editor.drafts.list", params: .object(["directory": .string(directory.path)])) }
        catch let error as BridgeFailure where error.code == "DRAFTS_NOT_IMPORTED" {
            _ = try await bridge.call("editor.drafts.import", params: .object([:]))
        }
        return try makeContentWindow(directory: directory, path: path, editable: true)
    }
    private func makeContentWindow(directory: URL, path: String, editable: Bool = false) throws -> ContentWindow {
        guard !preparingQuit else { throw BridgeFailure(code: "QUIT_BUSY", message: localized("The client is preparing to quit.", "客户端正在准备退出。")) }
        guard let bridge = model.bridge else { throw BridgeFailure(code: "CLOSED", message: localized("Client is closed.", "客户端已关闭。")) }
        if let content = existingContent(directory: directory, path: path, editable: editable) {
            content.showWindow(nil)
            return content
        }
        let content = try ContentWindow(bridge: bridge, directory: directory, path: path, editable: editable)
        let id = UUID()
        contentWindows[id] = content
        content.closed = { [weak self] in self?.contentWindows.removeValue(forKey: id) }
        content.showWindow(nil)
        return content
    }

    private func existingContent(directory: URL, path: String, editable: Bool) -> ContentWindow? {
        let root = directory.standardizedFileURL.resolvingSymlinksInPath()
        return contentWindows.values.first { !$0.gitMode && $0.directory == root && $0.path == path && $0.editable == editable }
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
                _ = try await self.makeEditableContentWindow(directory: root, path: path)
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
        if let run = javaWindows.values.first(where: { $0.window === NSApp.keyWindow }) { run.window?.performClose(nil); return }
        if let run = pythonWindows.values.first(where: { $0.window === NSApp.keyWindow }) { run.window?.performClose(nil); return }
        if let content = contentWindows.values.first(where: { $0.window === NSApp.keyWindow }) { content.window?.performClose(nil) }
        else { Task { await model.closeSession() } }
    }
    @objc private func splitRight() { Task { await model.split("horizontal") } }
    @objc private func splitDown() { Task { await model.split("vertical") } }
    @objc private func increaseFont() { Task { await model.mutate("settings.font.adjust", ["key": .string("fontSize"), "delta": .number(1)]) } }
    @objc private func decreaseFont() { Task { await model.mutate("settings.font.adjust", ["key": .string("fontSize"), "delta": .number(-1)]) } }

    func windowDidUpdate(_ notification: Notification) {
        guard let responder = window?.firstResponder else { return }
        DispatchQueue.main.async { [weak self, weak responder] in
            guard let self, let responder, self.window?.firstResponder === responder,
                  self.model.ready, !self.model.busy, !self.model.settingsPresented, !self.model.editorRecoveryPresented, self.model.nameDraft == nil,
                  let session = self.model.terminals.values.first(where: { $0.view === responder }),
                  session.id != self.model.selectedID else { return }
            Task { await self.model.selectSession(session.id, focus: false) }
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { if !model.worktreeDeletionPresented && !model.gitFavoritesRecoveryPresented { sender.orderOut(nil) }; return false }
    func windowDidEnterFullScreen(_ notification: Notification) { model.fullScreen = true }
    func windowDidExitFullScreen(_ notification: Notification) { model.fullScreen = false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window?.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating { return .terminateNow }
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
        if preparingQuit || mutatingRepository || model.editorRecoveryPresented || model.worktreeDeletionPresented || model.gitFavoritesRecoveryPresented || pythonWindows.values.contains(where: { $0.model.busy }) { return .terminateCancel }
        preparingQuit = true
        Task { @MainActor in
            guard await model.confirmQuit() else { self.preparingQuit = false; return }
            let contents = Array(self.contentWindows.values)
            let runs = Array(self.pythonWindows.values)
            let javaRuns = Array(self.javaWindows.values)
            do {
                for run in runs {
                    guard await run.prepareForQuit() else { throw BridgeFailure(code: "PYTHON_QUIT_REFUSED", message: localized("Resolve Python configuration changes before quitting.", "退出前请处理 Python 配置修改。")) }
                }
                for run in javaRuns {
                    guard await run.prepareForQuit() else { throw BridgeFailure(code: "JAVA_QUIT_REFUSED", message: localized("Resolve Java configuration changes before quitting.", "退出前请处理 Java 配置修改。")) }
                }
                for content in contents {
                    guard try await content.prepareForQuit() else {
                        throw BridgeFailure(code: "QUIT_REFUSED", message: localized("Save or resolve file changes before quitting.", "退出前请保存或处理文件修改。"))
                    }
                }
                guard contents.allSatisfy({ $0.isPreparedForQuit }) else {
                    throw BridgeFailure(code: "CONTENT_CHANGED", message: localized("A file window changed while preparing to quit. Try again.", "准备退出时文件窗口已变化，请重试。"))
                }
            } catch {
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
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}
