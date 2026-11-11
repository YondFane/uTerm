import AppKit
import UTermBridge

@MainActor
enum QuickParitySmoke {
    static func run(model: WorkspaceModel, window: NSWindow, output: URL, fixture: JSONValue, phase: String, report: inout [String: Any], captures: inout [String]) async throws {
        guard let bridge = model.bridge, let terminal = model.selectedTerminal, let address = fixture["quickAddress"].string,
              let command = fixture["quickTerminalCommand"].string, let marker = fixture["marker"].string else { throw BridgeFailure(code: "QUICK_PARITY", message: "Missing shared Quick SSH fixture") }
        let original = try await bridge.snapshot()
        let generation = terminal.generation, identity = ObjectIdentifier(terminal.view), frames = terminal.qaRenderedFrames
        terminal.enqueue(Data((command + "\r").utf8))
        try await TerminalSmoke.wait("Prepare shared Quick SSH background through the actual shell") {
            terminal.qaRenderedFrames > frames && terminal.text.contains(marker) && terminal.text.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("ui-parity >")
        }
        var scenes: [[String: Any]] = []
        for scene in fixture["quickScenes"].array {
            guard let language = scene["language"].string, let appearance = scene["appearance"].string,
                  let rawWidth = scene["width"].number, let rawHeight = scene["height"].number,
                  let width = Int(exactly: rawWidth), let height = Int(exactly: rawHeight) else { throw BridgeFailure(code: "QUICK_SCENE", message: "Invalid shared Quick SSH scene") }
            await model.patchSettings(["language": .string(language), "appearance": .string(appearance)])
            _ = try await TerminalSmoke.sizeCaptureWindow(window, width: width, height: height)
            func trigger() -> NSButton? {
                window.contentView.flatMap({ TerminalSmoke.descendants($0).first {
                    $0.identifier?.rawValue == "native-ssh-quick" && $0.window === window && !$0.isHiddenOrHasHiddenAncestor && !$0.visibleRect.isEmpty
                } as? NSButton })
            }
            try await TerminalSmoke.wait("Enable the actual Quick SSH sidebar button") { trigger()?.isEnabled == true }
            guard let button = trigger() else { throw BridgeFailure(code: "QUICK_ENTRY", message: "Missing visible Quick SSH sidebar button") }
            button.performClick(nil)
            try await TerminalSmoke.wait("Open actual Quick SSH in the main workspace") { model.quickSSHContent?.webView.window === window }
            guard let quick = model.quickSSHContent, quick.presentationWindow === window, quick.window?.isVisible == false else { throw BridgeFailure(code: "QUICK_EMBEDDED", message: "Quick SSH opened outside the main window") }
            try await ContentSmoke.wait(quick, "document.querySelector('.ssh-quick-dialog[open] input')!==null")
            try await QuickSSHSmoke.address(quick, address)
            _ = try await quick.webView.evaluateJavaScript("document.querySelector('.ssh-quick-dialog form').requestSubmit()")
            try await ContentSmoke.wait(quick, "document.querySelector('.ssh-quick-dialog [role=alert]')!==null && !document.querySelector('.ssh-quick-dialog input').disabled", allowAlert: true)
            let quoted = String(data: try JSONEncoder().encode(address), encoding: .utf8)!
            try await ContentSmoke.wait(quick, "document.querySelector('.ssh-quick-dialog input').value===" + quoted + " && document.documentElement.lang==='" + language + "'", allowAlert: true)
            guard (try await bridge.snapshot()).document.workspace == original.document.workspace, terminal.generation == generation,
                  ObjectIdentifier(terminal.view) == identity else { throw BridgeFailure(code: "QUICK_FIXTURE", message: "Invalid Quick SSH changed the workspace or terminal generation") }
            let geometry = try await QuickSSHSmoke.modalGeometry(quick, window: window)
            guard terminal.view.window === window, !terminal.view.isHiddenOrHasHiddenAncestor, !terminal.view.visibleRect.isEmpty else { throw BridgeFailure(code: "QUICK_BACKDROP", message: "Quick SSH hid the live terminal behind its form") }
            let name = "personal-\(phase)-quick-ssh-invalid-\(language)-\(appearance)-\(width).png"
            try await TerminalSmoke.capture(window: window, path: output.appendingPathComponent(name))
            captures.append(name); report["captures"] = captures
            var row: [String: Any] = ["language": language, "appearance": appearance, "width": width, "height": height, "screenshot": name,
                "sourceHeadSHA": report["sourceHeadSHA"] ?? "", "testedMergeSHA": report["testedMergeSHA"] ?? "", "platform": "macOS",
                "architecture": report["architecture"] ?? "", "system": report["system"] ?? "", "scenario": "quick-ssh-invalid", "inputAddress": address,
                "terminalFixtureMarker": marker, "invalidInputRejected": true, "addressRetained": true, "savedWorkspaceUnchanged": true,
                "sameMainWindow": true, "terminalGenerationRetained": true, "actualSidebarButton": true]
            for (key, value) in geometry { row[key] = value }
            row["workspaceVisibleAroundDialog"] = true
            let cancel = language == "en" ? "Cancel" : "取消"
            try await EditorSmoke.click(quick, title: cancel)
            try await TerminalSmoke.wait("Cancel shared Quick SSH without closing the workspace") { model.quickSSHContent == nil && window.isVisible && terminal.view.window === window }
            guard (try await bridge.snapshot()).document.workspace == original.document.workspace, terminal.generation == generation else { throw BridgeFailure(code: "QUICK_CANCEL", message: "Quick SSH cancellation changed shared data") }
            row["actualCancelPreservedState"] = true
            scenes.append(row); report["quickSSHScenes"] = scenes
        }
    }
}
