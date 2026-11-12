import AppKit
import SwiftTerm
import UTermBridge

@MainActor
enum JavaSmoke {
    static func run(model: WorkspaceModel, open: (URL) async throws -> JavaWindow,
                    lookup: @escaping (String) -> JavaWindow?, report: inout [String: Any]) async throws {
        guard let bridge = model.bridge,
              let reportPath = WorkspaceModel.argument("--java-smoke-report"),
              let home = WorkspaceModel.argument("--java-qa-home") else {
            throw BridgeFailure(code: "JAVA_QA", message: "Missing isolated Java QA context")
        }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent().appendingPathComponent("java-project 中文")
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("target/literal 中文 & %.jar").path) else {
            throw BridgeFailure(code: "JAVA_QA", message: "Build the disposable QA JAR first")
        }
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        guard await model.mutate("project.open", ["id": .string("native-java-qa"), "name": .string("Java QA"), "directory": .string(root.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "JAVA_QA", message: model.error) }
        guard let menu = NSApp.mainMenu?.items.compactMap(\.submenu).first(where: { $0.items.contains { $0.title == "Java build and run…" } }),
              let index = menu.items.firstIndex(where: { $0.title == "Java build and run…" }) else { throw BridgeFailure(code: "JAVA_QA", message: "Native Java menu is missing") }
        menu.performActionForItem(at: index)
        try await TerminalSmoke.wait("Open Java through its native menu") { lookup(root.path)?.model.config != nil && lookup(root.path)?.model.busy == false }
        guard let first = lookup(root.path), first.window != nil else { throw BridgeFailure(code: "JAVA_QA", message: "Java window is missing") }
        try await TerminalSmoke.wait("Native Java menu mounts its panel in the main workspace") { model.panels.panels.contains { $0.controller === first && $0.view.window?.isVisible == true } }
        guard let embedded = model.panels.panels.first(where: { $0.controller === first }), let workspaceWindow = embedded.view.window else { throw BridgeFailure(code: "RUN_MENU", message: "The run menu did not mount the actual workspace panel") }
        let menuCapture = "native-java-menu-workspace.png"
        try await TerminalSmoke.capture(window: workspaceWindow, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(menuCapture))
        report["nativeJavaMenuOpened"] = true; report["nativeJavaMenuWorkspaceCapture"] = menuCapture
        try await ProjectRunSmoke.restoreStandalone(model: model, panel: embedded)
        let run = first.model
        run.config?.java_home = home; run.config?.mode = "jar"; run.config?.jar = "target/literal 中文 & %.jar"; run.config?.offline = true
        run.arguments = [JavaArgument(text: "literal & %PATH%"), JavaArgument(text: "")]
        run.vmArguments = [JavaArgument(text: "-Dqa.value=property & %PATH%")]
        var environment = JavaEnvironment(); environment.key = "VALUE"; environment.value = "环境 & %PATH%"
        run.environment = [environment]; run.dirty = true
        await run.registerJDK()
        guard run.jdks.contains(where: { $0["registered"].bool == true && $0["available"].bool == true && $0["version"].number == 21 }) else { throw BridgeFailure(code: "JAVA_QA", message: "Native JDK registration failed: " + run.error) }
        report["nativeJDKRegistration"] = true
        guard await run.save() else { throw BridgeFailure(code: "JAVA_QA", message: run.error) }
        let current = try await bridge.call("java.configuration", params: .object(["directory": .string(root.path)]))
        var changed = current["project"]
        if case .object(var values) = changed { values["jar"] = .string("external.jar"); changed = .object(values) }
        _ = try await bridge.call("java.saveConfiguration", params: .object(["directory": .string(root.path), "revision": current["revision"], "project": changed]))
        run.config?.jar = "retained-draft.jar"; run.dirty = true
        guard !(await run.save()), run.config?.jar == "retained-draft.jar", run.error.contains("JAVA_CONFIG_CONFLICT") else { throw BridgeFailure(code: "JAVA_QA", message: "Java conflict lost the draft") }
        report["configurationConflictRetainedDraft"] = true
        let folder = URL(fileURLWithPath: reportPath).deletingLastPathComponent()
        var captures: [String] = []
        func capture(_ controller: JavaWindow, _ name: String) async throws {
            guard let target = controller.window else { throw BridgeFailure(code: "JAVA_QA", message: "Missing capture window") }
            target.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
            try await Task.sleep(for: .milliseconds(200))
            try await TerminalSmoke.capture(window: target, path: folder.appendingPathComponent(name)); captures.append(name)
        }
        try await capture(first, "native-java-conflict-en-dark.png")
        await run.reload()
        run.config?.jar = "target/literal 中文 & %.jar"; run.dirty = true
        run.config?.mode = "development"
        await run.run()
        guard !run.running, run.error.contains("Use JAR mode."), run.arguments.contains(where: { $0.text.isEmpty }) else { throw BridgeFailure(code: "JAVA_QA", message: "Unsupported development arguments were not visibly rejected and retained") }
        report["unsupportedDevelopmentArgumentsRejected"] = true
        try await capture(first, "native-java-arguments-rejected-en-dark.png")
        run.config?.mode = "jar"; run.dirty = true
        await run.run()
        try await TerminalSmoke.wait("Receive Java final bytes and nonzero exit") { run.selectedTask["running"].bool == false && run.terminal?.text.contains("ERR_LAST:中文") == true }
        guard run.selectedTask["code"].number == 7,
              run.terminal?.text.contains("READY:literal & %PATH%:环境 & %PATH%:property & %PATH%:empty=true") == true,
              run.terminal?.text.contains("LAST:中文 e\u{301}") == true else { throw BridgeFailure(code: "JAVA_QA", message: "Java lost literal arguments, JVM/environment data, final output or exit code") }
        report["realJARFinalOutputAndExitCode"] = true
        report["existingJarBypassedInvalidWrapper"] = true
        report["hostStarted"] = true
        let host = try await bridge.call("host.status"); report["javaHostPID"] = host["pid"].number
        run.search = "READY:literal & %PATH%"; run.find()
        guard run.terminal?.view.searchMatchSummary(run.search).total == 1 else { throw BridgeFailure(code: "JAVA_QA", message: "Java native log search failed") }
        report["nativeLogSearchFoundLiteralOutput"] = true
        try await capture(first, "native-java-output-en-dark.png")
        run.arguments.append(JavaArgument(text: "long")); run.dirty = true
        await run.run()
        try await TerminalSmoke.wait("Receive long Java task output") { run.terminal?.text.contains("BEFORE_PAUSE_119") == true }
        try await ProjectRunSmoke.run(model: model, language: "java", controller: first, task: run.selectedTask, evidence: URL(fileURLWithPath: reportPath).deletingLastPathComponent(), report: &report)
        guard let log = run.terminal else { throw BridgeFailure(code: "JAVA_QA", message: "Java task log is missing") }
        log.view.scrollUp(lines: 20)
        let anchor = log.view.getTerminal().buffer.totalLinesTrimmed + log.view.getTerminal().buffer.yDisp
        guard !log.taskLogFollowsOutput else { throw BridgeFailure(code: "JAVA_QA", message: "Java scroll did not pause follow") }
        try Data().write(to: root.appendingPathComponent("qa-continue"))
        try await TerminalSmoke.wait("Consume Java output while paused") { log.text.contains("AFTER_PAUSE_119") }
        guard !log.taskLogFollowsOutput, log.view.getTerminal().buffer.totalLinesTrimmed + log.view.getTerminal().buffer.yDisp == anchor else { throw BridgeFailure(code: "JAVA_QA", message: "Java paused viewport moved") }
        report["nativePausedFollowRetainedAnchor"] = true
        try await capture(first, "native-java-paused-output-en-dark.png")
        log.followTaskLog(true)
        guard log.taskLogFollowsOutput, log.view.scrollPosition == 1 else { throw BridgeFailure(code: "JAVA_QA", message: "Java follow did not resume") }
        report["nativeFollowResumed"] = true
        let active = run.selectedTask
        await first.forceClose()
        let retained = try await bridge.call("java.tasks", params: .object(["directory": .string(root.path)]))
        guard retained.array.contains(where: { $0["spec"]["id"] == active["spec"]["id"] && $0["generation"] == active["generation"] && $0["running"].bool == true }) else { throw BridgeFailure(code: "JAVA_QA", message: "Closing Java window killed the task") }
        report["windowDetachRetainedTask"] = true
        await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
        let reopened = try await open(root)
        try await TerminalSmoke.wait("Replay Java after reopening") { reopened.model.terminal?.text.contains("AFTER_PAUSE_119") == true }
        guard reopened.model.selectedTask["generation"] == active["generation"], (try await bridge.call("host.status"))["pid"] == host["pid"] else { throw BridgeFailure(code: "JAVA_QA", message: "Java reattach changed host/generation") }
        report["reopenedSameGenerationAndHost"] = true
        reopened.window?.setContentSize(NSSize(width: 680, height: 650))
        try await capture(reopened, "native-java-replay-zh-light.png")
        do {
            _ = try await bridge.call("java.stop", params: .object(["id": active["spec"]["id"], "generation": .string("stale"), "force": .bool(true)]))
            throw BridgeFailure(code: "JAVA_QA", message: "Stale Java stop was accepted")
        } catch let failure as BridgeFailure where failure.code == "JAVA_TASK_REPLACED" {}
        report["staleGenerationStopRefused"] = true
        await reopened.model.stop(force: false)
        try await TerminalSmoke.wait("Preserve Java shutdown output") { !reopened.model.running && reopened.model.terminal?.text.contains("STOP_CLEANUP") == true }
        reopened.model.copyOutput()
        guard NSPasteboard.general.string(forType: .string)?.contains("STOP_CLEANUP") == true else { throw BridgeFailure(code: "JAVA_QA", message: "Java cleanup output was not copied") }
        report["normalStopRetainedFinalOutputAndCopy"] = true
        reopened.model.environment = [environment]
        await reopened.model.runAgain()
        try await TerminalSmoke.wait("Start Java again") { reopened.model.running }
        let previous = reopened.model.selectedTask
        await reopened.model.runAgain()
        guard reopened.model.running, reopened.model.selectedTask["generation"] != previous["generation"],
              reopened.model.tasks.contains(where: { $0["spec"]["id"] == previous["spec"]["id"] && $0["running"].bool == false }) else { throw BridgeFailure(code: "JAVA_QA", message: "Java rerun did not wait for old exit") }
        report["runAgainWaitedForOldExit"] = true
        await reopened.model.stop(force: true)
        try await TerminalSmoke.wait("Force stop Java") { !reopened.model.running }
        report["forceStopCompleted"] = true
        report["temporaryEnvironmentNotSaved"] = (try await bridge.call("java.configuration", params: .object(["directory": .string(root.path)])))["project"]["environment"] == .null
        await reopened.forceClose()
        report["javaCaptures"] = captures
        report["javaInputMethod"] = "Actual NSMenu entry, native bound form state and Core/FFI calls; manual picker/keyboard/IME not accepted"
        report["javaHome"] = home
    }
}
