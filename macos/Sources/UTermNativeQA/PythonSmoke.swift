import AppKit
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
        try "import time\nprint('LONG_READY 中文',flush=True)\ntime.sleep(60)\n".write(to: root.appendingPathComponent("long.py"), atomically: true, encoding: .utf8)
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        guard await model.mutate("project.open", ["id": .string("native-python-qa"), "name": .string("Python QA"), "directory": .string(root.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "PYTHON_QA", message: model.error) }
        guard let menu = NSApp.mainMenu?.items.compactMap(\.submenu).first(where: { $0.items.contains { $0.title == "Python run…" } }),
              let index = menu.items.firstIndex(where: { $0.title == "Python run…" }) else { throw BridgeFailure(code: "PYTHON_QA", message: "Native Python menu is missing") }
        menu.performActionForItem(at: index)
        try await TerminalSmoke.wait("Open Python through its native menu") { lookup(root.path)?.model.config != nil && lookup(root.path)?.model.busy == false }
        guard let first = lookup(root.path), let firstWindow = first.window else { throw BridgeFailure(code: "PYTHON_QA", message: "Python window is missing") }
        report["nativePythonMenuOpened"] = firstWindow.isVisible
        let run = first.model
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
        let output = "native-python-output-en-dark.png"
        try await capture(first, output); captures.append(output)
        run.config?.target = "long.py"; run.dirty = true
        await run.run()
        try await TerminalSmoke.wait("Start the disposable long Python task") { run.terminal?.text.contains("LONG_READY 中文") == true }
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
        reopened.window?.setContentSize(NSSize(width: 660, height: 620))
        let narrow = "native-python-replay-zh-light.png"
        try await capture(reopened, narrow); captures.append(narrow)
        do {
            _ = try await bridge.call("python.stop", params: .object(["id": active["spec"]["id"], "generation": .string("stale"), "force": .bool(true)]))
            throw BridgeFailure(code: "PYTHON_QA", message: "Stale Python stop was accepted")
        } catch let error as BridgeFailure where error.code == "PYTHON_TASK_REPLACED" { report["staleGenerationStopRefused"] = true }
        await reopened.model.stop(force: true)
        for _ in 0..<100 {
            await reopened.model.refreshTasks()
            if !reopened.model.running { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        guard !reopened.model.running else { throw BridgeFailure(code: "PYTHON_QA", message: "Force stop did not stop the target Python process") }
        report["forceStopCompleted"] = true
        report["temporaryEnvironmentNotSaved"] = (try await bridge.call("python.configuration", params: .object(["directory": .string(root.path)])))["project"]["environment"] == .null
        _ = try await bridge.call("host.shutdownIdle")
        await reopened.forceClose()
        report["pythonCaptures"] = captures
        report["pythonInputMethod"] = "Actual NSMenu entry, native bound form state and Core/FFI calls; no manual keyboard/IME acceptance"
        report["pythonInterpreter"] = interpreter
    }
}
