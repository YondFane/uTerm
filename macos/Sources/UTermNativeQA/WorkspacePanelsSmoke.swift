import AppKit
import UTermBridge

@MainActor
enum WorkspacePanelsSmoke {
    static func run(model: WorkspaceModel, window: NSWindow, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.bridge, let reportPath = WorkspaceModel.argument("--panels-smoke-report"), WorkspaceModel.argument("--qa-data-root") != nil else { throw BridgeFailure(code: "PANELS_FIXTURE", message: "Missing isolated workspace-panel QA context") }
        let evidence = URL(fileURLWithPath: reportPath).deletingLastPathComponent()
        let root = try WorkspaceModel.dataRoot().deletingLastPathComponent().appendingPathComponent("workspace-panels 中文")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("print('workspace panel')\n".utf8).write(to: root.appendingPathComponent("main.py"))
        try Data("<project><modelVersion>4.0.0</modelVersion><groupId>qa</groupId><artifactId>native-panels</artifactId><version>1</version></project>\n".utf8).write(to: root.appendingPathComponent("pom.xml"))
        try Data("# Workspace fixture\n".utf8).write(to: root.appendingPathComponent("README.md"))
        func git(_ args: [String]) throws {
            let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["-C", root.path] + args; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            try process.run(); process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw BridgeFailure(code: "PANELS_GIT", message: "Could not prepare isolated repository") }
        }
        try git(["init", "--initial-branch=main"]); try git(["add", "--all"])
        try git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--no-gpg-sign", "-m", "Workspace fixture"])
        guard await model.mutate("project.open", ["id": .string("panels-qa"), "name": .string("Workspace panels 中文"), "directory": .string(root.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "PANELS_PROJECT", message: model.error) }
        await model.newTerminal()
        try await TerminalSmoke.wait("Workspace panel fixture starts a real hosted terminal") { model.selectedTerminal?.generation != nil }
        let session = model.selectedID, generation = model.selectedTerminal?.generation
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        window.setContentSize(NSSize(width: 1100, height: 720)); window.makeKeyAndOrderFront(nil)
        var captures: [String] = []
        var scenes: [[String: Any]] = []
        let source = report["sourceHeadSHA"] as? String ?? "", tested = report["sourceSHA"] as? String ?? ""
        let architecture = report["architecture"] as? String ?? "", system = report["system"] as? String ?? ""
        func capture(_ name: String) async throws {
            try await Task.sleep(for: .milliseconds(200))
            try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent(name)); captures.append(name)
        }
        func captureWidths(_ kind: String) async throws {
            for (language, appearance, width) in [("en", "dark", 1100), ("zh-Hans", "light", 640)] {
                await model.patchSettings(["language": .string(language), "appearance": .string(appearance)])
                window.setContentSize(NSSize(width: CGFloat(width), height: 720))
                try await TerminalSmoke.wait("Actual panel window reaches requested width") { abs((window.contentView?.bounds.width ?? 0) - CGFloat(width)) < 1 }
                let screenshot = "native-workspace-panel-" + kind + "-" + language + "-" + appearance + "-" + String(width) + ".png"
                try await capture(screenshot)
                scenes.append(["scenario": kind, "language": language, "appearance": appearance, "width": width, "height": 720, "screenshot": screenshot,
                    "sourceHeadSHA": source, "testedMergeSHA": tested, "platform": "macOS", "architecture": architecture, "system": system])
            }
            await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
            window.setContentSize(NSSize(width: 1100, height: 720))
        }
        func button(_ id: String) -> NSButton? {
            guard let root = window.contentView else { return nil }
            return TerminalSmoke.descendants(root).first { $0.identifier?.rawValue == id } as? NSButton
        }
        let openers: [(String, (() -> Void)?)] = [("java", model.openJavaRequested), ("python", model.openPythonRequested), ("ssh", { model.openSSHRequested?(nil) })]
        for (kind, open) in openers {
            open?()
            try await TerminalSmoke.wait("Native panel is mounted in the actual main window") {
                guard let panel = model.panels.active(in: model.inspectorContextKey) else { return false }
                return panel.id.hasPrefix(kind + "-") && panel.view.window === window && panel.controller.window?.isVisible == false
            }
            guard let panel = model.panels.active(in: model.inspectorContextKey) else { throw BridgeFailure(code: "PANELS_VIEW", message: "Missing mounted native panel") }
            let view = panel.view
            if panel.runKind != nil {
                report[kind + "DockedRunPanel"] = try await RunPanelSmoke.run(model: model, panel: panel, window: window, prefix: "native-workspace-" + kind, evidence: evidence)
                guard let openFile = model.openInspectorFile else { throw BridgeFailure(code: "PANELS_DOCUMENT", message: "Missing actual file entry point") }
                try await openFile(root.path, "README.md", 0)
                try await TerminalSmoke.wait("A real file and the run panel share the main workspace") {
                    model.documents.active(in: model.inspectorContextKey)?.content.webView.window === window && model.panels.active(in: model.inspectorContextKey)?.id == panel.id && view.window === window
                }
                guard let document = model.documents.active(in: model.inspectorContextKey) else { throw BridgeFailure(code: "PANELS_DOCUMENT", message: "Missing mounted file") }
                try await capture("native-workspace-" + kind + "-dock-with-file.png")
                guard let closeFile = button("native-file-close-" + document.id.uuidString) else { throw BridgeFailure(code: "PANELS_DOCUMENT", message: "Missing actual file close control") }
                closeFile.performClick(nil)
                try await TerminalSmoke.wait("Closing the clean file retains the docked run panel") {
                    model.documents.active(in: model.inspectorContextKey) == nil && model.panels.active(in: model.inspectorContextKey)?.id == panel.id && view.window === window
                }
                report[kind + "DockedFileRetained"] = true
            }
            try await captureWidths(kind)
            guard let terminalTab = button("native-workspace-terminal-tab") else { throw BridgeFailure(code: "PANELS_TAB", message: "Missing terminal tab") }
            terminalTab.performClick(nil)
            try await TerminalSmoke.wait("Terminal tab hides the panel without closing its controller") { model.panels.active(in: model.inspectorContextKey) == nil && model.panels.panels.contains { $0.id == panel.id } }
            guard let tab = button("native-panel-select-" + panel.id) else { throw BridgeFailure(code: "PANELS_TAB", message: "Missing native panel tab") }
            tab.performClick(nil)
            try await TerminalSmoke.wait("Native panel tab restores the same retained view") { model.panels.active(in: model.inspectorContextKey)?.view === view && view.window === window }
            guard model.selectedID == session, model.selectedTerminal?.generation == generation else { throw BridgeFailure(code: "PANELS_PTY", message: "Panel switching changed the terminal identity") }
            if panel.runKind != nil {
                let proof = try await RunPanelHideSmoke.run(model: model, panel: panel, window: window, evidence: evidence)
                report[kind + "HideConfiguration"] = proof
                if let image = proof["screenshot"] as? String { captures.append(image) }
            } else {
                guard let close = button("native-panel-close-" + panel.id) else { throw BridgeFailure(code: "PANELS_CLOSE", message: "Missing native panel close control") }
                close.performClick(nil)
            }
            try await TerminalSmoke.wait("Actual close button routes through the native panel close guard") { !model.panels.panels.contains { $0.id == panel.id } }
            report[kind + "WorkspacePanelProof"] = ["actualMainWindow": true, "retainedViewAfterTabSwitch": true, "terminalGenerationRetained": true, "actualCloseButton": true]
        }
        model.openJavaRequested?()
        try await TerminalSmoke.wait("Mount Java before switching directly between retained native panels") { model.panels.active(in: model.inspectorContextKey)?.id.hasPrefix("java-") == true }
        guard let retainedJava = model.panels.active(in: model.inspectorContextKey) else { throw BridgeFailure(code: "PANELS_SWITCH", message: "Java panel is missing") }
        model.openPythonRequested?()
        try await TerminalSmoke.wait("Replace mounted Java with the actual Python view") { model.panels.active(in: model.inspectorContextKey)?.id.hasPrefix("python-") == true && model.panels.active(in: model.inspectorContextKey)?.view.window === window && retainedJava.view.window !== window }
        guard let retainedPython = model.panels.active(in: model.inspectorContextKey) else { throw BridgeFailure(code: "PANELS_SWITCH", message: "Python panel is missing") }
        model.panels.select(retainedJava.id, scope: model.inspectorContextKey)
        try await TerminalSmoke.wait("Direct tab selection remounts the exact retained Java view") { retainedJava.view.window === window && retainedPython.view.window !== window }
        model.panels.close(retainedJava.id); model.panels.close(retainedPython.id)
        try await TerminalSmoke.wait("Close both directly switched native panels") { !model.panels.panels.contains { $0.id == retainedJava.id || $0.id == retainedPython.id } }
        report["directNativePanelSwitchRetainsAndRemountsExactViews"] = true
        for kind in ["database", "redis"] {
            let id = UUID().uuidString
            var config: [String: JSONValue] = ["id": .string(id), "name": .string(kind + " offline QA"), "host": .string("127.0.0.1"), "port": .number(kind == "database" ? 5432 : 6379), "username": .string("qa"), "tls": .bool(false), "ca_file": .string(""), "credential_id": .null]
            if kind == "database" { config["kind"] = .string("postgresql"); config["database"] = .string("qa") }
            else { config["db"] = .number(0); config["server_name"] = .string(""); config["ssh_host"] = .string("") }
            guard await model.mutate(kind + ".profile.save", ["workspaceId": .string(model.groupID), "config": .object(config)]) else { throw BridgeFailure(code: "PANELS_PROFILE", message: model.error) }
            if kind == "database" { model.openDatabaseProfileRequested?(model.groupID, id) } else { model.openRedisProfileRequested?(model.groupID, id) }
            try await TerminalSmoke.wait("Connection document is embedded in the main workspace") { model.documents.active(in: model.inspectorContextKey)?.content.workbenchHost?.kind == kind && model.documents.active(in: model.inspectorContextKey)?.content.webView.window === window }
            guard let document = model.documents.active(in: model.inspectorContextKey) else { throw BridgeFailure(code: "PANELS_DOCUMENT", message: "Missing workbench document") }
            try await ContentSmoke.wait(document.content, "document.querySelector('.native-database-profile-name[aria-pressed=true]')?.textContent === '" + kind + " offline QA'")
            try await captureWidths(kind)
            guard let close = button("native-file-close-" + document.id.uuidString) else { throw BridgeFailure(code: "PANELS_CLOSE", message: "Missing workbench tab close control") }
            close.performClick(nil)
            try await TerminalSmoke.wait("Workbench tab closes while its client remains retained") { !model.documents.documents.contains { $0.id == document.id } }
            if kind == "database" { model.openDatabaseProfileRequested?(model.groupID, id) } else { model.openRedisProfileRequested?(model.groupID, id) }
            try await TerminalSmoke.wait("Reopening the workbench retains the exact WebKit document") { model.documents.active(in: model.inspectorContextKey)?.content === document.content && document.content.webView.window === window }
            model.documents.close(document.id)
            report[kind + "WorkspacePanelProof"] = ["actualMainWindow": true, "initialSelectionDelivered": true, "retainedDocumentAfterReopen": true, "actualCloseButton": true, "service": "offline profiles; no authentication or server claim"]
        }
        model.showInspector(.git)
        try await TerminalSmoke.wait("Git is mounted in the tools column") { model.inspector.content?.gitMode == true && model.inspector.content?.webView.window === window }
        guard let gitContent = model.inspector.content else { throw BridgeFailure(code: "PANELS_GIT", message: "Missing Git inspector") }
        try await ContentSmoke.wait(gitContent, "document.querySelector('.inspector-switcher button[aria-label=Git][aria-pressed=true]') !== null")
        try await captureWidths("git")
        model.showInspector(.files)
        try await TerminalSmoke.wait("Files returns to the tools column") { model.inspector.content?.workbenchHost?.kind == "files" && model.inspector.content?.webView.window === window }
        model.showInspector(.git)
        try await TerminalSmoke.wait("Git returns with the same retained document") { model.inspector.content === gitContent && gitContent.webView.window === window }
        report["gitWorkspacePanelProof"] = ["actualMainWindow": true, "toolsSwitcher": true, "retainedDocumentAfterModeSwitch": true]
        guard model.selectedID == session, model.selectedTerminal?.generation == generation else { throw BridgeFailure(code: "PANELS_PTY", message: "Workbench operations changed terminal identity") }
        report["captures"] = captures; report["scenes"] = scenes
        report["scenario"] = "Real AppKit controls and mounted views; isolated Git repository, offline connection profiles, no external services. Service failure/lifetime checks run in their existing suites."
        try await ProjectMenuSmoke.run(model: model, window: window, projectID: "panels-qa", prefix: "native", evidence: evidence, report: &report)
        for entry in model.sessionEntries { await model.closeSession(id: entry.sessionID) }
        _ = try await bridge.call("host.shutdownIdle")
        report["cleanup"] = true
    }
}
