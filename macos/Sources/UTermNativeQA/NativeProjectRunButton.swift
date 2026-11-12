import AppKit
import SwiftUI
import UTermBridge

@MainActor
final class NativeProjectRunsModel: ObservableObject {
    weak var workspace: WorkspaceModel?
    @Published private(set) var tasks: [JSONValue] = []
    @Published private(set) var error = ""
    private var loading = false
    init(_ workspace: WorkspaceModel) { self.workspace = workspace }
    func refresh() async {
        if loading {
            while loading { do { try await Task.sleep(for: .milliseconds(10)) } catch { return } }
        }
        guard let workspace, workspace.ready, let bridge = workspace.bridge else { return }
        loading = true; defer { loading = false }
        do {
            let values = try await bridge.call("project.tasks")
            guard !Task.isCancelled else { return }
            tasks = values.array.sorted { ($0["task"]["created"].number ?? 0) > ($1["task"]["created"].number ?? 0) }; error = ""
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func tasks(_ language: String) -> [JSONValue] {
        tasks.filter { value in
            let action = value["task"]["action"].string ?? ""
            return value["running"].bool == true && (language == "java" ? action == "run" : action == "python:run" || action.hasPrefix("python:run|"))
        }
    }
}

@MainActor
struct NativeProjectRunButton: NSViewRepresentable {
    @ObservedObject var model: WorkspaceModel
    @ObservedObject var runs: NativeProjectRunsModel
    @ObservedObject var panels: NativeWorkspacePanels
    let language: String
    private var title: String { language == "java" ? localized("Java build and run…", "Java 构建与运行…") : localized("Python run…", "Python 运行…") }
    func makeCoordinator() -> Coordinator { Coordinator(model: model, language: language) }
    func makeNSView(context: Context) -> RunButton {
        let button = RunButton(title: "", target: context.coordinator, action: #selector(Coordinator.activate))
        button.isBordered = false; button.setButtonType(.momentaryPushIn); button.imagePosition = .imageOnly
        button.wantsLayer = true; button.layer?.cornerRadius = 4
        button.identifier = .init("native-project-run-" + language)
        button.menuRequested = { [weak coordinator = context.coordinator] in coordinator?.openMenu() }
        return button
    }
    func updateNSView(_ button: RunButton, context: Context) {
        context.coordinator.button = button
        button.isEnabled = context.environment.isEnabled && model.ready && !model.busy
        let icon = NativeChromeImages.toolbar(language == "java" ? .java : .python).copy() as! NSImage
        icon.size = NSSize(width: 18, height: 18); button.image = icon
        button.running = !runs.tasks(language).isEmpty; button.needsDisplay = true
        button.toolTip = title; button.setAccessibilityLabel(title)
        let active = panels.active(in: model.inspectorContextKey)?.id.hasPrefix(language + "-") == true
        button.state = active ? .on : .off
        let palette = NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog)
        let color = NativePreferences.color(palette["accent"], fallback: .controlAccentColor)
        button.layer?.backgroundColor = active ? color.withAlphaComponent(0.14).cgColor : NSColor.clear.cgColor
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: RunButton, context: Context) -> CGSize? { CGSize(width: 30, height: 30) }
    @MainActor final class RunButton: NSButton {
        var menuRequested: (() -> Void)?
        var running = false
        override func draw(_ dirtyRect: NSRect) {
            super.draw(dirtyRect)
            if running { NSColor.systemGreen.setFill(); NSBezierPath(ovalIn: NSRect(x: bounds.maxX - 10, y: bounds.minY + 5, width: 5, height: 5)).fill() }
        }
        override var acceptsFirstResponder: Bool { isEnabled }
        override func rightMouseDown(with event: NSEvent) { if isEnabled { menuRequested?() } }
        override func keyDown(with event: NSEvent) {
            if isEnabled && event.modifierFlags.contains(.shift) && event.keyCode == 109 { menuRequested?(); return }
            super.keyDown(with: event)
        }
    }
    @MainActor final class Coordinator: NSObject {
        let model: WorkspaceModel
        let language: String
        weak var button: RunButton?
        init(model: WorkspaceModel, language: String) { self.model = model; self.language = language }
        @objc func activate() {
            guard button?.isEnabled == true else { return }
            if model.panels.active(in: model.inspectorContextKey)?.id.hasPrefix(language + "-") == true {
                model.panels.showTerminal(in: model.inspectorContextKey); model.revealSelectedPane()
            } else if language == "java" { model.openJavaRequested?() } else { model.openPythonRequested?() }
        }
        func menu() -> NSMenu {
            let menu = NSMenu(); menu.autoenablesItems = false
            let heading = NSMenuItem(title: language == "java" ? localized("Java launch list", "Java 启动列表") : localized("Python launch list", "Python 启动列表"), action: nil, keyEquivalent: "")
            heading.isEnabled = false; menu.addItem(heading); menu.addItem(.separator())
            if !model.projectRuns.error.isEmpty {
                menu.addItem(withTitle: model.projectRuns.error, action: nil, keyEquivalent: "")
            } else if model.projectRuns.tasks(language).isEmpty {
                menu.addItem(withTitle: localized("No running projects", "暂无运行项目"), action: nil, keyEquivalent: "")
            }
            for task in model.projectRuns.tasks(language) {
                let root = task["task"]["root"].string ?? ""
                let item = NSMenuItem(title: (task["task"]["name"].string ?? "") + "\n" + root, action: #selector(selectTask(_:)), keyEquivalent: "")
                item.target = self; item.representedObject = task; item.toolTip = root; menu.addItem(item)
            }
            return menu
        }
        func openMenu() {
            guard let button, button.isEnabled else { return }
            Task { @MainActor in
                await model.projectRuns.refresh()
                guard button.isEnabled, button.window != nil else { return }
                menu().popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.maxY), in: button)
                button.window?.makeFirstResponder(button)
            }
        }
        @objc func selectTask(_ item: NSMenuItem) {
            guard let task = item.representedObject as? JSONValue else { return }
            model.revealProjectRunRequested?(language, task)
        }
    }
}
