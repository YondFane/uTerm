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
    private let model = WorkspaceModel()
    private var terminating = false
    private var preparingQuit = false

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
        configureMenu()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task { @MainActor in
            await model.start()
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
        if preparingQuit { return false }
        if menuItem.action == #selector(closeSession) {
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
        if let content = contentWindows.values.first(where: { $0.window === NSApp.keyWindow }) { content.window?.performClose(nil) }
        else { window?.performClose(nil) }
    }
    @objc private func openProject() { model.openProject() }
    @objc private func openFile() {
        guard model.bridge != nil, let selected = model.workspace["selectedProject"].string,
              let project = model.workspace["projects"].array.first(where: { $0["id"].string == selected }),
              let path = project["directory"].string else {
            model.error = localized("Select a local project before opening a file.", "打开文件前请先选择本地项目。")
            return
        }
        let root = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = root
        guard let window else { return }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let self, let file = panel.url else { return }
            let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
            guard file.standardizedFileURL.path.hasPrefix(prefix) else { self.model.error = localized("Choose a file inside the selected project.", "请选择所选项目中的文件。") ; return }
            do {
                _ = try self.makeContentWindow(directory: root, path: String(file.standardizedFileURL.path.dropFirst(prefix.count)))
            } catch { self.model.error = error.localizedDescription }
        }
    }
    private func makeContentWindow(directory: URL, path: String) throws -> ContentWindow {
        guard !preparingQuit else { throw BridgeFailure(code: "QUIT_BUSY", message: localized("The client is preparing to quit.", "客户端正在准备退出。")) }
        guard let bridge = model.bridge else { throw BridgeFailure(code: "CLOSED", message: localized("Client is closed.", "客户端已关闭。")) }
        let content = try ContentWindow(bridge: bridge, directory: directory, path: path)
        let id = UUID()
        contentWindows[id] = content
        content.closed = { [weak self] in self?.contentWindows.removeValue(forKey: id) }
        content.showWindow(nil)
        return content
    }

    @objc private func newWorkspace() { model.newWorkspace() }
    @objc private func newTerminal() { Task { await model.newTerminal() } }
    @objc private func newAgent() { Task { await model.newDefaultAgent() } }
    @objc private func closeSession() {
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
                  self.model.ready, !self.model.busy, !self.model.settingsPresented, self.model.nameDraft == nil,
                  let session = self.model.terminals.values.first(where: { $0.view === responder }),
                  session.id != self.model.selectedID else { return }
            Task { await self.model.selectSession(session.id, focus: false) }
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func windowDidEnterFullScreen(_ notification: Notification) { model.fullScreen = true }
    func windowDidExitFullScreen(_ notification: Notification) { model.fullScreen = false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window?.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating { return .terminateNow }
        if preparingQuit { return .terminateCancel }
        preparingQuit = true
        Task { @MainActor in
            guard await model.confirmQuit() else { self.preparingQuit = false; return }
            let contents = Array(self.contentWindows.values)
            do {
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
                self.model.error = error.localizedDescription
                self.preparingQuit = false
                return
            }
            for content in contents { content.forceClose() }
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
    private func finishReport(_ report: [String: Any], path: String) {
        do {
            try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: path), options: .atomic)
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
            report["terminalDiagnostics"] = model.terminals.values.map { ["id": $0.id, "generation": $0.generation ?? "", "error": $0.error, "exited": $0.exited, "text": String($0.text.suffix(4096))] as [String: Any] }
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
