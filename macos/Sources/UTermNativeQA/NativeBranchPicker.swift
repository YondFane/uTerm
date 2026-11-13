import AppKit
import SwiftUI
import UTermBridge

@MainActor
final class NativeBranchPickerModel: ObservableObject {
    struct Context: Equatable {
        let key: String
        let projectID: String
        let directory: String
    }
    @Published private(set) var branches: JSONValue = .null
    @Published private(set) var context: Context?
    @Published private(set) var error = ""
    @Published private(set) var changing = false
    weak var workspace: WorkspaceModel?
    private var epoch = 0
    private var scopeKey: String?
    private var mutationFailure: String?
    var mutate: ((String, JSONValue, Context) async throws -> JSONValue)?
    init(_ workspace: WorkspaceModel) { self.workspace = workspace }
    var current: String { branches["current"].string ?? localized("Branch unavailable", "分支不可用") }
    var enabled: Bool { workspace?.ready == true && workspace?.busy == false && !changing && context != nil && branches["current"].string != nil }

    func refresh() async {
        epoch += 1
        let request = epoch
        guard let workspace, workspace.ready, let bridge = workspace.bridge else { context = nil; branches = .null; scopeKey = nil; mutationFailure = nil; return }
        let key = workspace.inspectorContextKey
        if scopeKey != key { scopeKey = key; context = nil; branches = .null; mutationFailure = nil; error = "" }
        do {
            let snapshot = try await bridge.snapshot()
            let saved = snapshot.document.workspace
            let savedKey = [saved["selectedWorkspace"].string ?? "local", saved["selectedProject"].string ?? "", saved["selectedWorktree"].string ?? ""].joined(separator: "\u{0}")
            guard savedKey == key else { return }
            let selected = try await bridge.projectContext(expectedRevision: snapshot.revision)
            guard request == epoch, key == workspace.inspectorContextKey, !Task.isCancelled else { return }
            guard let directory = selected.directory, let projectID = selected.projectId else { context = nil; branches = .null; return }
            let value = try await bridge.call("git.branches", params: .object(["directory": .string(directory)]))
            guard request == epoch, key == workspace.inspectorContextKey, !Task.isCancelled else { return }
            context = Context(key: key, projectID: projectID, directory: directory); branches = value; error = mutationFailure ?? ""
        } catch {
            guard request == epoch, key == workspace.inspectorContextKey, !Task.isCancelled else { return }
            context = nil; branches = .null; self.error = mutationFailure ?? error.localizedDescription
        }
    }
    func remote(_ captured: Context) async throws -> JSONValue {
        guard let workspace, workspace.inspectorContextKey == captured.key, context == captured, let bridge = workspace.bridge else {
            throw BridgeFailure(code: "GIT_CONTEXT_CHANGED", message: localized("The selected project changed. Reopen the branch menu.", "所选项目已变化，请重新打开分支菜单。"))
        }
        let value = try await bridge.call("git.remoteBranches", params: .object(["directory": .string(captured.directory)]))
        guard workspace.inspectorContextKey == captured.key, context == captured else { throw BridgeFailure(code: "GIT_CONTEXT_CHANGED", message: "The selected project changed") }
        return value
    }
    func clearOperationError() { mutationFailure = nil; error = "" }
    @discardableResult
    func execute(_ method: String, arguments: [String: JSONValue], captured: Context, expected: JSONValue) async -> Bool {
        guard !changing, let workspace, workspace.ready, !workspace.busy, let mutate else { return false }
        guard context == captured, workspace.inspectorContextKey == captured.key else {
            let message = localized("The selected project changed. Reopen the branch menu.", "所选项目已变化，请重新打开分支菜单。")
            mutationFailure = message; error = message; workspace.error = message; return false
        }
        changing = true; clearOperationError(); defer { changing = false }
        var values = arguments; values["directory"] = .string(captured.directory); values["expected"] = expected
        var completed = false
        do { _ = try await mutate(method, .object(values), captured); completed = true }
        catch { mutationFailure = error.localizedDescription; self.error = error.localizedDescription; workspace.error = error.localizedDescription }
        await refresh()
        return completed
    }
}

