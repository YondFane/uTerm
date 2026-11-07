import AppKit
import Foundation
import UTermBridge

@MainActor
enum InputControlSmoke {
    private static func wait(_ label: String, until condition: @escaping @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(40)
        while !condition() {
            guard Date() < deadline else { throw BridgeFailure(code: "CONTROL_QA_TIMEOUT", message: label) }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
    private static func pressTakeControl(in window: NSWindow) throws {
        var queue = window.contentView.map { [$0] } ?? []
        while !queue.isEmpty {
            let view = queue.removeFirst()
            if let button = view as? NSButton, button.identifier?.rawValue == "native-terminal-take-control", button.isEnabled {
                button.performClick(nil)
                return
            }
            queue.append(contentsOf: view.subviews)
        }
        throw BridgeFailure(code: "CONTROL_QA_BUTTON", message: "Native take-control button is unavailable")
    }
    private static func denied(_ operation: () async throws -> Void) async throws {
        do { try await operation() }
        catch {
            guard error.localizedDescription.contains("SESSION_CONTROL_REQUIRED") else { throw error }
            return
        }
        throw BridgeFailure(code: "CONTROL_QA_WRITE", message: "A passive write or resize unexpectedly succeeded")
    }
    static func run(model: WorkspaceModel, window: NSWindow?, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.bridge, let window,
              let role = WorkspaceModel.argument("--input-control-role"), ["owner", "viewer"].contains(role),
              let path = WorkspaceModel.argument("--input-control-report") else {
            throw BridgeFailure(code: "CONTROL_QA_START", message: model.error)
        }
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent()
        let project = root.appendingPathComponent("input-control-project")
        let evidence = URL(fileURLWithPath: path).deletingLastPathComponent()
        func exists(_ name: String) -> Bool { FileManager.default.fileExists(atPath: root.appendingPathComponent(name).path) }
        func signal(_ name: String) throws { try Data("ready\n".utf8).write(to: root.appendingPathComponent(name), options: .atomic) }
        if role == "owner" {
            try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
            await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
            guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("Shared input QA"), "directory": .string(project.path), "workspaceId": .string(model.groupID)]) else {
                throw BridgeFailure(code: "CONTROL_QA_PROJECT", message: model.error)
            }
            await model.newTerminal()
        }
        try await wait("Connect the same actual session") { model.selectedTerminal?.generation != nil && model.selectedTerminal?.inputControl != nil && model.selectedTerminal?.error.isEmpty == true }
        guard let terminal = model.selectedTerminal, let generation = terminal.generation else {
            throw BridgeFailure(code: "CONTROL_QA_SESSION", message: "The native session is unavailable")
        }
        let status = try await bridge.call("host.status")
        let pid = status["pid"]
        let sessionID = terminal.id
        report["role"] = role
        report["generation"] = generation
        report["sessionID"] = sessionID
        report["hostPID"] = pid.number ?? 0
        report["driver"] = "Two actual native application processes; native NSButton.performClick target/action"
        report["manualKeyboardIMEAcceptance"] = false
        report["productionDataAccess"] = false
        if role == "owner" {
            guard terminal.inputControl?.owned == true else { throw BridgeFailure(code: "CONTROL_QA_INITIAL", message: "The first attachment did not acquire control") }
            terminal.enqueue(Data("printf 'OWNER_%s 中文\\n' READY\r".utf8))
            try await wait("Render the original owner's output") { terminal.text.contains("OWNER_READY 中文") }
            try signal("owner-ready")
            try await wait("Observe explicit viewer takeover") { exists("viewer-taken") && terminal.inputControl?.owned == false && terminal.text.contains("VIEWER_READY 中文") }
            try await denied { try await bridge.write(attachment: terminal.attachment, bytes: Data("printf STALE > stale-owner.txt\r".utf8)) }
            terminal.enqueue(Data("printf QUEUED > queued-owner.txt\r".utf8))
            try await denied { _ = try await bridge.call("terminal.action", params: .object(["attachment": .string(terminal.attachment), "action": .string("resize"), "cols": .number(3), "rows": .number(4)])) }
            let size = (terminal.view.getTerminal().cols, terminal.view.getTerminal().rows)
            window.setContentSize(NSSize(width: 640, height: 640))
            window.makeKeyAndOrderFront(nil)
            try await Task.sleep(for: .milliseconds(400))
            guard terminal.inputControl?.owned == false, terminal.view.getTerminal().cols == size.0, terminal.view.getTerminal().rows == size.1 else {
                throw BridgeFailure(code: "CONTROL_QA_SIZE", message: "Passive window focus or resize changed control or host grid")
            }
            try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent("native-input-owner-readonly.png"))
            try signal("owner-checked")
            try await wait("Wait for ordinary viewer exit") { exists("viewer-exited") && terminal.inputControl?.owned == false && terminal.inputControl?.owner == nil }
            try pressTakeControl(in: window)
            try await wait("Reacquire through the native button") { terminal.inputControl?.owned == true }
            terminal.enqueue(Data("printf 'OWNER_%s\\n' RETURNED\r".utf8))
            try await wait("Retain input and process after the viewer quits") { terminal.text.contains("OWNER_RETURNED") }
            let retainedStatus = try await bridge.call("host.status")
            guard terminal.generation == generation, retainedStatus["pid"] == pid else {
                throw BridgeFailure(code: "CONTROL_QA_PROCESS", message: "Takeover replaced the host or process generation")
            }
            for name in ["stale-owner.txt", "queued-owner.txt", "passive-viewer.txt"] {
                guard !FileManager.default.fileExists(atPath: project.appendingPathComponent(name).path) else {
                    throw BridgeFailure(code: "CONTROL_QA_SIDE_EFFECT", message: "Rejected input created " + name)
                }
            }
            try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent("native-input-owner-returned.png"))
            report["passiveInputAndResizeRejected"] = true
            report["passiveWindowDidNotResizeOrStealControl"] = true
            report["passiveOutputContinued"] = true
            report["ordinaryViewerQuitRetainedProcess"] = true
            report["sameHostAndGeneration"] = true
            report["reacquiredThroughNativeButton"] = true
            report["captures"] = ["native-input-owner-readonly.png", "native-input-owner-returned.png"]
            await model.closeSession()
            let closedStatus = try await bridge.call("host.status")
            guard model.state?.sessions.isEmpty == true, closedStatus["sessions"].array.isEmpty else {
                throw BridgeFailure(code: "CONTROL_QA_CLOSE", message: "Explicit close did not remove the exact target")
            }
            _ = try await bridge.call("host.shutdownIdle")
            report["explicitCloseAndHostCleanup"] = true
        } else {
            guard terminal.inputControl?.owned == false else { throw BridgeFailure(code: "CONTROL_QA_PASSIVE", message: "The second native client stole control on connection") }
            try await wait("Read original output without owning input") { terminal.text.contains("OWNER_READY 中文") }
            terminal.enqueue(Data("printf PASSIVE > passive-viewer.txt\r".utf8))
            try await denied { try await bridge.write(attachment: terminal.attachment, bytes: Data("printf PASSIVE > passive-viewer.txt\r".utf8)) }
            window.setContentSize(NSSize(width: 1000, height: 700))
            window.makeKeyAndOrderFront(nil)
            try await Task.sleep(for: .milliseconds(300))
            try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent("native-input-viewer-readonly.png"))
            try pressTakeControl(in: window)
            try await wait("Take input through the actual native button") { terminal.inputControl?.owned == true }
            terminal.enqueue(Data("printf 'VIEWER_%s 中文\\n' READY\r".utf8))
            try await wait("Render the new owner's output") { terminal.text.contains("VIEWER_READY 中文") }
            try signal("viewer-taken")
            try await wait("Old owner completes its rejected-write checks") { exists("owner-checked") }
            try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent("native-input-viewer-owned.png"))
            report["initialReadonlyReplay"] = true
            report["passiveInputRejected"] = true
            report["explicitNativeButtonTakeover"] = true
            let retainedStatus = try await bridge.call("host.status")
            guard terminal.generation == generation, retainedStatus["pid"] == pid else {
                throw BridgeFailure(code: "CONTROL_QA_PROCESS", message: "Viewer takeover replaced the host or generation")
            }
            report["sameHostAndGeneration"] = true
            report["captures"] = ["native-input-viewer-readonly.png", "native-input-viewer-owned.png"]
        }
        report["renderedFrames"] = terminal.qaRenderedFrames
        report["acknowledgedFrames"] = terminal.qaAcknowledgedFrames
        report["passed"] = true
    }
}
