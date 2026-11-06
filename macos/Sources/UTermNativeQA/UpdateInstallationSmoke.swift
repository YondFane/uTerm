import AppKit
import CoreGraphics
import UTermBridge

@MainActor
enum UpdateInstallationSmoke {
    static func run(model: WorkspaceModel, window: NSWindow, openFile: (URL, String) async throws -> ContentWindow,
                    openSSH: () async throws -> SSHWindow, openDatabase: () async throws -> ContentWindow,
                    attemptQuit: () -> Void, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.bridge, model.updates.configuration?.qa == true,
              let reportPath = Bundle.main.object(forInfoDictionaryKey: "UTermQAUpdateReport") as? String else { throw BridgeFailure(code: "UPDATE_INSTALL_CONTEXT", message: "Missing isolated install fixture") }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent()
        let checkpoint = root.appendingPathComponent("installation-checkpoint.json")
        let text = "SDK_INSTALL_DRAFT 中文 é\n"
        if Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String == "2" {
            let baseline = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: checkpoint))
            guard baseline["oldVersion"].string == "1", baseline["originalAppPID"].number != Double(ProcessInfo.processInfo.processIdentifier),
                  let sessionID = baseline["sessionID"].string else { throw BridgeFailure(code: "UPDATE_RELAUNCH", message: "SDK did not relaunch a different updated process") }
            try await TerminalSmoke.wait("Reattach retained PTY after SDK installation") {
                model.terminals[sessionID]?.generation == baseline["generation"].string && (model.terminals[sessionID]?.qaRenderedFrames ?? 0) > 0
            }
            await model.selectSession(sessionID)
            guard let terminal = model.selectedTerminal, try await bridge.call("host.status")["pid"] == baseline["hostPID"],
                  try String(contentsOf: root.appendingPathComponent("upgrade.txt"), encoding: .utf8) == text else { throw BridgeFailure(code: "UPDATE_INSTALL_DATA", message: "SDK installation replaced the host or bypassed saving the actual editor draft") }
            terminal.enqueue(Data("printf 'SDK_%s\\n' RELAUNCHED\r".utf8))
            try await TerminalSmoke.wait("Actual retained process output after SDK relaunch") { terminal.text.contains("SDK_RELAUNCHED") }
            try await TerminalSmoke.wait("Display the updated process's retained terminal") {
                terminal.view.window === window && terminal.view.visibleRect.width > 100 && terminal.view.visibleRect.height > 100
            }
            window.contentView?.layoutSubtreeIfNeeded()
            terminal.view.needsDisplay = true
            window.displayIfNeeded()
            let capture = "native-update-install-relaunched.png"
            report["originalAppPID"] = baseline["originalAppPID"].number
            report["relaunchedAppPID"] = ProcessInfo.processInfo.processIdentifier
            report["hostPIDBefore"] = baseline["hostPID"].number; report["hostPIDAfter"] = baseline["hostPID"].number
            report["oldBundleVersion"] = "1"; report["installedBundleVersion"] = "2"
            report["defaultAutomaticUpdatesOff"] = model.settings["automaticUpdates"].bool == false
            report["actualInstallOrRelaunchExecuted"] = true; report["actualEditorQuitAutosaveRetainedBytes"] = true
            report["realPTYRetainedGenerationAndHost"] = true; report["productionFeedChanged"] = false
            report["retainedTerminalVisibleInRelaunchedWindow"] = true
            report["realSparkleSDK"] = "2.10.1"; report["simulatedUserDriver"] = true
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil); window.orderFrontRegardless(); NSApp.activate(ignoringOtherApps: true)
            report["relaunchedWindowFrame"] = NSStringFromRect(window.frame)
            let deadline = Date().addingTimeInterval(8)
            var listed = false
            while Date() < deadline {
                let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
                listed = windows.contains { item in
                    (item[kCGWindowOwnerPID as String] as? Int32) == ProcessInfo.processInfo.processIdentifier &&
                    (item[kCGWindowNumber as String] as? Int) == window.windowNumber
                }
                report["relaunchedWindowListedByWindowServer"] = listed
                if listed { break }
                try await Task.sleep(for: .milliseconds(250))
            }
            guard listed else { throw BridgeFailure(code: "UPDATE_RELAUNCH_CAPTURE", message: "Updated app's own window was not listed by WindowServer") }
            let evidence = URL(fileURLWithPath: reportPath).deletingLastPathComponent()
            let request: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "windowNumber": window.windowNumber,
                "bundleIdentifier": Bundle.main.bundleIdentifier ?? "", "sourceHeadSHA": report["sourceHeadSHA"] ?? "", "testedMergeSHA": report["sourceSHA"] ?? "", "screenshot": capture]
            try JSONSerialization.data(withJSONObject: request, options: .sortedKeys).write(to: evidence.appendingPathComponent("capture-request.json"), options: .atomic)
            let response = evidence.appendingPathComponent("capture-response.json")
            let captureDeadline = Date().addingTimeInterval(45)
            while !FileManager.default.fileExists(atPath: response.path), Date() < captureDeadline {
                try await Task.sleep(for: .milliseconds(100))
            }
            guard let bytes = try? Data(contentsOf: response), let result = try? JSONDecoder().decode(JSONValue.self, from: bytes), result["passed"].bool == true else {
                throw BridgeFailure(code: "UPDATE_RELAUNCH_CAPTURE", message: "Original CI coordinator did not confirm the updated app's owned window capture")
            }
            report["relaunchedWindowNumber"] = window.windowNumber
            report["captureCoordinator"] = "original CI process tree; actual WindowServer owner PID/window number verified"
            guard baseline["quitGuards"]["actualPostgreSQLQueryQuitRefused"].bool == true,
                  baseline["quitGuards"]["actualTransactionQuitRefused"].bool == true else { throw BridgeFailure(code: "UPDATE_INSTALL_GUARDS", message: "Pre-install guard evidence is missing") }
            report["quitGuards"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(baseline["quitGuards"]))
            report["captures"] = [capture] + baseline["quitGuards"]["captures"].array.compactMap(\.string)
            await model.closeSession(); _ = try await bridge.call("host.shutdownIdle")
            report["explicitFixtureCloseAndIdleHostShutdown"] = true
            return
        }
        guard !FileManager.default.fileExists(atPath: checkpoint.path), model.updates.updater == nil else { throw BridgeFailure(code: "UPDATE_INSTALL_REPEAT", message: "Installation checkpoint already exists") }
        await model.patchSettings(["language": .string("en"), "automaticUpdates": .bool(false)])
        guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("SDK installation QA"), "directory": .string(root.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "UPDATE_INSTALL_PROJECT", message: model.error) }
        await model.newTerminal()
        try await TerminalSmoke.wait("Start retained installation PTY") { model.selectedTerminal?.generation != nil && (model.selectedTerminal?.qaRenderedFrames ?? 0) > 0 }
        guard let terminal = model.selectedTerminal, let generation = terminal.generation else { throw BridgeFailure(code: "UPDATE_INSTALL_PTY", message: "Missing installation PTY") }
        let guards = try await UpdateQuitGuardSmoke.run(model: model, window: window, openSSH: openSSH,
            openDatabase: openDatabase, attemptQuit: attemptQuit, evidence: URL(fileURLWithPath: reportPath).deletingLastPathComponent())
        try Data("BEFORE_INSTALL\n".utf8).write(to: root.appendingPathComponent("upgrade.txt"))
        let content = try await openFile(root, "upgrade.txt")
        try await ContentSmoke.wait(content, "document.querySelector('.cm-content[contenteditable=true]') !== null")
        try await EditorSmoke.replace(content, text: text)
        try await ContentSmoke.wait(content, "document.querySelector('.cm-content')?.textContent.includes('SDK_INSTALL_DRAFT') === true")
        guard try String(contentsOf: root.appendingPathComponent("upgrade.txt"), encoding: .utf8) == "BEFORE_INSTALL\n" else { throw BridgeFailure(code: "UPDATE_INSTALL_DRAFT", message: "Fixture did not retain a real unsaved editor draft") }
        let status = try await bridge.call("host.status")
        guard let hostPID = status["pid"].number, hostPID > 0 else { throw BridgeFailure(code: "UPDATE_INSTALL_HOST", message: "Missing retained host PID") }
        try JSONSerialization.data(withJSONObject: ["oldVersion": "1", "originalAppPID": ProcessInfo.processInfo.processIdentifier, "hostPID": hostPID, "sessionID": terminal.id, "generation": generation, "quitGuards": guards], options: .sortedKeys).write(to: checkpoint, options: .atomic)
        let driver = NativeUpdateTestDriver(mode: "install")
        try model.updates.configureTestDriver(driver)
        model.updates.check()
        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline {
            guard driver.errors.isEmpty, model.updates.error.isEmpty else { throw BridgeFailure(code: "UPDATE_INSTALL_SDK", message: "Actual SDK install failed: " + driver.errors.joined(separator: ",")) }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw BridgeFailure(code: "UPDATE_INSTALL_TIMEOUT", message: "SDK did not replace and relaunch the application")
    }
}
