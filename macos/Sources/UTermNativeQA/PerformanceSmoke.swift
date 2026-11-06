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
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark"), "fontFamily": fixture["fontFamily"], "fontSize": fixture["fontSize"], "scrollback": fixture["scrollback"]])
        model.sidebarVisible = false; model.hideInspector()
        window.setContentSize(NSSize(width: fixture["windowWidth"].number ?? 1200, height: fixture["windowHeight"].number ?? 720))
        guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("Performance QA"), "directory": .string(root.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "PERFORMANCE_PROJECT", message: model.error) }
        await model.newTerminal()
        try await wait("Start the measured PTY") { model.selectedTerminal?.generation != nil && (model.selectedTerminal?.qaRenderedFrames ?? 0) > 0 && model.selectedTerminal?.inputControl?.owned == true }
        guard let terminal = model.selectedTerminal, let generation = terminal.generation else { throw BridgeFailure(code: "PERFORMANCE_PTY", message: "No measured terminal") }
        let status = try await bridge.call("host.status")
        guard let hostPID = status["pid"].number, hostPID > 0 else { throw BridgeFailure(code: "PERFORMANCE_HOST", message: "Missing owned host PID") }
        func phase(_ value: String, cycle: Int = -1) throws {
            try JSONSerialization.data(withJSONObject: ["phase": value, "cycle": cycle, "hostPID": hostPID], options: .sortedKeys).write(to: root.appendingPathComponent("performance-phase.json"), options: .atomic)
        }
        var samples: [[String: Any]] = []
        let payload = String(repeating: "x", count: Int(payloadColumns))
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
            terminal.view.insertText("i=0; while test \"$i\" -lt \(Int(records)); do printf '\\033[32mP\(label)_%04d_\\033[0m\(payload) \(unicodeText)\\n' \"$i\"; i=$((i+1)); done; printf 'END_%s\\n' '\(label)'\r" as NSString, replacementRange: NSRange(location: NSNotFound, length: 0))
            try await wait("Render the complete common workload") { terminal.qaTailText.contains("END_" + label) && terminal.qaAcknowledgedFrames == terminal.qaRenderedFrames }
            let text = terminal.text
            let expression = try NSRegularExpression(pattern: "P" + label + "_([0-9]{4})_")
            let matches = expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in Range(match.range(at: 1), in: text).flatMap { Int(text[$0]) } }
            guard matches == Array(0..<Int(records)), text.contains(unicodeText), terminal.error.isEmpty, terminal.generation == generation else { throw BridgeFailure(code: "PERFORMANCE_ORDER", message: "Measured output lost order, Unicode, generation or acknowledgement") }
            samples.append(["cycle": cycle, "inputToParsedAckMilliseconds": latency, "bulkMilliseconds": (terminal.qaLastAckUptime - bulkStart) * 1000,
                            "renderedBytes": terminal.qaRenderedBytes - bytes, "orderedRecords": matches.count, "acknowledgedSequence": terminal.qaLastAcknowledgedSequence])
        }
        try phase("file-service")
        let fileURL = root.appendingPathComponent("performance.txt")
        try Data(repeating: 120, count: Int(fileBytes)).write(to: fileURL)
        var document = try await bridge.call("files.read", params: .object(["directory": .string(root.path), "path": .string("performance.txt")]))
        var fileSamples: [Double] = []
        for cycle in 0..<Int(cycles) {
            let text = String(repeating: "x", count: Int(fileBytes)-8) + String(format: "%08d", cycle)
            let start = ProcessInfo.processInfo.systemUptime
            _ = try await bridge.call("files.save", params: .object(["directory": .string(root.path), "path": .string("performance.txt"), "text": .string(text), "expected": document["version"], "force": .bool(false)]))
            document = try await bridge.call("files.read", params: .object(["directory": .string(root.path), "path": .string("performance.txt")]))
            guard document["text"].string == text else { throw BridgeFailure(code: "PERFORMANCE_FILE", message: "Measured CAS save/read returned different bytes") }
            fileSamples.append((ProcessInfo.processInfo.systemUptime - start) * 1000)
        }
        try phase("replay")
        let resets = terminal.qaReplayResets
        let replayStart = ProcessInfo.processInfo.systemUptime
        await model.reconnectTransport()
        try await wait("Replay the retained generation") { terminal.qaReplayResets > resets && terminal.qaTailText.contains(String(format: "END_%02d", Int(cycles)-1)) && terminal.inputControl?.owned == true && terminal.qaAcknowledgedFrames == terminal.qaRenderedFrames }
        guard terminal.generation == generation else { throw BridgeFailure(code: "PERFORMANCE_REPLAY", message: "Replay restarted the PTY") }
        report["replayMilliseconds"] = (terminal.qaLastAckUptime - replayStart) * 1000
        try phase("idle-soak")
        try await Task.sleep(for: .seconds(soakSeconds))
        guard let currentBridge = model.bridge, try await currentBridge.call("host.status")["pid"] == status["pid"], terminal.generation == generation else { throw BridgeFailure(code: "PERFORMANCE_SOAK", message: "Idle soak replaced the owned process") }
        let capture = "native-performance-terminal.png"
        try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(capture))
        report["captures"] = [capture]; report["cycles"] = samples; report["fileSaveReadMilliseconds"] = fileSamples
        report["fixtureSHA256"] = SHA256.hash(data: fixtureBytes).map { String(format: "%02x", $0) }.joined()
        report["fixture"] = try JSONSerialization.jsonObject(with: fixtureBytes)
        report["client"] = "native"; report["hostPID"] = hostPID; report["sessionCountMeasured"] = 1
        report["viewport"] = ["columns": terminal.view.getTerminal().cols, "rows": terminal.view.getTerminal().rows]
        report["measurement"] = "Native NSTextInputClient to parsed/acknowledged actual PTY output; Core C ABI file service; actual reconnect/replay; short CI idle soak"
        report["manualInputAcceptance"] = false; report["databasePerformanceMeasured"] = false
        try phase("cleanup")
        await model.closeSession()
        _ = try await currentBridge.call("host.shutdownIdle")
        report["explicitCloseAndIdleHostShutdown"] = true
    }
}
