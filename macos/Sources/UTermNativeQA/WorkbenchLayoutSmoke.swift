import AppKit
import UTermBridge

@MainActor
enum WorkbenchLayoutSmoke {
    private static func identity(_ report: [String: Any], row: inout [String: Any]) {
        for key in ["sourceHeadSHA", "platform", "architecture", "system"] { row[key] = report[key] }
        row["testedMergeSHA"] = report["sourceSHA"]
    }
    static func ssh(model: WorkspaceModel, window: NSWindow, language: String, appearance: String, width: Int, report: inout [String: Any]) async throws {
        guard let panel = model.panels.active(in: model.inspectorContextKey), let ssh = (panel.controller as? SSHWindow)?.model, let bridge = model.bridge else { throw BridgeFailure(code: "SSH_LAYOUT", message: "Missing actual embedded SSH panel") }
        try await TerminalSmoke.wait("Load the retained SSH draft before layout checks") { !ssh.busy && ssh.snapshot != nil }
        let fingerprint = ssh.fingerprint, before = try await bridge.snapshot()
        func view(_ id: String) -> NSView? { TerminalSmoke.descendants(panel.view).first { $0.identifier?.rawValue == id } }
        func measured() -> [[String: Any]] {
            ["native-ssh-profile-fields-frame", "native-ssh-save-frame"].compactMap { id in
                guard let actual = view(id), actual.window === window else { return nil }
                let bounds = actual.convert(actual.bounds, to: panel.view)
                return ["id": id, "left": Double(bounds.minX), "width": Double(bounds.width), "height": Double(bounds.height)]
            }
        }
        try await TerminalSmoke.wait("Keep actual SSH fields and Save inside the resized workspace") {
            let rows = measured()
            return rows.count == 2 && rows.allSatisfy { row in
                guard let left = row["left"] as? Double, let width = row["width"] as? Double, let height = row["height"] as? Double else { return false }
                return left >= 0 && width > 0 && height > 0 && left + width <= panel.view.bounds.width + 0.5
            }
        }
        let narrow = panel.view.bounds.width < 720
        if narrow {
            guard let toggle = view("native-ssh-connections-toggle") as? NSButton, toggle.isEnabled else { throw BridgeFailure(code: "SSH_LAYOUT", message: "Missing narrow SSH connections control") }
            toggle.performClick(nil)
            try await TerminalSmoke.wait("Expand the actual narrow SSH connection list") { view("native-ssh-connections-list-frame")?.window === window }
            toggle.performClick(nil)
            try await TerminalSmoke.wait("Collapse the actual narrow SSH connection list") { view("native-ssh-connections-list-frame") == nil }
        }
        let after = try await bridge.snapshot()
        guard ssh.fingerprint == fingerprint, before.revision == after.revision, before.document.workspace == after.document.workspace, before.document.settings == after.document.settings else { throw BridgeFailure(code: "SSH_LAYOUT", message: "SSH layout actions changed the draft or saved data") }
        var row: [String: Any] = ["kind": "ssh", "language": language, "appearance": appearance, "width": width, "height": 720,
            "viewportWidth": Double(panel.view.bounds.width), "narrow": narrow, "passed": true, "actualConnectionsToggle": narrow,
            "draftAndSavedDataRetained": true, "fieldFrames": measured()]
        identity(report, row: &row)
        var rows = report["sshWorkspaceLayoutProof"] as? [[String: Any]] ?? []; rows.append(row); report["sshWorkspaceLayoutProof"] = rows
    }
    static func connections(model: WorkspaceModel, window: NSWindow, kind: String, language: String, appearance: String, width: Int,
                            evidence: URL, report: inout [String: Any], captures: inout [String]) async throws {
        guard let document = model.documents.active(in: model.inspectorContextKey), document.content.workbenchHost?.kind == kind,
              document.content.webView.window === window, let bridge = model.bridge else { throw BridgeFailure(code: "WORKBENCH_LAYOUT", message: "Missing actual connection workbench") }
        let content = document.content, before = try await bridge.snapshot()
        let compact = "document.querySelector('.native-database')?.dataset.connectionsVisible === 'false' && document.querySelector('.native-database-workbench')?.getBoundingClientRect().width >= document.documentElement.clientWidth - 1"
        try await ContentSmoke.wait(content, compact)
        _ = try await content.webView.evaluateJavaScript("window.__qaRetainedWorkbench=document.querySelector('.native-database-workbench');window.__qaSelectedWorkbenchProfile=document.querySelector('.native-database-profile[data-selected]')?.dataset.profileId")
        _ = try await content.webView.evaluateJavaScript("document.querySelector('.native-workbench-connections').click()")
        try await ContentSmoke.wait(content, "document.querySelector('.native-database')?.dataset.connectionsVisible === 'true' && document.querySelector('.native-workbench-back')?.getBoundingClientRect().height > 0")
        try await ContentSmoke.wait(content, "(() => { const width=document.documentElement.clientWidth, aside=document.querySelector('.native-database-layout > aside').getBoundingClientRect(); return width < 720 ? Math.abs(aside.width-width)<1 && getComputedStyle(window.__qaRetainedWorkbench).display==='none' : aside.width>0 && aside.right<=width; })()")
        guard let dimensions = try await content.webView.evaluateJavaScript("({viewportWidth: document.documentElement.clientWidth, connectionsWidth:document.querySelector('.native-database-layout > aside').getBoundingClientRect().width})") as? [String: Any] else { throw BridgeFailure(code: "WORKBENCH_LAYOUT", message: "Could not measure actual connection controls") }
        let name = "native-workspace-panel-\(kind)-connections-\(language)-\(appearance)-\(width).png"
        try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent(name)); captures.append(name)
        _ = try await content.webView.evaluateJavaScript("document.querySelector('.native-workbench-back').click()")
        try await ContentSmoke.wait(content, compact)
        _ = try await content.webView.evaluateJavaScript("document.querySelector('.native-workbench-connections').click()")
        try await ContentSmoke.wait(content, "document.querySelector('.native-database')?.dataset.connectionsVisible === 'true'")
        _ = try await content.webView.evaluateJavaScript("document.querySelector('.native-database-profile[data-selected] .native-database-profile-name').click()")
        try await ContentSmoke.wait(content, compact + " && document.querySelector('.native-database-workbench')===window.__qaRetainedWorkbench && document.querySelector('.native-database-profile[data-selected]')?.dataset.profileId===window.__qaSelectedWorkbenchProfile")
        let after = try await bridge.snapshot()
        guard before.revision == after.revision, before.document.workspace == after.document.workspace, before.document.settings == after.document.settings,
              model.documents.active(in: model.inspectorContextKey)?.content === content else { throw BridgeFailure(code: "WORKBENCH_LAYOUT", message: "Connection presentation changed saved data or replaced the document") }
        var row: [String: Any] = ["kind": kind, "language": language, "appearance": appearance, "width": width, "height": 720,
            "passed": true, "actualConnectionsButton": true, "actualReturnButton": true, "actualProfileSelection": true,
            "sameWorkbenchDOMAndProfile": true, "savedDataRetained": true, "fullWidthWorkbench": true, "profileModeFitsViewport": true, "screenshot": name]
        row.merge(dimensions) { _, value in value }; identity(report, row: &row)
        var rows = report["connectionWorkspaceLayoutProof"] as? [[String: Any]] ?? []; rows.append(row); report["connectionWorkspaceLayoutProof"] = rows
    }
}
