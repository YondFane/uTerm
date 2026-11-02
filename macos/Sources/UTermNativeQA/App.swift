import AppKit
import SwiftUI

func localized(_ english: String, _ chinese: String) -> String {
    Locale.preferredLanguages.first?.hasPrefix("zh") == true ? chinese : english
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = "uTerm Native QA"
        window.minSize = NSSize(width: 640, height: 420)
        window.delegate = self
        window.contentView = NSHostingView(rootView: EmptyWorkspace())
        window.center()
        self.window = window
        configureMenu()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let report = argument("--smoke-report") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.writeSmokeReport(report)
            }
        }
    }

    private func configureMenu() {
        let menu = NSMenu()
        let item = NSMenuItem()
        menu.addItem(item)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: localized("Quit uTerm Native QA", "退出 uTerm 原生 QA"),
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu
        let windowItem = NSMenuItem()
        menu.addItem(windowItem)
        let windowMenu = NSMenu(title: localized("Window", "窗口"))
        windowMenu.addItem(withTitle: localized("Close Window", "关闭窗口"),
                           action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    private func argument(_ name: String) -> String? {
        guard let index = CommandLine.arguments.firstIndex(of: name),
              index + 1 < CommandLine.arguments.count else { return nil }
        return CommandLine.arguments[index + 1]
    }

    private func writeSmokeReport(_ path: String) {
        let report: [String: Any] = [
            "windowVisible": window?.isVisible == true,
            "screenCount": NSScreen.screens.count,
            "bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
            "minimumOS": Bundle.main.object(forInfoDictionaryKey: "LSMinimumSystemVersion") ?? "",
            "sourceSHA": Bundle.main.object(forInfoDictionaryKey: "UTermSourceSHA") ?? "",
            "productionDataAccess": false,
            "hostStarted": false
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            NSApp.terminate(nil)
        } catch {
            fputs("Native smoke report failed: \(error)\n", stderr)
            exit(1)
        }
    }
}

struct EmptyWorkspace: View {
    var body: some View {
        VStack(spacing: 16) {
            Text("uTerm Native QA").font(.title)
            Text(localized("No project is open.", "尚未打开项目。"))
            Text(localized("Isolated development application", "隔离开发应用"))
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("native-empty-workspace")
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
