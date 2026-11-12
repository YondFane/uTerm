import AppKit
import UTermBridge

@MainActor
enum AgentSmoke {
    static func run(model: WorkspaceModel, open: () -> AgentSettingsWindow, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.sshBridge, let path = WorkspaceModel.argument("--agent-smoke-report") else { throw BridgeFailure(code: "AGENT_QA_CONTEXT", message: "Missing isolated Agent QA context") }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent()
        let home = root.appendingPathComponent("agent-home")
        let config = home.appendingPathComponent(".claude/settings.json")
        let original = try Data(contentsOf: config)
        await model.patchSettings(["usageRemote": .bool(false)])
        let pollingFirst = AgentSettingsModel(workspace: model)
        pollingFirst.visible = true
        let earlyUsage = Task { @MainActor in await pollingFirst.pollUsage() }
        do {
            try await TerminalSmoke.wait("Load Agent catalog even when usage polling starts first") { pollingFirst.catalog != .null && pollingFirst.qaUsageReads > 0 && !pollingFirst.busy }
        } catch {
            pollingFirst.visible = false; earlyUsage.cancel(); await earlyUsage.value
            throw error
        }
        pollingFirst.visible = false; earlyUsage.cancel(); await earlyUsage.value
        report["usagePollingLoadsCatalogBeforeUsage"] = true
        let current = open()
        try await TerminalSmoke.wait("Load Agent catalog") { current.model.catalog != .null && !current.model.busy }
        try await TerminalSmoke.wait("Automatically read local usage on opening") { current.model.qaUsageReads > 0 && !current.model.busy }
        let usageReads = current.model.qaUsageReads
        current.model.select("claude")
        try await TerminalSmoke.wait("Refresh selected Agent usage") { current.model.qaUsageReads > usageReads && !current.model.busy && current.model.usage["records"].number == 1 }
        guard !current.model.qaUsageLastRemote else { throw BridgeFailure(code: "AGENT_USAGE_PREFERENCE", message: "Local usage preference requested a remote account") }
        current.model.visible = false
        report["nativeUsageRefreshRespectsSelectedAgentAndLocalPreference"] = true
        report["automaticUsageKeychainAccess"] = false
        guard try Data(contentsOf: config) == original, !FileManager.default.fileExists(atPath: root.appendingPathComponent("agents.json").path) else { throw BridgeFailure(code: "AGENT_OPEN_WRITE", message: "Opening Agent settings wrote configuration") }
        report["openingDoesNotWriteDefaults"] = true
        current.model.newDefinition()
        current.model.identifier = "qa-custom"; current.model.name = "Custom QA"
        current.model.program = "/usr/bin/true"; current.model.argumentsText = "[\"literal argument\"]"
        await current.model.save()
        guard current.model.error.isEmpty, current.model.definitions.contains(where: { $0["id"].string == "qa-custom" }) else { throw BridgeFailure(code: "AGENT_SAVE", message: "Native custom command save failed") }
        guard await model.mutate("settings.agent.toggle", ["agent": .string("qa-custom"), "enabled": .bool(true)]), model.settings["enabledAgents"].array.contains(.string("qa-custom")) else { throw BridgeFailure(code: "AGENT_ENABLE", message: "Native Agent enable failed") }
        await current.model.remove()
        guard current.model.error.isEmpty, !current.model.definitions.contains(where: { $0["id"].string == "qa-custom" }), !model.settings["enabledAgents"].array.contains(.string("qa-custom")) else { throw BridgeFailure(code: "AGENT_DISABLE", message: "Native Agent removal retained its definition or enable flag") }
        report["nativeCustomCommandSaveEnableDisableRemove"] = true
        current.model.select("claude")
        await current.model.perform("agent.hooks", params: ["agent": .string("claude"), "enabled": .bool(true)])
        guard current.model.error.isEmpty, String(decoding: try Data(contentsOf: config), as: UTF8.self).contains("other-tool --start") else { throw BridgeFailure(code: "AGENT_HOOKS", message: "Hook installation did not preserve the user's hook") }
        current.model.argumentsText = "[invalid"
        guard let menuItem = NSApp.mainMenu?.items.compactMap(\.submenu).flatMap(\.items).first(where: { $0.action.map(NSStringFromSelector) == "closeSession" }), let action = menuItem.action, NSApp.sendAction(action, to: menuItem.target, from: menuItem) else { throw BridgeFailure(code: "AGENT_CLOSE_MENU", message: "Native Close action is missing") }
        guard !current.window.isVisible, current.model.dirty else { throw BridgeFailure(code: "AGENT_HIDE", message: "Hiding Agent settings lost the command draft") }
        let reopened = open()
        reopened.model.visible = false
        guard reopened === current, current.model.argumentsText == "[invalid" else { throw BridgeFailure(code: "AGENT_REOPEN", message: "Reopening Agent settings lost the command draft") }
        await current.model.save()
        guard !current.model.error.isEmpty, current.model.argumentsText == "[invalid" else { throw BridgeFailure(code: "AGENT_BAD_ARGS", message: "Invalid arguments were not retained with a visible error") }
        NSApp.terminate(nil)
        try await TerminalSmoke.wait("Present Agent draft guard during actual application quit") { current.window.attachedSheet != nil }
        if let sheet = current.window.attachedSheet { current.window.endSheet(sheet, returnCode: .alertSecondButtonReturn) }
        try await TerminalSmoke.wait("Resume Agent draft after cancelling quit") { !current.model.frozen && current.window.attachedSheet == nil }
        guard current.model.dirty, current.model.argumentsText == "[invalid" else { throw BridgeFailure(code: "AGENT_QUIT_DRAFT", message: "Cancelled application quit lost the Agent draft") }
        report["actualApplicationQuitCancellationRetainsDraft"] = true
        current.model.select("claude", force: true); current.model.error = ""
        await current.model.perform("agent.usage", params: ["agent": .string("claude"), "remote": .bool(false), "allowKeychain": .bool(false)])
        guard current.model.error.isEmpty, current.model.usage["records"].number == 1 else { throw BridgeFailure(code: "AGENT_USAGE", message: "Native local usage did not read the isolated fixture") }
        report["nativeHookPreservationDraftAndLocalUsage"] = true
        var captures: [String] = []
        var captureGeometry: [[String: Any]] = []
        for (language, appearance, width, name) in [("en", "dark", 850.0, "native-agent-settings-dark-en.png"), ("zh-Hans", "light", 640.0, "native-agent-settings-light-zh-narrow.png")] {
            await model.patchSettings(["language": .string(language), "appearance": .string(appearance)])
            current.window.setContentSize(NSSize(width: width, height: 850))
            guard let visible = current.window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame else { throw BridgeFailure(code: "AGENT_CAPTURE_SCREEN", message: "Missing actual Agent QA screen") }
            // Fit enlarged QA windows above the measured Dock shadow; preserve the original alpha gate.
            // 放大的 QA 窗口须避开实测 Dock 阴影，原有 alpha 门禁保持不变。
            let bounds = visible.insetBy(dx: 8, dy: 64)
            var frame = current.window.frame
            frame.size.width = min(frame.width, bounds.width); frame.size.height = min(frame.height, bounds.height)
            frame.origin = NSPoint(x: bounds.midX - frame.width / 2, y: bounds.midY - frame.height / 2)
            current.window.setFrame(frame, display: true)
            let actual = current.window.frame
            let clearance = min(actual.minY - visible.minY, visible.maxY - actual.maxY)
            guard visible.contains(actual), clearance >= 63.5 else { throw BridgeFailure(code: "AGENT_CAPTURE_SCREEN", message: "The enlarged Agent QA window does not fit its visible desktop") }
            captureGeometry.append(["screenshot": name, "frame": NSStringFromRect(actual), "visibleFrame": NSStringFromRect(visible), "minimumVerticalClearance": 64, "actualVerticalClearance": clearance])
            report["agentCaptureGeometry"] = captureGeometry
            try await Task.sleep(for: .milliseconds(200))
            try await TerminalSmoke.capture(window: current.window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name))
            captures.append(name)
        }
        report["captures"] = captures
        await current.model.perform("agent.hooks", params: ["agent": .string("claude"), "enabled": .bool(false)])
        guard current.model.error.isEmpty, String(decoding: try Data(contentsOf: config), as: UTF8.self).contains("other-tool --start") else { throw BridgeFailure(code: "AGENT_REMOVE_HOOKS", message: "Removing Hooks changed another tool's configuration") }
        try await notificationScenarios(model: model, root: root)
        report["nativeNotificationOptInDenialDedupAndStaleCancellation"] = true
        report["realHostAndReporterProcess"] = true
        report["simulatedOSNotificationPermissionAndDelivery"] = true
        report["actualAgentProvider"] = false
        report["manualAcceptance"] = "waived by user"
        report["keychainOrProviderAccountAccess"] = false
        _ = try await bridge.call("host.shutdownIdle")
        current.window.orderOut(nil)
    }
    private static func notificationScenarios(model: WorkspaceModel, root: URL) async throws {
        let notices = model.agentNotifications
        notices.simulatedPermission = false
        do { try await notices.setEnabled(true); throw BridgeFailure(code: "AGENT_DENIAL", message: "Denied permission enabled notifications") }
        catch let failure as BridgeFailure where failure.code == "NOTIFICATION_DENIED" {}
        guard !notices.enabled else { throw BridgeFailure(code: "AGENT_DENIAL_SAVE", message: "Denied permission changed preferences") }
        notices.simulatedPermission = true
        try await notices.setEnabled(true)
        guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("Agent QA"), "directory": .string(root.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "AGENT_PROJECT", message: "Could not select the temporary Agent project") }
        await model.newTerminal()
        try await TerminalSmoke.wait("Attach Agent activity QA terminal") { model.selectedTerminal?.generation != nil && (model.selectedTerminal?.qaRenderedFrames ?? 0) > 0 }
        guard let first = model.selectedTerminal, let generation = first.generation else { throw BridgeFailure(code: "AGENT_TERMINAL", message: "No activity terminal") }
        await model.newTerminal()
        try await TerminalSmoke.wait("Attach selected peer terminal") { model.selectedID != first.id && model.selectedTerminal?.generation != nil }
        notices.simulatedDelay = .milliseconds(400)
        let reporter = root.appendingPathComponent("integration/uterm-report")
        let sessionID = first.id
        func report(_ state: String, _ generation: String) async throws -> Int32 {
            try await Task.detached {
                let process = Process(); process.executableURL = reporter
                process.arguments = ["--agent-report", state]
                var environment = ProcessInfo.processInfo.environment
                environment["UTERM_DESKTOP_HOST"] = root.appendingPathComponent("local-daemon-v1").path
                environment["UTERM_DESKTOP_SESSION"] = sessionID; environment["UTERM_DESKTOP_GENERATION"] = generation
                process.environment = environment
                process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
                try process.run(); process.waitUntilExit(); return process.terminationStatus
            }.value
        }
        guard try await report("working", generation) == 0 else { throw BridgeFailure(code: "AGENT_REPORTER", message: "Installed reporter failed") }
        try await TerminalSmoke.wait("Receive real working event") { first.agentState == "working" }
        _ = try await report("done", generation)
        try await TerminalSmoke.wait("Receive real done event") { first.agentState == "done" }
        _ = try await report("working", generation)
        try await TerminalSmoke.wait("Invalidate the pending completion") { first.agentState == "working" }
        try await Task.sleep(for: .milliseconds(500))
        guard notices.simulatedDeliveries.isEmpty else { throw BridgeFailure(code: "AGENT_STALE_NOTIFICATION", message: "Newer work did not cancel completion") }
        _ = try await report("done", generation)
        try await TerminalSmoke.wait("Deliver current completion through the simulated OS adapter") { notices.simulatedDeliveries.count == 1 }
        _ = try await report("done", generation)
        await first.reconnect()
        try await Task.sleep(for: .milliseconds(500))
        guard notices.simulatedDeliveries.count == 1, try await report("working", "stale-generation") != 0 else { throw BridgeFailure(code: "AGENT_NOTIFICATION_REPLAY", message: "Replay duplicated completion or stale generation was accepted") }
        try await notices.setEnabled(false)
        for id in model.state?.sessions.map(\.sessionID) ?? [] { await model.selectSession(id); await model.closeSession() }
    }
}
