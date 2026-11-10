import AppKit
import CryptoKit
import UTermBridge

@MainActor
enum PersonalSmoke {
    static func run(model: WorkspaceModel, window: NSWindow, openSettings: () -> NativeSettingsWindow) async {
        guard WorkspaceModel.applicationProfile.personalFixture, let store = try? WorkspaceModel.dataRoot() else { return }
        let root = store.deletingLastPathComponent()
        let phase = Bundle.main.object(forInfoDictionaryKey: "UTermPersonalQAPhase") as? String ?? "initial"
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x86_64"
        #endif
        var report: [String: Any] = ["platform": "macOS", "architecture": architecture,
            "system": ProcessInfo.processInfo.operatingSystemVersionString, "phase": phase,
            "sourceHeadSHA": Bundle.main.object(forInfoDictionaryKey: "UTermSourceHeadSHA") as? String ?? "",
            "testedMergeSHA": Bundle.main.object(forInfoDictionaryKey: "UTermSourceSHA") as? String ?? "",
            "bundleIdentifier": Bundle.main.bundleIdentifier ?? "", "productionDataAccess": false, "passed": false]
        do {
            guard model.ready, let bridge = model.bridge, WorkspaceModel.argument("--qa-data-root") == nil,
                  WorkspaceModel.argument("--smoke-report") == nil else { throw BridgeFailure(code: "PERSONAL_QA", message: "Personal startup or QA argument isolation failed: " + model.error) }
            guard let resources = Bundle.main.resourceURL else { throw BridgeFailure(code: "PERSONAL_FIXTURE", message: "Missing resources") }
            let parityBytes = try Data(contentsOf: resources.appendingPathComponent("client-ui-parity.json"))
            let parity = try JSONDecoder().decode(JSONValue.self, from: parityBytes)
            report["uiParityFixtureSHA256"] = SHA256.hash(data: parityBytes).map { String(format: "%02x", $0) }.joined()
            if phase == "initial" {
                let project = root.appendingPathComponent("project")
                try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
                guard await model.mutate("project.open", ["id": .string("personal-qa-project"), "name": .string(parity["projectName"].string ?? "UI parity project"), "directory": .string(project.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "PERSONAL_PROJECT", message: model.error) }
                if case .object(let files) = parity["files"] {
                    for (name, value) in files {
                        guard !name.contains("/"), name != ".", name != "..", let text = value.string else { throw BridgeFailure(code: "PERSONAL_FIXTURE", message: "Invalid fixture file") }
                        try Data(text.utf8).write(to: project.appendingPathComponent(name))
                    }
                }
                _ = try await bridge.call("editor.drafts.import", params: .object([:]))
                for (path, text) in [("note.txt", "Personal 中文 é\r\n"), ("second.txt", "Second 🧪\r\n")] {
                    _ = try await bridge.call("editor.drafts.putDocument", params: .object(["expectedDraftRevision": .null, "draft": .object([
                        "directory": .string(project.path), "path": .string(path), "kind": .string("text"), "text": .string(text),
                        "saved": .string("Original 中文\r\n"), "version": .string(String(repeating: "a", count: 64)), "line_ending": .string("\r\n"), "bom": .bool(false)
                    ])]))
                }
                await model.patchSettings(["fontSize": parity["fontSize"], "automaticUpdates": .bool(true)])
            } else {
                guard model.settings["fontSize"] == parity["fontSize"], model.projects.contains(where: { $0["id"].string == "personal-qa-project" }) else { throw BridgeFailure(code: "PERSONAL_RETAIN", message: "Replacing the app lost the personal profile") }
            }
            let snapshot = try await bridge.snapshot()
            let drafts = try await bridge.call("editor.drafts.read")
            let archive = try await bridge.call("rollback.export", params: .object(["expectedRevision": .string(snapshot.revision), "expectedDraftRevision": drafts["revision"]]))
            let decoded = try JSONDecoder().decode(CoreRollbackArchive.self, from: JSONEncoder().encode(archive))
            let expectedDraft = "Personal 中文 é\r\n"
            guard decoded.editor?.document.drafts.count == 2, decoded.legacyRequiresDraftChoice, !decoded.automaticRestoreAllowed,
                  decoded.editor?.document.drafts.contains(where: { Data($0.text.utf8) == Data(expectedDraft.utf8) }) == true,
                  try Data(contentsOf: root.appendingPathComponent("project/note.txt")) == Data("Original 中文\r\n".utf8) else { throw BridgeFailure(code: "PERSONAL_BACKUP", message: "Personal draft/rollback export lost exact bytes or changed the file") }
            try JSONEncoder().encode(archive).write(to: root.appendingPathComponent("personal-\(phase)-rollback.json"), options: .atomic)
            report["coherentRollbackArchiveAndTwoExactDrafts"] = true
            do {
                _ = try await bridge.call("rollback.export", params: .object(["expectedRevision": .string(String(repeating: "0", count: 64))]))
                throw BridgeFailure(code: "PERSONAL_STALE_EXPORT", message: "Stale backup request was accepted")
            } catch let failure as BridgeFailure where failure.code == "CONFLICT" { report["staleBackupRejected"] = true }
            let automatic = Bundle.main.object(forInfoDictionaryKey: "UTermUpdateMode") as? String == "automatic"
            report["updateMode"] = automatic ? "automatic" : "manual"
            if automatic {
                guard model.updates.available, model.updates.updater?.automaticallyChecksForUpdates == true,
                      model.updates.updater?.automaticallyDownloadsUpdates == true else { throw BridgeFailure(code: "PERSONAL_UPDATES", message: "Personal opt-in did not enable checks and downloads") }
                await model.patchSettings(["automaticUpdates": .bool(false)])
                guard model.updates.updater?.automaticallyChecksForUpdates == false,
                      model.updates.updater?.automaticallyDownloadsUpdates == false else { throw BridgeFailure(code: "PERSONAL_UPDATES", message: "Personal opt-out left checks or downloads enabled") }
                await model.patchSettings(["automaticUpdates": .bool(true)])
                report["automaticOptInAndOutVerified"] = true
            } else {
                guard model.updates.controller == nil, model.updates.updater == nil, !model.updates.available else { throw BridgeFailure(code: "PERSONAL_UPDATES", message: "Manual build initialized network updates") }
                report["automaticOptInCannotStartUpdater"] = true
            }
            await model.newTerminal()
            try await TerminalSmoke.wait("Personal Release helper starts a real PTY") { model.selectedTerminal?.generation != nil && model.selectedTerminal?.error.isEmpty == true && (model.selectedTerminal?.qaRenderedFrames ?? 0) > 0 }
            guard let terminal = model.selectedTerminal else { throw BridgeFailure(code: "PERSONAL_PTY", message: "Personal terminal is missing") }
            guard let marker = parity["marker"].string, !marker.isEmpty, let command = parity["command"].string else { throw BridgeFailure(code: "PERSONAL_FIXTURE", message: "Missing terminal fixture") }
            terminal.enqueue(Data((command + "\r").utf8))
            try await TerminalSmoke.wait("Personal Release renders Unicode PTY output") { terminal.text.contains(marker) && terminal.view.window === window }
            let originalID = terminal.id
            let originalView = ObjectIdentifier(terminal.view)
            let originalGeneration = terminal.generation
            await model.newTerminal()
            try await TerminalSmoke.wait("Create a second real tab") { model.selectedID != originalID && model.selectedTerminal?.generation != nil }
            guard let peerID = model.selectedID else { throw BridgeFailure(code: "PERSONAL_TABS", message: "Second tab is missing") }
            _ = await model.mutate("session.rename", ["id": .string(originalID), "name": parity["sessions"].array[0]])
            _ = await model.mutate("session.rename", ["id": .string(peerID), "name": parity["sessions"].array[1]])
            await model.selectSession(originalID)
            try await TerminalSmoke.wait("Switch back without replacing the terminal") { terminal.view.window === window && model.selectedID == originalID }
            var captures: [String] = []
            var appearances: [String: String] = [:]
            var updateStatuses: [String: String] = [:]
            if automatic, phase == "initial" {
                try await TerminalSmoke.wait("Personal automatic no-update cycle completes") { model.updates.qaEvents.contains("cycle-finished") }
            }
            for (language, appearance) in [("en", "dark"), ("zh-Hans", "light")] {
                await model.patchSettings(["language": .string(language), "appearance": .string(appearance)])
                let settings = openSettings()
                await settings.model.reload()
                try await Task.sleep(for: .milliseconds(250))
                let expected: NSAppearance.Name = appearance == "dark" ? .darkAqua : .aqua
                let actual = settings.window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua])
                guard actual == expected else { throw BridgeFailure(code: "PERSONAL_APPEARANCE", message: "Settings window did not apply the selected appearance") }
                if automatic, phase == "initial" {
                    let expectedStatus = language == "en" ? "You’re up to date." : "当前已是最新版本。"
                    guard model.updates.status == expectedStatus, model.updates.error.isEmpty else { throw BridgeFailure(code: "PERSONAL_UPDATE_LOCALE", message: "Update status did not follow the selected language") }
                    updateStatuses[language] = model.updates.status
                }
                appearances[language + "-" + appearance] = actual?.rawValue
                let name = "personal-\(phase)-settings-\(language)-\(appearance).png"
                try await TerminalSmoke.capture(window: settings.window, path: root.appendingPathComponent(name))
                captures.append(name)
                settings.window.orderOut(nil)
            }
            var workspaceScenes: [[String: Any]] = []
            model.sidebarSection = "all"
            model.sidebarQuery = ""
            model.showInspector(.files)
            for language in ["en", "zh-Hans"] {
                for appearance in ["dark", "light"] {
                    await model.patchSettings(["language": .string(language), "appearance": .string(appearance)])
                    for width in [1100, 640] {
                        window.makeKeyAndOrderFront(nil)
                        window.setContentSize(NSSize(width: width, height: 720))
                        try await Task.sleep(for: .milliseconds(200))
                        guard model.settings["fontSize"] == parity["fontSize"], model.settings["language"].string == language, model.settings["appearance"].string == appearance,
                              ObjectIdentifier(terminal.view) == originalView, terminal.generation == originalGeneration,
                              model.selectedID == originalID, terminal.view.window === window else {
                            throw BridgeFailure(code: "PERSONAL_TABS", message: "Workspace chrome replaced the selected terminal")
                        }
                        try await TerminalSmoke.wait("Fixture files remain readable across settings changes") {
                            model.inspector.error.isEmpty && !model.inspector.busy
                                && Set(model.inspector.rows.compactMap { $0["path"].string }) == Set(["note.txt", "README.md"])
                        }
                        let name = "personal-\(phase)-workspace-\(language)-\(appearance)-\(width).png"
                        try await TerminalSmoke.capture(window: window, path: root.appendingPathComponent(name))
                        captures.append(name)
                        workspaceScenes.append(["screenshot": name, "language": language, "appearance": appearance,
                            "width": Int(window.contentView?.bounds.width ?? 0), "height": Int(window.contentView?.bounds.height ?? 0),
                            "platform": "macOS", "architecture": architecture, "system": ProcessInfo.processInfo.operatingSystemVersionString, "scenario": "toolbar-sidebar-two-session-tabs-files", "filesReadable": true, "fontSize": model.settings["fontSize"].number ?? 0,
                            "projectName": model.projects.first(where: { $0["id"].string == "personal-qa-project" })?["name"].string ?? "",
                            "sourceHeadSHA": report["sourceHeadSHA"] ?? "", "testedMergeSHA": report["testedMergeSHA"] ?? ""])
                    }
                }
            }
            await model.closeSession(id: peerID)
            guard model.selectedID == originalID, terminal.generation == originalGeneration,
                  model.sessionEntries.contains(where: { $0.sessionID == originalID }),
                  !model.sessionEntries.contains(where: { $0.sessionID == peerID }) else {
                throw BridgeFailure(code: "PERSONAL_TABS", message: "Closing a background tab changed the selected session")
            }
            report["backgroundTabCloseRetainedSelectedGeneration"] = true
            report["workspaceScenes"] = workspaceScenes
            window.makeKeyAndOrderFront(nil)
            let capture = "personal-\(phase)-terminal.png"
            try await TerminalSmoke.capture(window: window, path: root.appendingPathComponent(capture))
            captures.append(capture)
            report["settingsWindowAppearances"] = appearances
            report["localizedUpdateStatuses"] = updateStatuses
            report["captures"] = captures; report["realBundledHelperUnicodePTY"] = true
            report["profileRetainedAfterAppReplacement"] = phase != "initial"
            await model.closeSession()
            let host = try await bridge.call("host.status")
            report["hostPID"] = host["pid"].number.flatMap { Int(exactly: $0) }
            guard host["sessions"].array.isEmpty else { throw BridgeFailure(code: "PERSONAL_CLOSE", message: "Personal fixture session remains alive") }
            _ = try await bridge.call("host.shutdownIdle")
            report["explicitCloseAndIdleHostShutdown"] = true
            report["passed"] = true
        } catch {
            report["failure"] = error.localizedDescription
            report["inspectorDiagnostics"] = ["error": model.inspector.error, "code": model.inspector.errorCode, "directory": model.inspector.directory, "paths": model.inspector.rows.compactMap { $0["path"].string }] as [String: Any]
        }
        await model.shutdown()
        do {
            let bytes = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            try bytes.write(to: root.appendingPathComponent("personal-\(phase).json"), options: .atomic)
        } catch { fputs("Personal QA report could not be written\n", stderr) }
    }
}
