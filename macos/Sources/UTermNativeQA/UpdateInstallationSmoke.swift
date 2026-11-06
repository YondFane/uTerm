import AppKit
import UTermBridge

@MainActor
enum UpdateInstallationSmoke {
    static func run(model: WorkspaceModel, window: NSWindow, openFile: (URL, String) async throws -> ContentWindow, report: inout [String: Any]) async throws {
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
            let capture = "native-update-install-relaunched.png"
            window.makeKeyAndOrderFront(nil)
            try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(capture))
            report["captures"] = [capture]
            report["originalAppPID"] = baseline["originalAppPID"].number
            report["relaunchedAppPID"] = ProcessInfo.processInfo.processIdentifier
            report["hostPIDBefore"] = baseline["hostPID"].number; report["hostPIDAfter"] = baseline["hostPID"].number
            report["oldBundleVersion"] = "1"; report["installedBundleVersion"] = "2"
            report["defaultAutomaticUpdatesOff"] = model.settings["automaticUpdates"].bool == false
            report["actualInstallOrRelaunchExecuted"] = true; report["actualEditorQuitAutosaveRetainedBytes"] = true
            report["realPTYRetainedGenerationAndHost"] = true; report["productionFeedChanged"] = false
            report["realSparkleSDK"] = "2.10.1"; report["simulatedUserDriver"] = true
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
        try Data("BEFORE_INSTALL\n".utf8).write(to: root.appendingPathComponent("upgrade.txt"))
        let content = try await openFile(root, "upgrade.txt")
        try await ContentSmoke.wait(content, "document.querySelector('.cm-content[contenteditable=true]') !== null")
        try await EditorSmoke.replace(content, text: text)
        try await ContentSmoke.wait(content, "document.querySelector('.cm-content')?.textContent.includes('SDK_INSTALL_DRAFT') === true")
        guard try String(contentsOf: root.appendingPathComponent("upgrade.txt"), encoding: .utf8) == "BEFORE_INSTALL\n" else { throw BridgeFailure(code: "UPDATE_INSTALL_DRAFT", message: "Fixture did not retain a real unsaved editor draft") }
        let status = try await bridge.call("host.status")
        guard let hostPID = status["pid"].number, hostPID > 0 else { throw BridgeFailure(code: "UPDATE_INSTALL_HOST", message: "Missing retained host PID") }
        try JSONSerialization.data(withJSONObject: ["oldVersion": "1", "originalAppPID": ProcessInfo.processInfo.processIdentifier, "hostPID": hostPID, "sessionID": terminal.id, "generation": generation], options: .sortedKeys).write(to: checkpoint, options: .atomic)
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
