import AppKit
import CryptoKit
import UTermBridge

@MainActor
enum PerformanceSmoke {
    private static func wait(_ label: String, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(30)
        while !condition() {
            guard Date() < deadline else { throw BridgeFailure(code: "PERFORMANCE_TIMEOUT", message: label) }
            try await Task.sleep(for: .milliseconds(25))
        }
    }
    static func run(model: WorkspaceModel, window: NSWindow, report: inout [String: Any]) async throws {
        guard let bridge = model.bridge, let path = WorkspaceModel.argument("--performance-smoke-report"),
              let fixtureURL = Bundle.main.url(forResource: "client-performance", withExtension: "json") else { throw BridgeFailure(code: "PERFORMANCE_CONTEXT", message: "Missing isolated performance fixture") }
        let fixtureBytes = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode(JSONValue.self, from: fixtureBytes)
        guard fixture["sessions"].number == 1, let cycles = fixture["cycles"].number, let records = fixture["recordsPerCycle"].number,
              let payloadColumns = fixture["payloadColumns"].number, let fileBytes = fixture["fileBytes"].number,
              let soakSeconds = fixture["soakSeconds"].number, let unicodeText = fixture["unicodeText"].string else { throw BridgeFailure(code: "PERFORMANCE_FIXTURE", message: "Invalid workload") }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent()
        let project = root.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark"), "fontFamily": fixture["fontFamily"], "fontSize": fixture["fontSize"], "scrollback": fixture["scrollback"]])
        model.sidebarVisible = false; model.hideInspector()
        window.setContentSize(NSSize(width: fixture["windowWidth"].number ?? 1200, height: fixture["windowHeight"].number ?? 720))
        guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("Performance QA"), "directory": .string(project.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "PERFORMANCE_PROJECT", message: model.error) }
        await model.newTerminal()
        try await wait("Start the measured PTY") { model.selectedTerminal?.generation != nil && (model.selectedTerminal?.qaRenderedFrames ?? 0) > 0 && model.selectedTerminal?.inputControl?.owned == true }
        guard let terminal = model.selectedTerminal, let generation = terminal.generation else { throw BridgeFailure(code: "PERFORMANCE_PTY", message: "No measured terminal") }
        guard let columns = fixture["columns"].number, let rows = fixture["rows"].number else { throw BridgeFailure(code: "PERFORMANCE_FIXTURE", message: "Missing common grid") }
        // Resize the actual window and let SwiftTerm/PTY layout agree before measuring input.
        // 先调整真实窗口并让 SwiftTerm／PTY 布局一致，再测量输入。
        for _ in 0..<10 {
            let grid = terminal.view.getTerminal()
            if grid.cols == Int(columns), grid.rows == Int(rows) { break }
            let size = window.contentView?.bounds.size ?? .zero
            let cellWidth = Double(terminal.view.bounds.width) / Double(max(1, grid.cols))
            let cellHeight = Double(terminal.view.bounds.height) / Double(max(1, grid.rows))
            let width = grid.cols == Int(columns) ? Double(size.width) : Double(size.width) + (columns - Double(grid.cols) + 0.25) * cellWidth
            let height = grid.rows == Int(rows) ? Double(size.height) : Double(size.height) + (rows - Double(grid.rows) + 0.25) * cellHeight
            window.setContentSize(NSSize(width: CGFloat(width), height: CGFloat(height)))
            window.contentView?.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(300))
        }
        guard terminal.view.getTerminal().cols == Int(columns), terminal.view.getTerminal().rows == Int(rows) else { throw BridgeFailure(code: "PERFORMANCE_VIEWPORT", message: "Actual terminal did not reach the common grid") }
        let status = try await bridge.call("host.status")
        guard let hostPID = status["pid"].number, hostPID > 0 else { throw BridgeFailure(code: "PERFORMANCE_HOST", message: "Missing owned host PID") }
        func phase(_ value: String, cycle: Int = -1) throws {
            try JSONSerialization.data(withJSONObject: ["phase": value, "cycle": cycle, "hostPID": hostPID], options: .sortedKeys).write(to: root.appendingPathComponent("performance-phase.json"), options: .atomic)
        }
        var samples: [[String: Any]] = []
        let payload = String(repeating: "x", count: Int(payloadColumns))
        func send(_ command: String) {
            terminal.view.insertText((command + "\r") as NSString, replacementRange: NSRange(location: NSNotFound, length: 0))
        }
        func bulk(_ label: String) {
            send("i=0; while test \"$i\" -lt \(Int(records)); do printf '\\033[32mP\(label)_%04d_\\033[0m\(payload) \(unicodeText)\\n' \"$i\"; i=$((i+1)); done; printf 'END_%s\\n' '\(label)'")
        }
        for cycle in 0..<Int(cycles) {
            try phase("terminal", cycle: cycle)
            let label = String(format: "%02d", cycle)
            let start = ProcessInfo.processInfo.systemUptime
            terminal.view.insertText("printf 'LAT_%s\\n' '\(label)'\r" as NSString, replacementRange: NSRange(location: NSNotFound, length: 0))
            try await wait("Measure input/output acknowledgement") { terminal.qaTailText.contains("LAT_" + label) && terminal.qaAcknowledgedFrames == terminal.qaRenderedFrames }
            let latency = (terminal.qaLastAckUptime - start) * 1000
            guard latency >= 0 else { throw BridgeFailure(code: "PERFORMANCE_STALE", message: "Input marker matched a stale acknowledgement") }
            let bytes = terminal.qaRenderedBytes
            let bulkStart = ProcessInfo.processInfo.systemUptime
            bulk(label)
            try await wait("Render the complete common workload") { terminal.qaTailText.contains("END_" + label) && terminal.qaAcknowledgedFrames == terminal.qaRenderedFrames }
            let text = terminal.text
            let expression = try NSRegularExpression(pattern: "P" + label + "_([0-9]{4})_")
            let matches = expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in Range(match.range(at: 1), in: text).flatMap { Int(text[$0]) } }
            guard matches == Array(0..<Int(records)), text.contains(unicodeText), terminal.error.isEmpty, terminal.generation == generation else { throw BridgeFailure(code: "PERFORMANCE_ORDER", message: "Measured output lost order, Unicode, generation or acknowledgement") }
            samples.append(["cycle": cycle, "inputToParsedAckMilliseconds": latency, "bulkMilliseconds": (terminal.qaLastAckUptime - bulkStart) * 1000,
                            "renderedBytes": terminal.qaRenderedBytes - bytes, "orderedRecords": matches.count, "acknowledgedSequence": terminal.qaLastAcknowledgedSequence])
        }
        try phase("slow-consumer")
        let delay = fixture["slowConsumerMilliseconds"].number ?? 200
        terminal.qaRenderDelay = .milliseconds(Int(delay))
        terminal.qaRenderPaused = true
        let slowStart = ProcessInfo.processInfo.systemUptime
        var slowConsumer: [String: Any] = [:]
        do {
            defer { terminal.qaRenderPaused = false; terminal.qaRenderDelay = nil }
            bulk("SL")
            try await wait("Observe delayed actual consumer") { terminal.qaWaitingToRender }
            let received = terminal.qaReceivedFrames, rendered = terminal.qaRenderedFrames
            let heldAt = ProcessInfo.processInfo.systemUptime
            try await Task.sleep(for: .milliseconds(50))
            guard terminal.qaWaitingToRender, terminal.qaReceivedFrames == received, terminal.qaRenderedFrames == rendered, terminal.qaAcknowledgedFrames < terminal.qaReceivedFrames else { throw BridgeFailure(code: "PERFORMANCE_BACKPRESSURE", message: "Another frame arrived or ACK preceded delayed rendering") }
            let initialGateMilliseconds = (ProcessInfo.processInfo.systemUptime-heldAt)*1000
            terminal.qaRenderPaused = false
            try await wait("Consume delayed ordered output") { terminal.qaTailText.contains("END_SL") && terminal.qaAcknowledgedFrames == terminal.qaRenderedFrames }
            let text = terminal.text
            let expression = try NSRegularExpression(pattern: "PSL_([0-9]{4})_")
            let matches = expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in Range(match.range(at: 1), in: text).flatMap { Int(text[$0]) } }
            guard matches == Array(0..<Int(records)), terminal.qaLargestFrame <= Int(fixture["maximumFrameBytes"].number ?? 0) else { throw BridgeFailure(code: "PERFORMANCE_BACKPRESSURE", message: "Slow output lost order or exceeded the retained-frame budget") }
            slowConsumer = ["injectedDelayMilliseconds": delay, "oneOutstandingFrame": true, "orderedRecords": matches.count,
                "milliseconds": (terminal.qaLastAckUptime - slowStart) * 1000, "largestFrameBytes": terminal.qaLargestFrame,
                "initialGateObserved": true, "initialGateMilliseconds": initialGateMilliseconds]
        }
        try phase("tui")
        send("printf '\\033[?1049h'")
        try await wait("Actual alternate screen entry") { terminal.view.getTerminal().isCurrentBufferAlternate }
        var tuiFrameMilliseconds: [Double] = []
        for cycle in 0..<Int(fixture["tuiFrames"].number ?? 0) {
            let label = String(format: "%02d", cycle)
            let start = ProcessInfo.processInfo.systemUptime
            send("printf '\\033[H\\033[2J\\033[2;1H\\033[32m\(payload) \(unicodeText)\\033[0m\\033[6;1HTUI_%s\\n' '\(label)'")
            try await wait("Actual synthetic TUI redraw/ACK") { terminal.view.getTerminal().isCurrentBufferAlternate && terminal.qaTailText.contains("TUI_" + label) && terminal.qaAcknowledgedFrames == terminal.qaRenderedFrames }
            tuiFrameMilliseconds.append((terminal.qaLastAckUptime-start)*1000)
        }
        try phase("capture")
        let tuiCapture = "native-performance-tui.png"
        try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(tuiCapture))
        send("printf '\\033[?1049l'")
        try await wait("Actual normal screen restoration") { !terminal.view.getTerminal().isCurrentBufferAlternate }
        try phase("file-setup")
        let fileURL = project.appendingPathComponent("performance.txt")
        try Data(repeating: 120, count: Int(fileBytes)).write(to: fileURL)
        var document = try await bridge.call("files.read", params: .object(["directory": .string(project.path), "path": .string("performance.txt")]))
        var fileSamples: [Double] = []
        try phase("file-service")
        for cycle in 0..<Int(cycles) {
            let text = String(repeating: "x", count: Int(fileBytes)-8) + String(format: "%08d", cycle)
            let start = ProcessInfo.processInfo.systemUptime
            _ = try await bridge.call("files.save", params: .object(["directory": .string(project.path), "path": .string("performance.txt"), "text": .string(text), "expected": document["version"], "force": .bool(false)]))
            document = try await bridge.call("files.read", params: .object(["directory": .string(project.path), "path": .string("performance.txt")]))
            guard document["text"].string == text else { throw BridgeFailure(code: "PERFORMANCE_FILE", message: "Measured CAS save/read returned different bytes") }
            fileSamples.append((ProcessInfo.processInfo.systemUptime - start) * 1000)
        }
        try phase("database-setup")
        guard let contextPath = ProcessInfo.processInfo.environment["UTERM_QA_DATABASE_FIXTURE"] else { throw BridgeFailure(code: "PERFORMANCE_DATABASE", message: "Missing owned PostgreSQL fixture") }
        let databaseFixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: URL(fileURLWithPath: contextPath)))
        let database = DatabaseHost(bridge: bridge)
        _ = try await database.execute("database_components", params: ["action": .string("install"), "id": .string("postgresql")])
        let config: JSONValue = .object(["id": .string(UUID().uuidString), "name": .string("Performance PostgreSQL"), "kind": .string("postgresql"),
            "host": .string("127.0.0.1"), "port": databaseFixture["port"], "database": .string("uterm_qa"), "username": .string("uterm_qa"), "tls": .bool(false), "ca_file": .string(""), "credential_id": .null])
        let connection = try await database.execute("database_connect", params: ["config": config, "password": databaseFixture["password"]])
        var databaseReadMilliseconds: [Double] = []
        try phase("database")
        do {
            let rows = Int(fixture["databaseRows"].number ?? 0), columns = Int(fixture["databasePayloadColumns"].number ?? 0)
            let expected = String(repeating: "x", count: columns) + " " + unicodeText
            for _ in 0..<Int(cycles) {
                let start = ProcessInfo.processInfo.systemUptime
                let result = try await database.execute("database_request", params: ["handle": connection["handle"], "request": .object([
                    "op": .string("query"), "sql": .string("SELECT i::text, repeat('x',\(columns)) || ' \(unicodeText)' FROM generate_series(1,\(rows)) AS i ORDER BY i"), "offset": .number(0)])])
                let values = result["rows"].array
                guard values.count == rows else { throw BridgeFailure(code: "PERFORMANCE_DATABASE", message: "Actual database query returned another row count") }
                for (index, row) in values.enumerated() {
                    let cells = row.array
                    guard cells.count == 2, cells[0].string == String(index+1), let text = cells[1].string,
                          Data(text.utf8) == Data(expected.utf8) else { throw BridgeFailure(code: "PERFORMANCE_DATABASE", message: "Actual database query changed ordered UTF-8 bytes") }
                }
                databaseReadMilliseconds.append((ProcessInfo.processInfo.systemUptime-start)*1000)
            }
        } catch {
            _ = try? await database.execute("database_disconnect", params: ["handle": connection["handle"], "discard": .bool(true)])
            throw error
        }
        _ = try await database.execute("database_disconnect", params: ["handle": connection["handle"], "discard": .bool(true)])
        send("printf 'REPLAY_%s\\n' FINAL")
        try await wait("Final replay checkpoint") { terminal.qaTailText.contains("REPLAY_FINAL") && terminal.qaAcknowledgedFrames == terminal.qaRenderedFrames }
        try phase("replay")
        let resets = terminal.qaReplayResets
        let replayStart = ProcessInfo.processInfo.systemUptime
        await model.reconnectTransport()
        try await wait("Replay the retained generation") { terminal.qaReplayResets > resets && terminal.qaTailText.contains("REPLAY_FINAL") && terminal.inputControl?.owned == true && terminal.qaAcknowledgedFrames == terminal.qaRenderedFrames }
        guard terminal.generation == generation else { throw BridgeFailure(code: "PERFORMANCE_REPLAY", message: "Replay restarted the PTY") }
        report["replayMilliseconds"] = (terminal.qaLastAckUptime - replayStart) * 1000
        let soak = CommandLine.arguments.contains("--performance-long") ? fixture["lastRepetitionSoakSeconds"].number ?? 600 : soakSeconds
        try phase("idle-soak")
        try await Task.sleep(for: .seconds(soak))
        guard let currentBridge = model.bridge, try await currentBridge.call("host.status")["pid"] == status["pid"], terminal.generation == generation else { throw BridgeFailure(code: "PERFORMANCE_SOAK", message: "Idle soak replaced the owned process") }
        try phase("capture")
        let capture = "native-performance-terminal.png"
        try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(capture))
        report["captures"] = [tuiCapture, capture]; report["cycles"] = samples; report["fileSaveReadMilliseconds"] = fileSamples
        report["tuiFrameMilliseconds"] = tuiFrameMilliseconds; report["slowConsumer"] = slowConsumer
        report["databaseReadMilliseconds"] = databaseReadMilliseconds; report["soakSecondsMeasured"] = soak
        report["fixtureSHA256"] = SHA256.hash(data: fixtureBytes).map { String(format: "%02x", $0) }.joined()
        report["fixture"] = try JSONSerialization.jsonObject(with: fixtureBytes)
        report["client"] = "native"; report["hostPID"] = hostPID; report["sessionCountMeasured"] = 1
        report["viewport"] = ["columns": terminal.view.getTerminal().cols, "rows": terminal.view.getTerminal().rows]
        report["measurementWindowContent"] = ["width": window.contentView?.bounds.width ?? 0, "height": window.contentView?.bounds.height ?? 0]
        report["measurement"] = "Native NSTextInputClient to parsed/acknowledged actual PTY output; Core C ABI file service; actual reconnect/replay; short CI idle soak"
        report["manualInputAcceptance"] = false; report["databasePerformanceMeasured"] = true
        report["databaseMeasurement"] = "Actual PostgreSQL query through Core/JDBC; row text/order verified; excludes table painting and external server CPU/RSS"
        try phase("cleanup")
        await model.closeSession()
        _ = try await currentBridge.call("host.shutdownIdle")
        report["explicitCloseAndIdleHostShutdown"] = true
    }
}
