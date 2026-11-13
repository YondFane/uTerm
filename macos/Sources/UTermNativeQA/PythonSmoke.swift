import AppKit
import SwiftTerm
import UTermBridge

@MainActor
enum PythonSmoke {
    static func run(model: WorkspaceModel, open: (URL) async throws -> PythonWindow,
                    lookup: @escaping (String) -> PythonWindow?, report: inout [String: Any]) async throws {
        guard let bridge = model.bridge,
              let reportPath = WorkspaceModel.argument("--python-smoke-report"),
              let interpreter = WorkspaceModel.argument("--python-qa-interpreter") else {
            throw BridgeFailure(code: "PYTHON_QA", message: "Missing isolated Python QA context")
        }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent().appendingPathComponent("python-project 中文")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "import sys,os\nprint('ARGV:'+sys.argv[1],flush=True)\nprint('ENV:'+os.environ['VALUE'],flush=True)\nprint('LAST:中文 e\\u0301',flush=True)\nsys.exit(7)\n".write(to: root.appendingPathComponent("task 中文 & %.py"), atomically: true, encoding: .utf8)
        try "import time,signal,sys,pathlib\ndef stop(*args):\n print('STOP_CLEANUP',flush=True)\n sys.exit(0)\nsignal.signal(signal.SIGINT,stop)\nprint('LONG_READY 中文',flush=True)\nfor i in range(120): print('BEFORE_PAUSE_'+str(i),flush=True)\nwhile not pathlib.Path('qa-continue').exists(): time.sleep(0.02)\nfor i in range(120): print('AFTER_PAUSE_'+str(i),flush=True)\ntime.sleep(60)\n".write(to: root.appendingPathComponent("long.py"), atomically: true, encoding: .utf8)
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        guard await model.mutate("project.open", ["id": .string("native-python-qa"), "name": .string("Python QA"), "directory": .string(root.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "PYTHON_QA", message: model.error) }
        guard let menu = NSApp.mainMenu?.items.compactMap(\.submenu).first(where: { $0.items.contains { $0.title == "Python run…" } }),
              let index = menu.items.firstIndex(where: { $0.title == "Python run…" }) else { throw BridgeFailure(code: "PYTHON_QA", message: "Native Python menu is missing") }
        menu.performActionForItem(at: index)
        try await TerminalSmoke.wait("Open Python through its native menu") { lookup(root.path)?.model.config != nil && lookup(root.path)?.model.busy == false }
        guard let first = lookup(root.path), first.window != nil else { throw BridgeFailure(code: "PYTHON_QA", message: "Python window is missing") }
        try await TerminalSmoke.wait("Native Python menu mounts its panel in the main workspace") { model.panels.panels.contains { $0.controller === first && $0.view.window?.isVisible == true } }
        guard let embedded = model.panels.panels.first(where: { $0.controller === first }), let workspaceWindow = embedded.view.window else { throw BridgeFailure(code: "RUN_MENU", message: "The run menu did not mount the actual workspace panel") }
        let menuCapture = "native-python-menu-workspace.png"
        try await TerminalSmoke.capture(window: workspaceWindow, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(menuCapture))
        report["nativePythonMenuOpened"] = true; report["nativePythonMenuWorkspaceCapture"] = menuCapture
        try await ProjectRunSmoke.restoreStandalone(model: model, panel: embedded)
        let run = first.model
        let original = run.config?.target
        guard !(await run.applySelection(nil, kind: "script")), run.config?.target == original, !run.dirty else { throw BridgeFailure(code: "PYTHON_QA", message: "Cancelled path selection changed the draft") }
        let link = root.appendingPathComponent("venv-python")
        try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: interpreter)
        guard await run.applySelection(link, kind: "interpreter"), run.config?.interpreter == link.path else { throw BridgeFailure(code: "PYTHON_QA", message: "Selected interpreter symlink spelling was lost") }
        guard await run.applySelection(root.appendingPathComponent("task 中文 & %.py"), kind: "script"), run.config?.target == "task 中文 & %.py" else { throw BridgeFailure(code: "PYTHON_QA", message: "Literal script selection failed") }
        guard await run.applySelection(root, kind: "directory"), run.config?.working_directory == "." else { throw BridgeFailure(code: "PYTHON_QA", message: "Root working-directory selection failed") }
        let outside = root.deletingLastPathComponent().appendingPathComponent("outside.py")
        try "print('outside')".write(to: outside, atomically: true, encoding: .utf8)
        guard !(await run.applySelection(outside, kind: "script")), run.config?.target == "task 中文 & %.py", run.error.contains("PYTHON_PROJECT_INVALID") else { throw BridgeFailure(code: "PYTHON_QA", message: "Outside script selection changed the draft") }
        report["nativePathSelectionBoundaries"] = true
        run.config?.interpreter = interpreter; run.config?.target = "task 中文 & %.py"
        run.arguments = [PythonArgument(text: "literal & %PATH%")]
        var environment = PythonEnvironment(); environment.key = "VALUE"; environment.value = "环境 & %PATH%"
        run.environment = [environment]; run.dirty = true
        guard await run.save() else { throw BridgeFailure(code: "PYTHON_QA", message: run.error) }
        let current = try await bridge.call("python.configuration", params: .object(["directory": .string(root.path)]))
        var changed = current["project"]
        if case .object(var values) = changed { values["target"] = .string("external.py"); changed = .object(values) }
        _ = try await bridge.call("python.saveConfiguration", params: .object(["directory": .string(root.path), "revision": current["revision"], "config": changed]))
        run.config?.target = "retained-draft.py"; run.dirty = true
        guard !(await run.save()), run.config?.target == "retained-draft.py", run.error.contains("PYTHON_CONFIG_CONFLICT") else { throw BridgeFailure(code: "PYTHON_QA", message: "Conflict did not retain the native draft") }
        report["configurationConflictRetainedDraft"] = true
        let folder = URL(fileURLWithPath: reportPath).deletingLastPathComponent()
        var captures: [String] = []
        func capture(_ controller: PythonWindow, _ name: String) async throws {
            guard let window = controller.window else { throw BridgeFailure(code: "PYTHON_QA", message: "No window to capture") }
            window.makeKeyAndOrderFront(nil)
            try await TerminalSmoke.capture(window: window, path: folder.appendingPathComponent(name))
        }
        let conflict = "native-python-conflict-en-dark.png"
        try await capture(first, conflict); captures.append(conflict)
        await run.reload()
        guard run.config?.target == "external.py" else { throw BridgeFailure(code: "PYTHON_QA", message: "Explicit reload did not load the external configuration") }
        run.config?.target = "task 中文 & %.py"; run.dirty = true
        await run.run()
        guard run.error.isEmpty else { throw BridgeFailure(code: "PYTHON_QA", message: run.error) }
        try await TerminalSmoke.wait("Render real Python final output") { run.terminal?.text.contains("LAST:中文 e\u{301}") == true && run.terminal?.exited == true }
        await run.refreshTasks()
        guard run.selectedTask["code"].number == 7,
              run.terminal?.text.contains("ARGV:literal & %PATH%") == true,
              run.terminal?.text.contains("ENV:环境 & %PATH%") == true else { throw BridgeFailure(code: "PYTHON_QA", message: "Python lost literal arguments, environment, final output or exit code") }
        report["realPythonFinalOutputAndExitCode"] = true
        report["hostStarted"] = true
        let host = try await bridge.call("host.status")
        report["pythonHostPID"] = host["pid"].number
        run.search = "ARGV:literal & %PATH%"; run.find()
        guard run.terminal?.view.searchMatchSummary(run.search).total == 1 else { throw BridgeFailure(code: "PYTHON_QA", message: "Native log search did not find literal output") }
        report["nativeLogSearchFoundLiteralOutput"] = true
        let output = "native-python-output-en-dark.png"
        try await capture(first, output); captures.append(output)
        run.config?.target = "long.py"; run.dirty = true
        await run.run()
        try await TerminalSmoke.wait("Start the disposable long Python task") { run.terminal?.text.contains("BEFORE_PAUSE_119") == true }
        try await ProjectRunSmoke.run(model: model, language: "python", controller: first, task: run.selectedTask, evidence: URL(fileURLWithPath: reportPath).deletingLastPathComponent(), report: &report)
        guard let log = run.terminal else { throw BridgeFailure(code: "PYTHON_QA", message: "No task log for scroll acceptance") }
        log.view.scrollUp(lines: 20)
        guard !log.taskLogFollowsOutput else { throw BridgeFailure(code: "PYTHON_QA", message: "Scrolling up did not pause following") }
        let anchor = log.view.getTerminal().buffer.totalLinesTrimmed + log.view.getTerminal().buffer.yDisp
        try Data().write(to: root.appendingPathComponent("qa-continue"))
        try await TerminalSmoke.wait("Consume raw output while follow is paused") { log.text.contains("AFTER_PAUSE_119") }
        guard !log.taskLogFollowsOutput, log.view.getTerminal().buffer.totalLinesTrimmed + log.view.getTerminal().buffer.yDisp == anchor else { throw BridgeFailure(code: "PYTHON_QA", message: "New output moved the paused viewport") }
        report["nativePausedFollowRetainedAnchor"] = true
        let paused = "native-python-paused-output-en-dark.png"
        try await capture(first, paused); captures.append(paused)
        log.followTaskLog(true)
        guard log.taskLogFollowsOutput, log.view.scrollPosition == 1 else { throw BridgeFailure(code: "PYTHON_QA", message: "Follow did not resume at the final output") }
        report["nativeFollowResumed"] = true
        let active = run.selectedTask
        await first.forceClose()
        let retained = try await bridge.call("python.tasks", params: .object(["directory": .string(root.path)]))
        guard retained.array.contains(where: { $0["spec"]["id"] == active["spec"]["id"] && $0["generation"] == active["generation"] && $0["running"].bool == true }) else { throw BridgeFailure(code: "PYTHON_QA", message: "Closing the Python window killed or replaced its task") }
        report["windowDetachRetainedTask"] = true
        await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
        let reopened = try await open(root)
        try await TerminalSmoke.wait("Replay Python output after reopening") { reopened.model.terminal?.text.contains("LONG_READY 中文") == true }
        guard reopened.model.selectedTask["generation"] == active["generation"] else { throw BridgeFailure(code: "PYTHON_QA", message: "Python reattach changed generation") }
        report["reopenedSameGenerationAndReplay"] = true
        guard (try await bridge.call("host.status"))["pid"] == host["pid"] else { throw BridgeFailure(code: "PYTHON_QA", message: "Reopening replaced the active Python host") }
        report["reattachRetainedHostPID"] = true
        reopened.window?.setContentSize(NSSize(width: 660, height: 620))
        let narrow = "native-python-replay-zh-light.png"
        try await capture(reopened, narrow); captures.append(narrow)
        do {
            _ = try await bridge.call("python.stop", params: .object(["id": active["spec"]["id"], "generation": .string("stale"), "force": .bool(true)]))
            throw BridgeFailure(code: "PYTHON_QA", message: "Stale Python stop was accepted")
        } catch let error as BridgeFailure where error.code == "PYTHON_TASK_REPLACED" { report["staleGenerationStopRefused"] = true }
        await reopened.model.runAgain()
        guard reopened.model.error.isEmpty, reopened.model.selectedTask["running"].bool == true,
              reopened.model.selectedTask["generation"] != active["generation"],
              reopened.model.tasks.contains(where: { $0["spec"]["id"] == active["spec"]["id"] && $0["running"].bool == false && $0["code"].number == 0 }) else { throw BridgeFailure(code: "PYTHON_QA", message: "Run again did not wait for normal stop before the new generation") }
        let restartedID = reopened.model.selectedID
        reopened.model.selectedID = active["spec"]["id"].string ?? ""
        await reopened.model.selectTask()
        try await TerminalSmoke.wait("Replay final cleanup from the old task") { reopened.model.terminal?.text.contains("STOP_CLEANUP") == true }
        reopened.model.copyOutput()
        guard NSPasteboard.general.string(forType: .string)?.contains("STOP_CLEANUP") == true else { throw BridgeFailure(code: "PYTHON_QA", message: "Native copy lost retained final output") }
        report["runAgainWaitedForOldExit"] = true
        report["normalStopRetainedFinalOutputAndCopy"] = true
        let historyID = reopened.model.selectedID
        guard reopened.model.running, reopened.model.selectedTask["running"].bool == false else { throw BridgeFailure(code: "PYTHON_QA", message: "History selection did not retain a separate active task") }
        await reopened.model.stop(force: true)
        for _ in 0..<100 {
            await reopened.model.refreshTasks()
            if !reopened.model.running { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        guard !reopened.model.running else { throw BridgeFailure(code: "PYTHON_QA", message: "Force stop did not stop the target Python process") }
        guard reopened.model.selectedID == historyID else { throw BridgeFailure(code: "PYTHON_QA", message: "Stopping the active task replaced the selected history log") }
        report["activeTaskStoppedWhileHistorySelected"] = true
        reopened.model.selectedID = restartedID
        await reopened.model.selectTask()
        report["forceStopCompleted"] = true
        report["temporaryEnvironmentNotSaved"] = (try await bridge.call("python.configuration", params: .object(["directory": .string(root.path)])))["project"]["environment"] == .null
        _ = try await bridge.call("host.shutdownIdle")
        await reopened.forceClose()
        report["pythonCaptures"] = captures
        report["pythonInputMethod"] = "Actual NSMenu entry, native bound form and selection-result state with Core/FFI calls; no manual picker/keyboard/IME acceptance"
        report["pythonInterpreter"] = interpreter
    }
}
