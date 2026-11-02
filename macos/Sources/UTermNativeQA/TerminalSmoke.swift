import AppKit
import Foundation
import UTermBridge

@MainActor
enum TerminalSmoke {
    static func wait(_ label: String, until condition: @escaping @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(12)
        while !condition() {
            guard Date() < deadline else { throw BridgeFailure(code: "SMOKE_TIMEOUT", message: label) }
            try await Task.sleep(for: .milliseconds(25))
        }
    }

    static func run(model: WorkspaceModel, window: NSWindow?, reconnect: Bool, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.bridge, let window else { throw BridgeFailure(code: "SMOKE_STARTUP", message: model.error) }
        if reconnect {
            guard model.state?.sessions.count == 2 else { throw BridgeFailure(code: "SMOKE_REPLAY", message: "Persisted split sessions were not restored") }
            try await wait("Reattach both retained processes") { model.terminals.count == 2 && model.terminals.values.allSatisfy { $0.generation != nil && $0.error.isEmpty } }
            try await wait("Replay retained Unicode output") { model.terminals.values.contains { $0.text.contains("UTERM_中文 é") } }
            report["replayed"] = true
            report["sessions"] = model.terminals.values.map { ["id": $0.id, "generation": $0.generation ?? ""] }
            let ids = model.state?.sessions.map(\.sessionID) ?? []
            for id in ids { await model.selectSession(id); await model.closeSession() }
            let status = try await bridge.call("host.status")
            guard !(status["sessions"].array.contains { $0["running"].bool == true }), model.state?.sessions.isEmpty == true else { throw BridgeFailure(code: "SMOKE_CLOSE", message: "Explicit close did not release both sessions") }
            report["explicitCloseStoppedProcesses"] = true
            _ = try await bridge.call("host.shutdownIdle")
            report["idleHostShutdown"] = true
            return
        }

        let project = try WorkspaceModel.dataRoot().deletingLastPathComponent()
        guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("Terminal QA"), "directory": .string(project.path), "workspaceId": .string(model.groupID)]) else {
            throw BridgeFailure(code: "SMOKE_PROJECT", message: model.error)
        }
        await model.newTerminal()
        try await wait("Create the first real PTY") { model.selectedTerminal?.generation != nil && model.selectedTerminal?.error.isEmpty == true }
        guard let first = model.selectedTerminal else { throw BridgeFailure(code: "SMOKE_SESSION", message: "No first terminal") }
        let firstID = first.id
        let firstView = ObjectIdentifier(first.view)
        first.enqueue(Data("printf '\\033[31mUTERM_%s é\\033[0m\\n' '中文'\r".utf8))
        try await wait("Parse ANSI and Unicode from the PTY") { first.text.contains("UTERM_中文 é") }
        first.enqueue(Data("printf '\\033[?1049hALT_SCREEN\\033[?1049l\\033[?2004h\\033[?1000h\\nTUI_%s\\n' READY\r".utf8))
        try await wait("Return from alternate screen") { first.text.contains("TUI_READY") }
        report["unicodeAndAnsiParsed"] = true
        report["alternateScreenReturned"] = true

        await model.split("horizontal")
        try await wait("Create a real split peer") { model.state?.sessions.count == 2 && model.selectedTerminal?.generation != nil && model.selectedTerminal?.error.isEmpty == true }
        guard let second = model.selectedTerminal, second.id != firstID else { throw BridgeFailure(code: "SMOKE_SPLIT", message: "A split peer was not created") }
        let secondView = ObjectIdentifier(second.view)
        try await wait("Display both native terminal views") { first.view.window === window && second.view.window === window && first.view.bounds.width > 0 && second.view.bounds.width > 0 }
        second.enqueue(Data("printf 'SECOND_%s\\n' READY\r".utf8))
        try await wait("Read split peer output") { second.text.contains("SECOND_READY") }
        await model.selectSession(firstID)
        guard ObjectIdentifier(first.view) == firstView, ObjectIdentifier(second.view) == secondView else { throw BridgeFailure(code: "SMOKE_VIEW", message: "Terminal views were replaced") }
        report["splitSessionCount"] = model.state?.sessions.count ?? 0
        report["visibleTerminalViews"] = model.terminals.values.filter { $0.view.window === window && $0.view.bounds.width > 0 }.count

        window.performClose(nil)
        guard !window.isVisible else { throw BridgeFailure(code: "SMOKE_HIDE", message: "Close did not hide the native window") }
        first.enqueue(Data("printf 'HIDDEN_%s\\n' READY\r".utf8))
        try await wait("Retain output while the window is hidden") { first.text.contains("HIDDEN_READY") }
        window.makeKeyAndOrderFront(nil)
        report["hideAndReopenRetainedOutput"] = window.isVisible

        var captures: [String] = []
        for language in ["en", "zh-Hans"] {
            for appearance in ["dark", "light"] {
                await model.patchSettings(["language": .string(language), "appearance": .string(appearance)])
                for width in [1100, 640] {
                    window.setContentSize(NSSize(width: width, height: 720))
                    try await Task.sleep(for: .milliseconds(150))
                    guard ObjectIdentifier(first.view) == firstView, ObjectIdentifier(second.view) == secondView else { throw BridgeFailure(code: "SMOKE_VIEW", message: "Layout changes replaced a terminal view") }
                    let name = "native-\(language)-\(appearance)-\(width).png"
                    if let reportPath = WorkspaceModel.argument("--terminal-smoke-report") {
                        let path = URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name)
                        try await capture(window: window, path: path)
                        captures.append(name)
                    }
                }
            }
        }
        model.sidebarVisible = false
        try await Task.sleep(for: .milliseconds(150))
        if let reportPath = WorkspaceModel.argument("--terminal-smoke-report") {
            let name = "native-sidebar-hidden.png"
            try await capture(window: window, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name))
            captures.append(name)
        }
        model.sidebarVisible = true
        window.toggleFullScreen(nil)
        try await wait("Enter actual full screen") { model.fullScreen }
        try await Task.sleep(for: .milliseconds(300))
        if let reportPath = WorkspaceModel.argument("--terminal-smoke-report") {
            let name = "native-fullscreen.png"
            try await capture(window: window, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name))
            captures.append(name)
        }
        window.toggleFullScreen(nil)
        try await wait("Exit actual full screen") { !model.fullScreen }
        report["fullScreenEnteredAndExited"] = true
        report["sidebarHiddenAndRestored"] = model.sidebarVisible
        report["captures"] = captures
        report["viewIdentityRetained"] = true
        guard abs(model.toolbarHeight - 40) < 1 else { throw BridgeFailure(code: "SMOKE_TOOLBAR", message: "Measured native toolbar height differs from the 40pt target") }
        report["nativeToolbarHeight"] = model.toolbarHeight
        report["sessions"] = model.terminals.values.map { ["id": $0.id, "generation": $0.generation ?? ""] }
        let status = try await bridge.call("host.status")
        guard status["sessions"].array.filter({ $0["running"].bool == true }).count == 2,
              status["executable"].string?.hasSuffix("uterm-session-host") == true else { throw BridgeFailure(code: "SMOKE_HELPER", message: "Host is not the staged standalone Rust executable") }
        report["hostExecutable"] = status["executable"].string ?? ""
        report["hostStarted"] = true
        report["runningProcessesBeforeQuit"] = 2
    }

    static func capture(window: NSWindow, path: URL) async throws {
        window.displayIfNeeded()
        let identifier = window.windowNumber
        try await Task.detached {
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-o", "-l", String(identifier), path.path]
            let diagnostics = Pipe()
            capture.standardError = diagnostics
            try capture.run()
            capture.waitUntilExit()
            let message = String(decoding: diagnostics.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            guard capture.terminationStatus == 0, FileManager.default.fileExists(atPath: path.path) else {
                throw BridgeFailure(code: "SMOKE_CAPTURE", message: "WindowServer capture failed: " + message)
            }
        }.value
    }
}
