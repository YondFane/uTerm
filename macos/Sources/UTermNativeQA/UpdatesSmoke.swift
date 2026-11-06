import AppKit
import UTermBridge

@MainActor
enum UpdatesSmoke {
    static func run(model: WorkspaceModel, window: NSWindow, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.bridge, let path = WorkspaceModel.argument("--updates-smoke-report"),
              let mode = Bundle.main.object(forInfoDictionaryKey: "UTermUpdateTestMode") as? String,
              model.updates.configuration?.qa == true else { throw BridgeFailure(code: "UPDATE_QA_CONTEXT", message: "Missing isolated SDK update context") }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent()
        let updates = model.updates
        guard updates.controller == nil, updates.updater == nil, model.settings["automaticUpdates"].bool == false else { throw BridgeFailure(code: "UPDATE_QA_DEFAULT", message: "Update checks started without opt-in") }
        let driver = NativeUpdateTestDriver(mode: mode)
        try updates.configureTestDriver(driver)
        guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("Update QA"), "directory": .string(root.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "UPDATE_QA_PROJECT", message: model.error) }
        await model.newTerminal()
        try await TerminalSmoke.wait("Attach update-test PTY") { model.selectedTerminal?.generation != nil && (model.selectedTerminal?.qaRenderedFrames ?? 0) > 0 }
        guard let terminal = model.selectedTerminal, let generation = terminal.generation else { throw BridgeFailure(code: "UPDATE_QA_PTY", message: "Missing real update-test terminal") }
        let hostBefore = try await bridge.call("host.status")
        updates.check()
        guard updates.error.isEmpty else { throw BridgeFailure(code: "UPDATE_QA_START", message: updates.error) }
        func waitForCycle(after count: Int) async throws {
            let deadline = Date().addingTimeInterval(90)
            while Date() < deadline {
                if updates.qaEvents.filter({ $0 == "cycle-finished" }).count > count, updates.updater?.sessionInProgress == false { return }
                try await Task.sleep(for: .milliseconds(100))
            }
            throw BridgeFailure(code: "UPDATE_QA_TIMEOUT", message: "SDK update cycle did not finish")
        }
        try await waitForCycle(after: 0)
        report["sdkEvents"] = updates.qaEvents
        report["sdkErrors"] = driver.errors
        report["sdkLastError"] = updates.qaLastError
        report["policyRejected"] = updates.qaPolicyRejected
        report["downloadedBytes"] = String(driver.receivedBytes)
        report["readyToInstall"] = driver.ready; report["foundVersion"] = driver.foundVersion ?? ""
        switch mode {
        case "good": guard driver.ready && driver.errors.isEmpty && updates.qaPolicyRejected.isEmpty else { throw BridgeFailure(code: "UPDATE_QA_VALID", message: "Valid signed SDK update did not reach ready state") }
        case "bad-signature": guard !driver.ready && (driver.errors.contains("SUSparkleErrorDomain:3001") || updates.qaLastError == "SUSparkleErrorDomain:3001") else { throw BridgeFailure(code: "UPDATE_QA_SIGNATURE", message: "Bad signature was not rejected by the SDK verifier") }
        case "wrong-arch": guard !driver.ready && updates.qaPolicyRejected == "UPDATE_TARGET" else { throw BridgeFailure(code: "UPDATE_QA_ARCH", message: "Wrong architecture was not rejected before download") }
        case "old-version", "wrong-channel": guard driver.notFound && !driver.ready && driver.receivedBytes == 0 else { throw BridgeFailure(code: "UPDATE_QA_VERSION_CHANNEL", message: "Old or wrong-channel update proceeded") }
        case "cancel": guard driver.cancelled && !driver.ready else { throw BridgeFailure(code: "UPDATE_QA_CANCEL", message: "Download cancellation did not stop installation") }
        case "offline", "interrupted": guard !driver.ready && !driver.errors.isEmpty else { throw BridgeFailure(code: "UPDATE_QA_NETWORK", message: "Failed transport did not reach a visible SDK error") }
        default: throw BridgeFailure(code: "UPDATE_QA_MODE", message: "Unknown SDK update scenario")
        }
        if ["offline", "interrupted"].contains(mode) {
            let cycles = updates.qaEvents.filter { $0 == "cycle-finished" }.count
            driver.resetForRetry()
            try Data().write(to: root.appendingPathComponent("retry-enabled"))
            updates.check()
            try await waitForCycle(after: cycles)
            guard driver.ready, driver.errors.isEmpty else { throw BridgeFailure(code: "UPDATE_QA_RETRY", message: "SDK download did not recover after the isolated server became available") }
            report["actualSDKRetryReachedReady"] = true
        }
        terminal.enqueue(Data("printf 'UPDATE_%s\\n' PTY_OK\r".utf8))
        try await TerminalSmoke.wait("Continue real PTY output after update cycle") { terminal.text.contains("UPDATE_PTY_OK") }
        let hostAfter = try await bridge.call("host.status")
        guard let pid = hostBefore["pid"].number, pid > 0, terminal.generation == generation, hostBefore["pid"] == hostAfter["pid"] else { throw BridgeFailure(code: "UPDATE_QA_HOST", message: "Update check/download replaced the running session host") }
        report["hostPIDBefore"] = pid; report["hostPIDAfter"] = pid
        let capture = "native-update-" + mode + ".png"
        try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(capture))
        report["captures"] = [capture]
        report["realSparkleSDK"] = "2.10.1"; report["simulatedUserDriver"] = true
        report["actualInstallOrRelaunchExecuted"] = false; report["productionFeedChanged"] = false
        report["defaultAutomaticUpdatesOff"] = true; report["realPTYRetainedGenerationAndHost"] = true
        await model.closeSession()
    }
}