@MainActor
struct NativeBranchPicker: View {
    @ObservedObject var picker: NativeBranchPickerModel
    var settings: JSONValue
    var body: some View {
        if picker.branches["current"].string != nil || !picker.error.isEmpty {
            NativeBranchControl(picker: picker, settings: settings)
                .frame(maxWidth: min(220, ceil(((picker.current + " ⌄") as NSString).size(withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold)]).width) + 36))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

@MainActor
struct NativeBranchControl: NSViewRepresentable {
    @ObservedObject var picker: NativeBranchPickerModel
    var settings: JSONValue
    func makeNSView(context: Context) -> BranchButton {
        let button = BranchButton(title: "", target: nil, action: nil)
        button.cell = BranchCell(textCell: "")
        button.target = context.coordinator; button.action = #selector(Coordinator.openBranches)
        button.wantsLayer = true; button.layer?.cornerRadius = 4; button.layer?.borderWidth = 1
        button.isBordered = false; button.setButtonType(.momentaryPushIn); button.identifier = .init("native-branch-picker")
        let image = NativeChromeImages.sidebar(.branch).copy() as! NSImage
        image.size = NSSize(width: 15, height: 15); button.image = image; button.imagePosition = .imageLeft; button.alignment = .left
        button.actionsRequested = { [weak coordinator = context.coordinator] in coordinator?.open(actions: true) }
        return button
    }
    func updateNSView(_ button: BranchButton, context: Context) {
        context.coordinator.picker = picker; context.coordinator.button = button
        button.title = picker.current + " ⌄"; button.isEnabled = context.environment.isEnabled && picker.enabled
        button.font = .monospacedSystemFont(ofSize: 11, weight: .semibold)
        let palette = NativePreferences.interfacePalette(settings, catalog: picker.workspace?.settingsCatalog ?? .null)
        let text = NativePreferences.color(palette["text"], fallback: .labelColor)
        button.layer?.borderColor = NativePreferences.color(palette["border"], fallback: .separatorColor).cgColor
        button.contentTintColor = text
        let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byTruncatingTail
        button.attributedTitle = NSAttributedString(string: button.title, attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold), .foregroundColor: text, .paragraphStyle: paragraph])
        button.toolTip = picker.error.isEmpty ? localized("Switch branch · Right-click for Git actions", "切换分支 · 右键打开 Git 操作") + " · " + picker.current : picker.error
        button.setAccessibilityLabel(localized("Switch branch", "切换分支") + ": " + picker.current)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView button: BranchButton, context: Context) -> CGSize? {
        let limit: CGFloat = (button.window?.frame.width ?? 1100) <= 760 ? 140 : 220
        return CGSize(width: max(24, min(button.intrinsicContentSize.width, limit, proposal.width ?? limit)), height: 23)
    }
    @MainActor final class BranchCell: NSButtonCell {
        override func imageRect(forBounds rect: NSRect) -> NSRect { NSRect(x: rect.minX + 7, y: rect.midY - 7.5, width: 15, height: 15) }
        override func titleRect(forBounds rect: NSRect) -> NSRect {
            let normal = super.titleRect(forBounds: rect)
            return NSRect(x: rect.minX + 27, y: normal.minY, width: max(0, rect.width - 34), height: normal.height)
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(picker) }
    @MainActor final class BranchButton: NSButton {
        override var intrinsicContentSize: NSSize { NSSize(width: ceil(attributedTitle.size().width) + 36, height: 23) }
        var actionsRequested: (() -> Void)?
        override var acceptsFirstResponder: Bool { isEnabled }
        override func rightMouseDown(with event: NSEvent) { if isEnabled { actionsRequested?() } }
        override func keyDown(with event: NSEvent) {
            if event.keyCode == 109 && event.modifierFlags.contains(.shift) { actionsRequested?() }
            else if event.keyCode == 125 { performClick(nil) }
            else { super.keyDown(with: event) }
        }
    }
    @MainActor final class Coordinator: NSObject {
        var picker: NativeBranchPickerModel
        weak var button: BranchButton?
        private var commands: [String: (String, [String: JSONValue], NativeBranchPickerModel.Context, JSONValue)] = [:]
        init(_ picker: NativeBranchPickerModel) { self.picker = picker }
        @objc func openBranches() { open(actions: false) }
        func open(actions: Bool) {
            guard let button, button.isEnabled, picker.enabled, let captured = picker.context else { return }
            let expected = picker.branches["current"]
            Task { @MainActor in
                do {
                    let remote = actions ? JSONValue.null : try await picker.remote(captured)
                    guard picker.enabled, picker.context == captured, picker.workspace?.inspectorContextKey == captured.key, button.window?.isVisible == true else { return }
                    let menu = NSMenu(); menu.autoenablesItems = false; commands.removeAll()
                    @MainActor func note(_ title: String) { let item = NSMenuItem(title: title, action: nil, keyEquivalent: ""); item.isEnabled = false; menu.addItem(item) }
                    @MainActor func command(_ title: String, _ method: String, _ values: [String: JSONValue], enabled: Bool = true, checked: Bool = false) {
                        let id = UUID().uuidString
                        commands[id] = (method, values, captured, expected)
                        let item = NSMenuItem(title: title, action: #selector(performBranchAction(_:)), keyEquivalent: "")
                        item.target = self; item.representedObject = id; item.isEnabled = enabled; item.state = checked ? NSControl.StateValue.on : NSControl.StateValue.off; menu.addItem(item)
                    }
                    if actions {
                        note(picker.current); note(picker.branches["upstream"].string ?? localized("No upstream branch", "未设置上游分支"))
                        for action in ["push", "pull", "fetch"] {
                            command(action.capitalized, "git.branchAction", ["action": .string(action)], enabled: action == "fetch" || (expected.string != nil && picker.branches["upstream"].string != nil))
                        }
                        menu.addItem(.separator()); command(localized("Refresh", "刷新"), "refresh", [:])
                    } else {
                        note(localized("Local", "本地"))
                        for branch in picker.branches["local"].array.compactMap(\.string) {
                            command(branch, "git.switchBranch", ["branch": .string(branch)], enabled: branch != expected.string, checked: branch == expected.string)
                        }
                        menu.addItem(.separator()); note(localized("Remote", "远程"))
                        for branch in remote["branches"].array {
                            command((branch["remote"].string ?? "") + "/" + (branch["branch"].string ?? ""), "git.switchRemoteBranch", ["remote": branch["remote"], "branch": branch["branch"]])
                        }
                        for error in remote["errors"].array.compactMap(\.string) { note(error) }
                        if remote["branches"].array.isEmpty && remote["errors"].array.isEmpty { note(localized("No remote branches", "没有远程分支")) }
                    }
                    menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.maxY), in: button)
                } catch { picker.workspace?.error = error.localizedDescription }
            }
        }
        @objc private func performBranchAction(_ sender: NSMenuItem) {
            guard let id = sender.representedObject as? String, let (method, values, captured, expected) = commands[id] else { return }
            Task { if method == "refresh" { await picker.refresh() } else { _ = await picker.execute(method, arguments: values, captured: captured, expected: expected) } }
        }
    }
}
