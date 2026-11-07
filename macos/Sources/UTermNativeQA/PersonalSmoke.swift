import AppKit
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
            if phase == "initial" {
                let project = root.appendingPathComponent("project")
                try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
                guard await model.mutate("project.open", ["id": .string("personal-qa-project"), "name": .string("Personal release QA"), "directory": .string(project.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "PERSONAL_PROJECT", message: model.error) }
                try Data("Original 中文\r\n".utf8).write(to: project.appendingPathComponent("note.txt"))
                _ = try await bridge.call("editor.drafts.import", params: .object([:]))
                for (path, text) in [("note.txt", "Personal 中文 é\r\n"), ("second.txt", "Second 🧪\r\n")] {
                    _ = try await bridge.call("editor.drafts.putDocument", params: .object(["expectedDraftRevision": .null, "draft": .object([
                        "directory": .string(project.path), "path": .string(path), "kind": .string("text"), "text": .string(text),
                        "saved": .string("Original 中文\r\n"), "version": .string(String(repeating: "a", count: 64)), "line_ending": .string("\r\n"), "bom": .bool(false)
                    ])]))
                }
                await model.patchSettings(["fontSize": .number(17), "automaticUpdates": .bool(true)])
            } else {
                guard model.settings["fontSize"].number == 17, model.projects.contains(where: { $0["id"].string == "personal-qa-project" }) else { throw BridgeFailure(code: "PERSONAL_RETAIN", message: "Replacing the app lost the personal profile") }
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
            guard model.updates.controller == nil, model.updates.updater == nil, !model.updates.available else { throw BridgeFailure(code: "PERSONAL_UPDATES", message: "Personal build initialized network updates") }
            report["automaticOptInCannotStartUpdater"] = true
            await model.newTerminal()
            try await TerminalSmoke.wait("Personal Release helper starts a real PTY") { model.selectedTerminal?.generation != nil && model.selectedTerminal?.error.isEmpty == true && (model.selectedTerminal?.qaRenderedFrames ?? 0) > 0 }
            guard let terminal = model.selectedTerminal else { throw BridgeFailure(code: "PERSONAL_PTY", message: "Personal terminal is missing") }
            terminal.enqueue(Data("printf 'PERSONAL_%s 中文\\n' READY\r".utf8))
            try await TerminalSmoke.wait("Personal Release renders Unicode PTY output") { terminal.text.contains("PERSONAL_READY 中文") && terminal.view.window === window }
            var captures: [String] = []
            var appearances: [String: String] = [:]
            for (language, appearance) in [("en", "dark"), ("zh-Hans", "light")] {
                await model.patchSettings(["language": .string(language), "appearance": .string(appearance)])
                let settings = openSettings()
                await settings.model.reload()
                try await Task.sleep(for: .milliseconds(250))
                let expected: NSAppearance.Name = appearance == "dark" ? .darkAqua : .aqua
                let actual = settings.window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua])
                guard actual == expected else { throw BridgeFailure(code: "PERSONAL_APPEARANCE", message: "Settings window did not apply the selected appearance") }
                appearances[language + "-" + appearance] = actual?.rawValue
                let name = "personal-\(phase)-settings-\(language)-\(appearance).png"
                try await TerminalSmoke.capture(window: settings.window, path: root.appendingPathComponent(name))
                captures.append(name)
                settings.window.orderOut(nil)
            }
            window.makeKeyAndOrderFront(nil)
            let capture = "personal-\(phase)-terminal.png"
            try await TerminalSmoke.capture(window: window, path: root.appendingPathComponent(capture))
            captures.append(capture)
            report["settingsWindowAppearances"] = appearances
            report["captures"] = captures; report["realBundledHelperUnicodePTY"] = true
            report["profileRetainedAfterAppReplacement"] = phase != "initial"
            await model.closeSession()
            let host = try await bridge.call("host.status")
            report["hostPID"] = host["pid"].number.flatMap { Int(exactly: $0) }
            guard host["sessions"].array.isEmpty else { throw BridgeFailure(code: "PERSONAL_CLOSE", message: "Personal fixture session remains alive") }
            _ = try await bridge.call("host.shutdownIdle")
            report["explicitCloseAndIdleHostShutdown"] = true
            report["passed"] = true
        } catch { report["failure"] = error.localizedDescription }
        await model.shutdown()
        do {
            let bytes = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            try bytes.write(to: root.appendingPathComponent("personal-\(phase).json"), options: .atomic)
        } catch { fputs("Personal QA report could not be written\n", stderr) }
    }
}
