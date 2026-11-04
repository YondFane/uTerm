import AppKit
import SwiftTerm
import UTermBridge

@MainActor
final class TerminalSession: NSObject, @preconcurrency TerminalViewDelegate {
    let id: String
    let view: TerminalView
    private(set) var bridge: CoreBridge
    private(set) var attachment = UUID().uuidString
    private(set) var generation: String?
    private(set) var error = ""
    private(set) var exited = false
    var changed: (() -> Void)?
    private var connecting: Task<Void, Never>?
    private var inputTask: Task<Void, Never>?
    private var input = Data()
    private var inputRevision = 0
    private(set) var inputControl: CoreInputControl?
    private(set) var takingInputControl = false
    private var hostSize: (Int, Int)?
    private var viewportSize: (Int, Int)?
    private var desiredSize: (Int, Int)?
    private var reconnecting = false
    private var applyingReplay = false
    private var entry: CoreSessionEntry
    private let taskGeneration: String?
    private(set) var taskLogFollowsOutput = true
    private var applyingTaskLogViewport = false
    var qaRenderDelay: Duration?
    private(set) var qaWaitingToRender = false
    private(set) var qaRenderedBytes = 0
    private(set) var qaRenderedFrames = 0
    private(set) var qaAcknowledgedFrames = 0
    private(set) var qaLargestFrame = 0

