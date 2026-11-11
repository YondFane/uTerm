import AppKit
import UTermBridge

@MainActor
enum NativeCommandKey {
    static func label(_ chord: String) -> String {
        let item = NSMenuItem(); apply(chord, to: item)
        guard !item.keyEquivalent.isEmpty else { return "" }
        let arrows = ["ArrowLeft": "←", "ArrowRight": "→", "ArrowUp": "↑", "ArrowDown": "↓", "Enter": "↩"]
        let code = chord.split(separator: "+").last.map(String.init) ?? ""
        return (item.keyEquivalentModifierMask.contains(.control) ? "⌃" : "") + (item.keyEquivalentModifierMask.contains(.option) ? "⌥" : "") + (item.keyEquivalentModifierMask.contains(.shift) ? "⇧" : "") + "⌘" + (arrows[code] ?? item.keyEquivalent.uppercased())
    }
    static func apply(_ chord: String, to item: NSMenuItem) {
        let parts = chord.split(separator: "+").map(String.init)
        guard parts.first == "Mod", let code = parts.last else { item.keyEquivalent = ""; return }
        let punctuation = ["Comma": ",", "Period": ".", "Slash": "/", "Backslash": "\\", "Minus": "-", "Equal": "=", "BracketLeft": "[", "BracketRight": "]", "Enter": "\r"]
        let arrows: [String: Int] = ["ArrowLeft": NSLeftArrowFunctionKey, "ArrowRight": NSRightArrowFunctionKey, "ArrowUp": NSUpArrowFunctionKey, "ArrowDown": NSDownArrowFunctionKey]
        if code.hasPrefix("Key") {
            // AppKit needs uppercase equivalents to distinguish shifted letter chords.
            // AppKit 需要大写键等价项，才能区分带 Shift 的字母组合。
            let letter = String(code.dropFirst(3))
            item.keyEquivalent = parts.contains("Shift") ? letter.uppercased() : letter.lowercased()
        }
        else if code.hasPrefix("Digit") { item.keyEquivalent = String(code.dropFirst(5)) }
        else if let arrow = arrows[code], let scalar = UnicodeScalar(arrow) { item.keyEquivalent = String(scalar) }
        else { item.keyEquivalent = punctuation[code] ?? "" }
        item.keyEquivalentModifierMask = [.command]
        if parts.contains("Alt") { item.keyEquivalentModifierMask.insert(.option) }
        if parts.contains("Shift") { item.keyEquivalentModifierMask.insert(.shift) }
    }
}

@MainActor
final class NativeCommandPalette: NSObject, NSWindowDelegate, NSSearchFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
    let window: NSPanel
    private let search = NSSearchField()
    private let table = NSTableView()
    private var commands: [JSONValue] = []
    private var filtered: [JSONValue] = []
    private var available: (String) -> Bool = { _ in false }
    private var perform: (String) -> Void = { _ in }
    private var keyMonitor: Any?
    private(set) weak var returnWindow: NSWindow?
    private weak var returnResponder: NSResponder?
    override init() {
        window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 620, height: 420), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.isReleasedWhenClosed = false; window.delegate = self
        window.identifier = NSUserInterfaceItemIdentifier("native-command-palette")
        search.identifier = NSUserInterfaceItemIdentifier("native-command-search"); search.delegate = self
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.documentView = table
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("command")))
        table.headerView = nil; table.rowHeight = 30; table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.dataSource = self; table.delegate = self; table.target = self; table.doubleAction = #selector(executeSelection)
        table.identifier = NSUserInterfaceItemIdentifier("native-command-list")
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 620, height: 420))
        container.addSubview(search); container.addSubview(scroll)
        search.translatesAutoresizingMaskIntoConstraints = false; scroll.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            search.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12), search.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12), search.topAnchor.constraint(equalTo: container.topAnchor, constant: 12), search.heightAnchor.constraint(equalToConstant: 24),
            scroll.leadingAnchor.constraint(equalTo: search.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: search.trailingAnchor), scroll.topAnchor.constraint(equalTo: search.bottomAnchor, constant: 10), scroll.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -12)
        ])
        window.contentView = container; window.minSize = NSSize(width: 440, height: 300); window.center()
    }
    private func title(_ item: JSONValue) -> String { localized(item["labels"]["en"].string ?? "", item["labels"]["zh-Hans"].string ?? "") }
    func open(commands: [JSONValue], available: @escaping (String) -> Bool, perform: @escaping (String) -> Void) {
        if NSApp.keyWindow !== window { returnWindow = NSApp.keyWindow; returnResponder = returnWindow?.firstResponder }
        self.commands = commands; self.available = available; self.perform = perform
        window.title = localized("Command palette", "命令面板"); search.placeholderString = localized("Search commands", "搜索命令")
        window.appearance = returnWindow?.appearance; search.stringValue = ""; filter()
        if keyMonitor == nil {
            // Search fields consume Escape themselves; intercept only plain keys in this palette.
            // 搜索框会自行消耗 Escape，仅在此面板内接管未带修饰的导航按键。
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.window.isVisible, event.window === self.window, event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty else { return event }
                switch event.keyCode {
                case 53: self.dismiss(); return nil
                case 125: self.move(1); return nil
                case 126: self.move(-1); return nil
                case 36: self.executeSelection(); return nil
                default: return event
                }
            }
        }
        window.makeKeyAndOrderFront(nil); window.makeFirstResponder(search)
    }
    private func filter() {
        let query = search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        filtered = commands.filter { query.isEmpty || (title($0) + " " + ($0["id"].string ?? "")).localizedCaseInsensitiveContains(query) }
        table.reloadData()
        let row = filtered.firstIndex { available($0["id"].string ?? "") }
        table.selectRowIndexes(row.map { IndexSet(integer: $0) } ?? [], byExtendingSelection: false)
    }
    func numberOfRows(in tableView: NSTableView) -> Int { filtered.count }
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { filtered.indices.contains(row) && available(filtered[row]["id"].string ?? "") }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard filtered.indices.contains(row) else { return nil }
        let item = filtered[row], enabled = available(item["id"].string ?? "")
        let label = NSTextField(labelWithString: title(item)); label.textColor = enabled ? .labelColor : .disabledControlTextColor
        let shortcut = NSTextField(labelWithString: NativeCommandKey.label(item["shortcut"].string ?? "")); shortcut.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [label, NSView(), shortcut]); stack.spacing = 12
        if !enabled { stack.toolTip = localized("Unavailable", "不可用") }
        return stack
    }
    func controlTextDidChange(_ obj: Notification) { filter() }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        switch NSStringFromSelector(commandSelector) {
        case "insertNewline:": executeSelection(); return true
        case "cancelOperation:": dismiss(); return true
        case "moveUp:": move(-1); return true
        case "moveDown:": move(1); return true
        default: return false
        }
    }
    private func move(_ step: Int) {
        guard !filtered.isEmpty else { return }
        var index = table.selectedRow
        for _ in filtered.indices {
            index = (index + step + filtered.count) % filtered.count
            if available(filtered[index]["id"].string ?? "") { table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false); table.scrollRowToVisible(index); return }
        }
    }
    @objc private func executeSelection() {
        guard filtered.indices.contains(table.selectedRow), let id = filtered[table.selectedRow]["id"].string, available(id) else { NSSound.beep(); return }
        dismiss(); perform(id)
    }
    func dismiss() {
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor); self.keyMonitor = nil }
        window.orderOut(nil)
        returnWindow?.makeKeyAndOrderFront(nil)
        if let returnResponder { returnWindow?.makeFirstResponder(returnResponder) }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { dismiss(); return false }
}
