import AppKit
import SwiftUI

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
    private let model = WorkspaceModel()
    private var terminating = false

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
        model.appearanceChanged = { [weak window] appearance in
            window?.appearance = appearance == "dark" ? NSAppearance(named: .darkAqua) : appearance == "light" ? NSAppearance(named: .aqua) : nil
        }
        configureMenu()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task { @MainActor in
            await model.start()
            if let report = WorkspaceModel.argument("--smoke-report") { writeSmokeReport(report) }
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
        if menuItem.action == #selector(quit) || menuItem.action == #selector(hideWindow) { return true }
        if model.nameDraft != nil || model.settingsPresented { return false }
        if menuItem.action == #selector(settings) { return model.state != nil }
        if menuItem.action == #selector(closeSession) || menuItem.action == #selector(splitRight) || menuItem.action == #selector(splitDown) { return model.selectedID != nil && !model.busy }
        return model.ready && !model.busy
    }

    @objc private func toggleSidebar() { model.sidebarVisible.toggle() }
    @objc private func settings() { model.settingsPresented = true }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func hideWindow() { window?.performClose(nil) }
    @objc private func openProject() { model.openProject() }
    @objc private func newWorkspace() { model.newWorkspace() }
    @objc private func newTerminal() { Task { await model.newTerminal() } }
    @objc private func newAgent() { Task { await model.newDefaultAgent() } }
    @objc private func closeSession() { Task { await model.closeSession() } }
    @objc private func splitRight() { Task { await model.split("horizontal") } }
    @objc private func splitDown() { Task { await model.split("vertical") } }
    @objc private func increaseFont() { Task { await model.mutate("settings.font.adjust", ["key": .string("fontSize"), "delta": .number(1)]) } }
    @objc private func decreaseFont() { Task { await model.mutate("settings.font.adjust", ["key": .string("fontSize"), "delta": .number(-1)]) } }

    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func windowDidEnterFullScreen(_ notification: Notification) { model.fullScreen = true }
    func windowDidExitFullScreen(_ notification: Notification) { model.fullScreen = false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window?.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating { return .terminateNow }
        Task { @MainActor in
            guard await model.confirmQuit() else { sender.reply(toApplicationShouldTerminate: false); return }
            await model.shutdown()
            terminating = true
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    private func baseReport() -> [String: Any] {
        ["windowVisible": window?.isVisible == true, "screenCount": NSScreen.screens.count,
         "bundleIdentifier": Bundle.main.bundleIdentifier ?? "", "minimumOS": Bundle.main.object(forInfoDictionaryKey: "LSMinimumSystemVersion") ?? "",
         "sourceSHA": Bundle.main.object(forInfoDictionaryKey: "UTermSourceSHA") ?? "", "productionDataAccess": false,
         "hostStarted": !model.terminals.isEmpty, "coreReady": model.ready, "sessionCount": model.state?.sessions.count ?? 0,
         "error": model.error]
    }
    private func writeSmokeReport(_ path: String) { finishReport(baseReport(), path: path) }
    private func finishReport(_ report: [String: Any], path: String) {
        do {
            try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: path), options: .atomic)
            NSApp.terminate(nil)
        } catch { fputs("Native smoke report failed: \(error)\n", stderr); exit(1) }
    }

    private func runTerminalSmoke(_ path: String, reconnect: Bool) async {
        var report = baseReport()
        do {
            try await TerminalSmoke.run(model: model, window: window, reconnect: reconnect, report: &report)
            finishReport(report, path: path)
        } catch {
            report["failure"] = error.localizedDescription
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