    init(entry: CoreSessionEntry, bridge: CoreBridge, taskGeneration: String? = nil) {
        self.entry = entry
        self.bridge = bridge
        self.taskGeneration = taskGeneration
        id = entry.session["id"].string ?? ""
        view = TerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 500))
        super.init()
        view.terminalDelegate = self
        if taskGeneration != nil { view.allowMouseReporting = false }
    }
    func update(entry: CoreSessionEntry) { self.entry = entry }
    func rebind(_ bridge: CoreBridge) {
        self.bridge = bridge
        attachment = UUID().uuidString
        generation = nil
        inputControl = nil
        hostSize = nil
        exited = false
        error = ""
        reconnecting = false
    }
    func reportFailure(_ failure: TerminalFailure) {
        if let generation, failure.generation != generation { return }
        error = failure.code == "TERMINAL_BACKPRESSURE" ? localized("Output paused. Reconnect to replay.", "输出已暂停，请重新连接以回放。") : failure.message
        changed?()
    }

    func apply(settings: JSONValue) {
        let size = CGFloat(settings["fontSize"].number ?? 14)
        let weight: NSFont.Weight = settings["fontThicken"].bool == true ? .bold : .regular
        let font = NSFont.monospacedSystemFont(ofSize: size, weight: weight)
        if !view.font.isEqual(font) { view.font = font }
        let scrollback = Int(settings["scrollback"].number ?? 3000)
        if view.getTerminal().options.scrollback != scrollback { view.getTerminal().changeScrollback(scrollback) }
        let light = settings["appearance"].string == "light"
        view.nativeBackgroundColor = light ? .white : NSColor(calibratedWhite: 0.06, alpha: 1)
        view.nativeForegroundColor = light ? .black : NSColor(calibratedWhite: 0.9, alpha: 1)
    }

    func connect(reconnectOnly: Bool = false) async {
        if let connecting { await connecting.value; return }
        if generation != nil && error.isEmpty { return }
        let token = attachment
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.connecting = nil; self.changed?() }
            do {
                let terminal = self.view.getTerminal()
                var params: [String: JSONValue] = [
                    "id": .string(self.id), "attachment": .string(token),
                    "directory": .string(self.entry.directory),
                    "shell": self.entry.session["shell"], "rows": .number(Double(terminal.rows)),
                    "cols": .number(Double(terminal.cols)), "reconnectOnly": .bool(reconnectOnly)
                ]
                if let agent = self.entry.session["agent"].string { params["agent"] = .string(agent) }
                if self.taskGeneration != nil { params["taskOnly"] = .bool(true) }
                if self.entry.session["ssh"] != .null {
                    throw BridgeFailure(code: "UNSUPPORTED", message: localized("SSH service adoption is pending.", "SSH 服务接入尚待完成。"))
                }
                let result = try await self.bridge.call("terminal.open", params: .object(params))
                guard self.attachment == token else { return }
                if let expected = self.taskGeneration, result["generation"].string != expected {
                    _ = try await self.bridge.call("terminal.action", params: .object(["attachment": .string(token), "action": .string("detach")]))
                    throw BridgeFailure(code: "TASK_REPLACED", message: localized("The task changed. Reload its status.", "任务已变化，请重新读取状态。"))
                }
                self.generation = result["generation"].string
                self.error = ""
                await self.resizeIfNeeded()
            } catch { self.error = error.localizedDescription }
        }
        connecting = task
        await task.value
    }

    func receive(_ packet: TerminalPacket) async {
        guard packet.header.attachment == attachment else { return }
        if let expected = taskGeneration, packet.header.generation != expected { return }
        if let generation, generation != packet.header.generation { return }
        generation = packet.header.generation
        if let message = packet.header.error { error = message; changed?(); return }
        if let delay = qaRenderDelay {
            qaWaitingToRender = true
            try? await Task.sleep(for: delay)
            qaWaitingToRender = false
            guard packet.header.attachment == attachment, packet.header.generation == generation else { return }
        }
        let terminal = view.getTerminal()
        let previousControl = inputControl?.owned
        inputControl = packet.header.input_control
        hostSize = (Int(packet.header.cols), Int(packet.header.rows))
        if previousControl != inputControl?.owned {
            inputRevision += 1
            input.removeAll()
            view.allowMouseReporting = taskGeneration == nil && inputControl?.owned != false
            changed?()
        }
        let pausedAnchor = taskGeneration != nil && !taskLogFollowsOutput
            ? terminal.buffer.totalLinesTrimmed + terminal.buffer.yDisp : nil
        if taskGeneration != nil { applyingTaskLogViewport = true }
        if packet.header.reset {
            let intended = viewportSize ?? desiredSize ?? (terminal.cols, terminal.rows)
            viewportSize = intended
            applyingReplay = true
            terminal.resetToInitialState()
            terminal.resize(cols: Int(packet.header.cols), rows: Int(packet.header.rows))
            view.feed(byteArray: Array(packet.bytes)[...])
            if inputControl?.owned != false { terminal.resize(cols: intended.0, rows: intended.1) }
            applyingReplay = false
            desiredSize = intended
        } else {
            restorePassiveSize()
            view.feed(byteArray: Array(packet.bytes)[...])
        }
        if previousControl == false && inputControl?.owned == true, let viewportSize {
            applyingReplay = true
            terminal.resize(cols: viewportSize.0, rows: viewportSize.1)
            applyingReplay = false
            desiredSize = viewportSize
        }
        if taskGeneration != nil {
            if let anchor = pausedAnchor {
                view.scrollTo(row: max(0, anchor - terminal.buffer.totalLinesTrimmed), notifyAccessibility: false)
            } else {
                view.scrollDown(lines: terminal.options.scrollback + terminal.rows)
            }
            applyingTaskLogViewport = false
        }
        qaRenderedBytes += packet.bytes.count
        qaRenderedFrames += 1
        qaLargestFrame = max(qaLargestFrame, packet.bytes.count)
        let wasExited = exited
        exited = packet.header.exited
        if wasExited != exited { changed?() }
        do {
            _ = try await bridge.call("terminal.action", params: .object([
                "attachment": .string(attachment), "action": .string("ack"),
                "sequence": .unsigned(packet.header.sequence)
            ]))
            qaAcknowledgedFrames += 1
        } catch { self.error = error.localizedDescription; changed?() }
        await resizeIfNeeded()
    }

    func reconnect() async {
        guard !reconnecting else { return }
        reconnecting = true
        defer { reconnecting = false }
        if let connecting { await connecting.value }
        await drainInput()
        let previous = attachment
        do { _ = try await bridge.call("terminal.action", params: .object(["attachment": .string(previous), "action": .string("detach")])) }
        catch { self.error = error.localizedDescription }
        attachment = UUID().uuidString
        generation = nil
        inputControl = nil
        hostSize = nil
        exited = false
        input.removeAll()
        await connect(reconnectOnly: true)
    }

    func enqueue(_ bytes: Data) {
        guard taskGeneration == nil, inputControl?.owned != false, generation != nil, error.isEmpty, !exited, !reconnecting else { return }
        guard input.count + bytes.count <= 1024 * 1024 else {
            error = localized("Input queue is full. Wait before pasting again.", "输入队列已满，请等待后再粘贴。")
            changed?(); return
        }
        input.append(bytes)
        if inputTask != nil { return }
        inputTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.inputTask = nil }
            while !self.input.isEmpty {
                let bytes = Data(self.input.prefix(16 * 1024))
                let revision = self.inputRevision
                do {
                    try await self.bridge.write(attachment: self.attachment, bytes: bytes)
                    if revision == self.inputRevision { self.input.removeFirst(bytes.count) }
                } catch {
                    if revision != self.inputRevision { continue }
                    self.input.removeAll()
                    self.error = error.localizedDescription
                    self.changed?(); return
                }
            }
        }
    }

    func drainInput() async { if let inputTask { await inputTask.value } }
    func cancelConnection() { connecting?.cancel() }
    func pauseForRebind() { reconnecting = true; connecting?.cancel() }
    func finishConnection() async { if let connecting { await connecting.value } }

    private func resizeIfNeeded() async {
        guard generation != nil, inputControl?.owned != false, let (cols, rows) = desiredSize else { return }
        desiredSize = nil
        do { _ = try await bridge.call("terminal.action", params: .object([
            "attachment": .string(attachment), "action": .string("resize"),
            "cols": .number(Double(cols)), "rows": .number(Double(rows))
        ])) } catch { self.error = error.localizedDescription; changed?() }
    }

    func takeInputControl() async {
        guard taskGeneration == nil, inputControl?.owned == false, !takingInputControl, !exited else { return }
        takingInputControl = true
        changed?()
        defer { takingInputControl = false; changed?() }
        let size = viewportSize ?? (view.getTerminal().cols, view.getTerminal().rows)
        do {
            _ = try await bridge.call("terminal.action", params: .object([
                "attachment": .string(attachment), "action": .string("takeControl"),
                "cols": .number(Double(size.0)), "rows": .number(Double(size.1))
            ]))
            error = ""
            view.window?.makeFirstResponder(view)
        } catch { self.error = error.localizedDescription }
    }

    private func restorePassiveSize() {
        guard inputControl?.owned == false, let hostSize else { return }
        let terminal = view.getTerminal()
        guard terminal.cols != hostSize.0 || terminal.rows != hostSize.1 else { return }
        applyingReplay = true
        terminal.resize(cols: hostSize.0, rows: hostSize.1)
        applyingReplay = false
    }

    var text: String {
        let terminal = view.getTerminal()
        var lines: [String] = []
        let start = terminal.buffer.totalLinesTrimmed
        for row in start..<(start + terminal.options.scrollback + terminal.rows) {
            guard let line = terminal.getScrollInvariantLine(row: row) else { break }
            lines.append(line.translateToString(trimRight: true, skipNullCellsFollowingWide: true, characterProvider: { terminal.getCharacter(for: $0) }))
        }
        return lines.joined(separator: "\n")
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard newCols > 0, newRows > 0, newCols <= 1000, newRows <= 1000 else { return }
        guard !applyingReplay else { return }
        viewportSize = (newCols, newRows)
        desiredSize = (newCols, newRows)
        if inputControl?.owned == false { restorePassiveSize(); return }
        Task { await resizeIfNeeded() }
    }
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    func send(source: TerminalView, data: ArraySlice<UInt8>) { enqueue(Data(data)) }
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {
        guard taskGeneration != nil, !applyingTaskLogViewport, position < 1 else { return }
        let terminal = view.getTerminal()
        if terminal.getScrollInvariantLine(row: terminal.buffer.totalLinesTrimmed + terminal.rows) != nil {
            taskLogFollowsOutput = false
            changed?()
        }
    }
    func followTaskLog(_ follow: Bool) {
        guard taskGeneration != nil else { return }
        taskLogFollowsOutput = follow
        if follow {
            applyingTaskLogViewport = true
            let terminal = view.getTerminal()
            view.scrollDown(lines: terminal.options.scrollback + terminal.rows)
            applyingTaskLogViewport = false
        }
        changed?()
    }
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return }
        NSWorkspace.shared.open(url)
    }
}
