import AppKit
import CoreGraphics
import WebKit
import UTermBridge

@MainActor
enum GitSmoke {
    static func run(model: WorkspaceModel, parent: NSWindow, open: (URL) async throws -> ContentWindow,
                    openFile: (URL, String) async throws -> ContentWindow, report: inout [String: Any]) async throws {
        guard let bridge = model.bridge, model.ready, let reportPath = WorkspaceModel.argument("--git-smoke-report") else {
            throw BridgeFailure(code: "GIT_START", message: "Missing isolated Git QA context")
        }
        let temporary = try WorkspaceModel.dataRoot().deletingLastPathComponent()
        let root = temporary.appendingPathComponent("git-project ")
        let sibling = temporary.appendingPathComponent("git-project")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
        let sentinel = sibling.appendingPathComponent("keep.txt")
        let sentinelBytes = Data("UNSELECTED_SIBLING".utf8)
        try sentinelBytes.write(to: sentinel)
        func git(_ arguments: [String]) throws -> String {
            let process = Process(), pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["-c", "core.hooksPath=" + temporary.appendingPathComponent("no-hooks").path, "-C", root.path] + arguments
            process.standardOutput = pipe; process.standardError = pipe
            try process.run()
            let bytes = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw BridgeFailure(code: "GIT_FIXTURE", message: String(decoding: bytes, as: UTF8.self)) }
            return String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .newlines)
        }
        try git(["init", "--initial-branch=main"])
        let path = "中文.txt", file = root.appendingPathComponent("中文.txt")
        try Data("BEFORE 中文 e\u{301}\n".utf8).write(to: file)
        try git(["add", "--all"])
        try git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--no-gpg-sign", "-m", "Isolated native Git fixture 中文"])
        try git(["branch", "topic"])
        let head = try git(["rev-parse", "HEAD"])
        try Data("DIFF_NATIVE 中文 e\u{301}\n".utf8).write(to: file)
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        let snapshot = try await bridge.snapshot()
        let selected = try await bridge.call("project.open", params: .object([
            "expectedRevision": .string(snapshot.revision), "id": .string("native-git-qa"), "name": .string("Git QA 中文"),
            "directory": .string(root.path), "workspaceId": .string(model.groupID)
        ]))
        let context = try await bridge.projectContext(expectedRevision: selected["revision"].string!)
        guard context.directory.map({ Data($0.utf8) }) == Data(root.path.utf8) else { throw BridgeFailure(code: "GIT_CONTEXT", message: "Selected project lost literal directory bytes") }
        await model.reload()
        let favoriteSource = "[\r\n \"refs/heads/to\\u0070ic\"\r\n]"
        _ = try await bridge.call("git.favorites.import", params: .object(["directory": .string(root.path), "legacy": .string(favoriteSource)]))
        await model.branchPicker.refresh()
        guard let branchContext = model.branchPicker.context, model.branchPicker.current == "main" else { throw BridgeFailure(code: "GIT_TOOLBAR", message: "Toolbar did not read the selected repository") }
        await model.branchPicker.execute("git.switchBranch", arguments: ["branch": .string("topic")], captured: branchContext, expected: .string("main"))
        guard try git(["branch", "--show-current"]) == "topic", model.branchPicker.current == "topic", let topicContext = model.branchPicker.context else { throw BridgeFailure(code: "GIT_TOOLBAR", message: "Toolbar branch switch failed") }
        try await TerminalSmoke.wait("Branch picker is ready after snapshot events") { model.branchPicker.enabled && model.branchPicker.context == topicContext }
        let staleSucceeded = await model.branchPicker.execute("git.switchBranch", arguments: ["branch": .string("main")], captured: topicContext, expected: .string("main"))
        guard !staleSucceeded, try git(["branch", "--show-current"]) == "topic", !model.branchPicker.error.isEmpty else { throw BridgeFailure(code: "GIT_TOOLBAR_STALE", message: "Stale branch action was not rejected") }
        let failureMessage = model.branchPicker.error
        await model.branchPicker.refresh(); await model.reload()
        guard model.branchPicker.error == failureMessage, model.error == failureMessage else { throw BridgeFailure(code: "GIT_ERROR_RETENTION", message: "Read-only refresh erased an operation failure") }
        model.error = ""
        await model.branchPicker.execute("git.switchBranch", arguments: ["branch": .string("main")], captured: topicContext, expected: .string("topic"))
        guard try git(["branch", "--show-current"]) == "main" else { throw BridgeFailure(code: "GIT_TOOLBAR", message: "Toolbar branch restore failed") }
        var toolbarWindow: NSWindow?
        try await TerminalSmoke.wait("Actual toolbar branch control reflects selected branch") {
            for window in NSApp.windows {
                guard let root = window.contentView, let button = TerminalSmoke.descendants(root).first(where: { $0.identifier?.rawValue == "native-branch-picker" }) as? NSButton else { continue }
                if button.isEnabled && button.title.contains("main") { toolbarWindow = window; return true }
            }
            return false
        }
        if let toolbarWindow { try await TerminalSmoke.capture(window: toolbarWindow, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent("native-toolbar-branch-picker-en-dark.png")) }
        report["gitToolbarProof"] = ["read": true, "switch": true, "staleExpectedRejected": true, "errorRetainedAfterReadRefresh": true, "restored": true, "realAppKitControl": true, "input": "model operation through guarded App callback; popup pointer/keyboard interaction not executed", "capture": "native-toolbar-branch-picker-en-dark.png"]
        let content = try await open(root)
        defer { content.forceClose() }
        var captures: [String] = []
        func capture(_ window: ContentWindow, _ name: String) async throws {
            guard let native = window.window else { throw BridgeFailure(code: "GIT_WINDOW", message: "Missing native Git window") }
            try await TerminalSmoke.capture(window: native, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(name))
        }
        do {
            try await ContentSmoke.wait(content, "document.querySelector('.git-file')?.textContent.includes('中文.txt') === true && document.querySelector('[data-node=\"refs/heads/main\"]') !== null")
            _ = try await content.webView.evaluateJavaScript("document.querySelector('.git-file').click()")
            try await ContentSmoke.wait(content, "document.querySelector('.git-diff')?.textContent.includes('DIFF_NATIVE') === true")
            try await ContentSmoke.wait(content, "[...document.querySelectorAll('.git-diff-actions button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1})")
            report["wideDiffControlsWithinWindow"] = true
            captures.append("native-git-diff-en-dark.png")
            try await capture(content, captures.last!)
            try await EditorSmoke.click(content, title: "Copy diff")
            try await TerminalSmoke.wait("Copy real native Git diff through NSPasteboard") { NSPasteboard.general.string(forType: .string)?.contains("DIFF_NATIVE 中文 e\u{301}") == true }
            report["copiedDiffThroughNativePasteboard"] = true
            report["wrongRootRejected"] = try await ContentSmoke.request(content, method: "git_snapshot", params: ["directory": sibling.path]) == "ROOT_DENIED"
            report["oldDocumentRejected"] = try await ContentSmoke.request(content, method: "git_snapshot", params: ["directory": root.path], wrongDocument: true) == "DOCUMENT_DENIED"
            try await EditorSmoke.click(content, title: "History")
            try await ContentSmoke.wait(content, "document.querySelector('.git-commit') !== null")
            _ = try await content.webView.evaluateJavaScript("document.querySelector('.git-commit').click()")
            try await ContentSmoke.wait(content, "document.querySelector('.git-commit-message')?.textContent.includes('Isolated native Git fixture') === true")
            captures.append("native-git-history-en-dark.png")
            try await capture(content, captures.last!)
            report["realDiffAndHistory"] = true
            _ = try await content.webView.evaluateJavaScript("document.querySelector('[data-node=\"refs/heads/main\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:160}))")
            try await ContentSmoke.wait(content, "[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent==='Favorite branch' && !b.disabled)")
            try await EditorSmoke.click(content, title: "Favorite branch")
            try await ContentSmoke.wait(content, "document.querySelector('[data-node=\"refs/heads/main\"]')?.textContent.includes('★') === true")
            let favorites = try await bridge.call("git.favorites.read", params: .object(["directory": .string(root.path)]))
            guard Set(favorites["references"].array.compactMap { $0.string }) == Set(["refs/heads/main", "refs/heads/topic"]) else { throw BridgeFailure(code: "GIT_FAVORITES", message: "Native favorite menu did not persist the shared references") }
            report["nativeFavoritesUsedSharedCore"] = true
            report["favoriteRootDenied"] = try await ContentSmoke.request(content, method: "git_favorites_read", params: ["directory": sibling.path]) == "ROOT_DENIED"
            report["favoriteContentImportDenied"] = try await ContentSmoke.request(content, method: "git_favorites_import", params: ["directory": root.path, "legacy": "[]"]) == "METHOD_DENIED"
            report["contentCannotReadGlobalFavoriteRecovery"] = try await ContentSmoke.request(content, method: "git.favorites.recovery.list", params: [:]) == "METHOD_DENIED"
            guard let favoriteDocument = try await content.webView.evaluateJavaScript("window.utermContentDocument") as? String else { throw BridgeFailure(code: "GIT_FAVORITES", message: "Missing pre-reload favorite document") }
            let previousFavoriteDocument = String(decoding: try JSONEncoder().encode(favoriteDocument), as: UTF8.self)
            content.webView.reload()
            try await ContentSmoke.wait(content, "typeof window.utermContentDocument === 'string' && window.utermContentDocument !== \(previousFavoriteDocument) && document.querySelector('[data-node=\"refs/heads/main\"]')?.textContent.includes('★') === true")
            report["nativeFavoritesRetainedAfterReload"] = true
            captures.append("native-git-favorites.png")
            try await capture(content, captures.last!)

            try await GitFavoritesRecoverySmoke.run(model: model, parent: parent, content: content, source: favoriteSource,
                sourceRevision: favorites["sourceDigest"].string!, reportPath: reportPath, captures: &captures, report: &report)

            _ = try await bridge.call("editor.drafts.import", params: .object(["legacy": .null]))
            func seed(_ text: String) async throws {
                let disk = try await bridge.call("files.read", params: .object(["directory": .string(root.path), "path": .string(path)]))
                _ = try await bridge.call("editor.drafts.putDocument", params: .object([
                    "expectedDraftRevision": .null, "draft": .object([
                        "directory": .string(root.path), "path": .string(path), "kind": .string("text"),
                        "text": .string(text), "saved": disk["text"], "version": disk["version"], "line_ending": disk["line_ending"], "bom": disk["bom"]
                    ])
                ]))
            }
            let savedText = "SAVE_BEFORE_GIT 中文 e\u{301}\n"
            try await seed(savedText)
            let editor = try await openFile(root, path)
            defer { editor.forceClose() }
            try await ContentSmoke.wait(editor, "document.querySelector('.cm-content')?.textContent.includes('SAVE_BEFORE_GIT') === true")
            report["fileWindowCannotInvokeGit"] = try await ContentSmoke.request(editor, method: "git_snapshot", params: ["directory": root.path]) == "METHOD_DENIED"
            report["fileWindowCannotReadGitFavorites"] = try await ContentSmoke.request(editor, method: "git_favorites_read", params: ["directory": root.path]) == "METHOD_DENIED"
            content.window?.makeKeyAndOrderFront(nil)
            _ = try await content.webView.evaluateJavaScript("document.querySelector('[data-node=\"refs/heads/main\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:160}))")
            try await EditorSmoke.click(content, title: "New branch")
            try await ContentSmoke.wait(content, "document.querySelector('dialog[open] input[aria-label=\"Branch name\"]') !== null")
            let filled = try await EditorSmoke.evaluate(content, script: """
                const input=document.querySelector('dialog[open] input[aria-label="Branch name"]');
                if(!input)return false;
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,name);
                input.dispatchEvent(new Event('input',{bubbles:true}));return true;
                """, arguments: ["name": "native-created"])
            guard filled else { throw BridgeFailure(code: "GIT_FORM", message: "Native branch form not available") }
            try await EditorSmoke.click(content, title: "New branch")
            try await ContentSmoke.wait(content, "document.querySelector('[data-node=\"refs/heads/native-created\"]') !== null")
            let remaining = try await bridge.call("editor.drafts.document", params: .object(["directory": .string(root.path), "path": .string(path)]))
            guard try Data(contentsOf: file) == Data(savedText.utf8), remaining == .null, try git(["rev-parse", "refs/heads/native-created"]) == head else { throw BridgeFailure(code: "GIT_SAVE", message: "Git mutation did not await exact file save and draft acknowledgement") }
            report["branchFormSavedOpenEditorBeforeWrite"] = true
            captures.append("native-git-created-branch.png")
            try await capture(content, captures.last!)
            editor.forceClose()

            let tree = temporary.appendingPathComponent("git-worktree 中文")
            guard try await ContentSmoke.request(content, method: "create_worktree", params: ["directory": root.path, "reference": "refs/heads/main", "oid": head, "branch": "native-worktree", "path": tree.path]) == "SUCCESS" else { throw BridgeFailure(code: "GIT_WORKTREE", message: "Cannot create isolated Worktree through native bridge") }
            guard let project = model.projects.first(where: { $0["id"].string == "native-git-qa" }),
                  let treeID = project["worktrees"].array.first(where: { $0["branch"].string == "native-worktree" })?["id"].string,
                  let view = parent.contentView,
                  let table = TerminalSmoke.descendants(view).first(where: { $0.identifier?.rawValue == "native-sidebar" }) as? NSTableView else {
                throw BridgeFailure(code: "GIT_WORKTREE", message: "Created Worktree is absent from the shared native sidebar")
            }
            parent.makeKeyAndOrderFront(nil)
            var row: Int?
            try await TerminalSmoke.wait("Render actual native Worktree sidebar row") {
                row = (0..<table.numberOfRows).first { (table.view(atColumn: 0, row: $0, makeIfNecessary: true) as? NSTableCellView)?.textField?.stringValue == "native-worktree" }
                return row != nil
            }
            table.selectRowIndexes(IndexSet(integer: row!), byExtendingSelection: false)
            try await TerminalSmoke.wait("Select Worktree through the real AppKit table") { model.workspace["selectedWorktree"].string == treeID && !model.busy }
            guard let selectedState = model.state else { throw BridgeFailure(code: "GIT_WORKTREE", message: "Missing selected Worktree state") }
            let selectedTree = try await bridge.projectContext(expectedRevision: selectedState.snapshot.revision)
            let storedPath = project["worktrees"].array.first(where: { $0["id"].string == treeID })?["path"].string
            report["selectedWorktreeDirectory"] = selectedTree.directory ?? ""
            report["storedWorktreeDirectory"] = storedPath ?? ""
            report["fixtureWorktreeDirectory"] = tree.path
            report["canonicalFixtureWorktreeDirectory"] = tree.standardizedFileURL.resolvingSymlinksInPath().path
            guard selectedTree.projectId == "native-git-qa", selectedTree.worktreeId == treeID,
                  let selectedPath = selectedTree.directory, let storedPath,
                  Data(selectedPath.utf8) == Data(storedPath.utf8),
                  URL(fileURLWithPath: selectedPath).standardizedFileURL.resolvingSymlinksInPath() == tree.standardizedFileURL.resolvingSymlinksInPath() else {
                throw BridgeFailure(code: "GIT_WORKTREE", message: "Native Worktree selection changed its ID, stored path bytes or canonical directory")
            }
            captures.append("native-git-worktree-sidebar.png")
            try await TerminalSmoke.capture(window: parent, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(captures.last!))
            report["worktreeSidebarRegisteredAndSelected"] = true
            let retained = tree.appendingPathComponent("keep-dirty.txt"), dirty = Data("RETAIN_DIRTY 中文 e\u{301}\n".utf8)
            try dirty.write(to: retained)
            report["rawWorktreeDeleteDenied"] = try await ContentSmoke.request(content, method: "delete_worktree", params: ["directory": root.path, "path": tree.path]) == "METHOD_DENIED"
            func deletionSheet() async throws -> NSWindow {
                guard let coordinator = table.delegate as? NativeSidebar.Coordinator else { throw BridgeFailure(code: "GIT_MENU", message: "Missing native sidebar coordinator") }
                let menu = NSMenu()
                coordinator.populate(menu, row: row!)
                guard let index = menu.items.firstIndex(where: { $0.title == "Delete Worktree…" && $0.isEnabled }) else { throw BridgeFailure(code: "GIT_MENU", message: "Worktree delete action is unavailable") }
                parent.makeKeyAndOrderFront(nil)
                menu.performActionForItem(at: index)
                try await TerminalSmoke.wait("Show real native Worktree deletion confirmation") { parent.attachedSheet != nil && model.worktreeDeletionPresented }
                guard let sheet = parent.attachedSheet else { throw BridgeFailure(code: "GIT_MENU", message: "Missing deletion sheet") }
                var previousBounds: [Double] = [], stableSince = ProcessInfo.processInfo.systemUptime
                try await TerminalSmoke.wait("The actual Worktree confirmation is painted by WindowServer") {
                    guard sheet.isVisible, sheet.windowNumber > 0,
                          let entries = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(sheet.windowNumber)) as? [[String: Any]],
                          let entry = entries.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == sheet.windowNumber }),
                          (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == ProcessInfo.processInfo.processIdentifier,
                          entry[kCGWindowIsOnscreen as String] as? Bool == true,
                          let bounds = entry[kCGWindowBounds as String] as? [String: NSNumber] else { return false }
                    let current = ["X", "Y", "Width", "Height"].compactMap { bounds[$0]?.doubleValue }
                    guard current.count == 4, current.allSatisfy(\.isFinite), current[2] > 0, current[3] > 0 else { return false }
                    if current != previousBounds { previousBounds = current; stableSince = ProcessInfo.processInfo.systemUptime; return false }
                    return ProcessInfo.processInfo.systemUptime - stableSince >= 0.15
                }
                report["nativeWorktreeConfirmationPaintedBeforeCapture"] = true
                return sheet
            }
            func press(_ sheet: NSWindow, _ title: String) throws {
                guard let view = sheet.contentView,
                      let button = TerminalSmoke.descendants(view).compactMap({ $0 as? NSButton }).first(where: { $0.title == title && $0.isEnabled }) else { throw BridgeFailure(code: "GIT_MENU", message: "Native confirmation button unavailable: " + title) }
                button.performClick(nil)
            }
            let cancelled = try await deletionSheet()
            captures.append("native-git-worktree-delete-confirm.png")
            try await TerminalSmoke.capture(window: cancelled, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(captures.last!))
            try press(cancelled, "Cancel")
            try await TerminalSmoke.wait("Cancel native deletion without changing the Worktree") { parent.attachedSheet == nil && !model.worktreeDeletionPresented }
            report["nativeDeleteCancelRetainedWorktree"] = try Data(contentsOf: retained) == dirty
            let rejected = try await deletionSheet()
            try press(rejected, "Delete Worktree")
            do {
                try await TerminalSmoke.wait("Refuse dirty Worktree deletion in shared Core") { parent.attachedSheet == nil && !model.worktreeDeletionPresented && !model.busy && !model.error.isEmpty }
            } catch {
                report["worktreeDeleteFailureDiagnostics"] = ["sheetVisible": parent.attachedSheet != nil, "deletionPresented": model.worktreeDeletionPresented, "workspaceBusy": model.busy, "visibleError": model.error, "dirtyBytesRetained": (try? Data(contentsOf: retained)) == dirty, "directoryRetained": FileManager.default.fileExists(atPath: tree.path)]
                throw error
            }
            report["dirtyWorktreeDeletionRefused"] = try Data(contentsOf: retained) == dirty
            captures.append("native-git-worktree-delete-error.png")
            try await TerminalSmoke.capture(window: parent, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(captures.last!))
            try FileManager.default.removeItem(at: retained)
            let confirmed = try await deletionSheet()
            try press(confirmed, "Delete Worktree")
            try await TerminalSmoke.wait("Delete clean Worktree through native menu and shared Core") { !FileManager.default.fileExists(atPath: tree.path) && !model.busy && model.projects.first(where: { $0["id"].string == "native-git-qa" })?["worktrees"].array.isEmpty == true }
            report["worktreeBridgeCreateAndCleanDelete"] = !FileManager.default.fileExists(atPath: tree.path)
            report["nativeDeleteMenuCompleted"] = model.error.isEmpty
            report["nativeDeleteInput"] = "Real AppKit NSMenu action and NSAlert buttons; automated dispatch, not manual mouse acceptance"
            report["worktreeRemovedFromSharedSidebar"] = model.projects.first(where: { $0["id"].string == "native-git-qa" })?["worktrees"].array.isEmpty == true && model.workspace["selectedWorktree"] == .null

            let cancellationText = "SAVE_BEFORE_CANCELLED_GIT 中文 e\u{301}\n"
            try await seed(cancellationText)
            let cancellationEditor = try await openFile(root, path)
            defer { cancellationEditor.forceClose() }
            try await ContentSmoke.wait(cancellationEditor, "document.querySelector('.cm-content')?.textContent.includes('SAVE_BEFORE_CANCELLED_GIT') === true")
            let hooks = root.appendingPathComponent(".git/hooks")
            try FileManager.default.createDirectory(at: hooks, withIntermediateDirectories: true)
            let hook = hooks.appendingPathComponent("post-checkout")
            let releaseHook = root.appendingPathComponent(".git/uterm-qa-release")
            let startedHook = root.appendingPathComponent(".git/uterm-qa-started")
            let finishedHook = root.appendingPathComponent(".git/uterm-qa-finished")
            guard !FileManager.default.fileExists(atPath: hook.path) else { throw BridgeFailure(code: "GIT_CANCEL_FIXTURE", message: "Isolated checkout hook already exists") }
            try git(["config", "core.hooksPath", ".git/hooks"])
            let hookScript = """
                #!/bin/sh
                : > .git/uterm-qa-started
                attempt=0
                while [ ! -e .git/uterm-qa-release ]; do
                  attempt=$((attempt+1))
                  if [ "$attempt" -ge 600 ]; then exit 77; fi
                  sleep 0.1
                done
                : > .git/uterm-qa-finished
                """
            try Data((hookScript + "\n").utf8).write(to: hook)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: hook.path)
            defer { try? Data().write(to: releaseHook); try? FileManager.default.removeItem(at: hook) }
            let cancellationID = UUID().uuidString
            guard try await EditorSmoke.evaluate(content, script: """
                window.qaGitCancellationResult=null;
                window.webkit.messageHandlers.utermContent.postMessage({kind:'request',version:1,id:operationID,document:window.utermContentDocument,method:'git_switch_branch',params:{directory,branch:'topic',expected:'main'}})
                  .then(reply=>{window.qaGitCancellationResult=reply;});
                return true;
                """, arguments: ["operationID": cancellationID, "directory": root.path]) else { throw BridgeFailure(code: "GIT_CANCEL_FIXTURE", message: "Cannot dispatch real Git request") }
            try await TerminalSmoke.wait("Enter real Git checkout hook with editors frozen") { FileManager.default.fileExists(atPath: startedHook.path) && model.busy }
            guard try Data(contentsOf: file) == Data(cancellationText.utf8) else { throw BridgeFailure(code: "GIT_CANCEL", message: "Git started before saving the editor") }
            guard try await EditorSmoke.evaluate(content, script: """
                await window.webkit.messageHandlers.utermContent.postMessage({kind:'cancel',version:1,id:operationID,document:window.utermContentDocument});return true;
                """, arguments: ["operationID": cancellationID]) else { throw BridgeFailure(code: "GIT_CANCEL", message: "Cannot cancel the real WebKit operation") }
            try await Task.sleep(for: .milliseconds(200))
            guard model.busy, !FileManager.default.fileExists(atPath: finishedHook.path) else { throw BridgeFailure(code: "GIT_CANCEL", message: "Cancellation released repository protection before Git finished") }
            try await ContentSmoke.wait(cancellationEditor, "document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'false'")
            report["cancelledGitRetainedEditorFreezeUntilCompletion"] = true
            captures.append("native-git-cancel-frozen-editor.png")
            try await capture(cancellationEditor, captures.last!)
            try Data().write(to: releaseHook)
            try await TerminalSmoke.wait("Wait for actual Git completion after cancellation") { FileManager.default.fileExists(atPath: finishedHook.path) && !model.busy }
            try await ContentSmoke.wait(content, "window.qaGitCancellationResult?.error?.code === 'WORKTREE_SYNC'", allowAlert: true)
            try await ContentSmoke.wait(cancellationEditor, "document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'true'")
            guard try git(["branch", "--show-current"]) == "topic", try Data(contentsOf: file) == Data(cancellationText.utf8) else { throw BridgeFailure(code: "GIT_CANCEL", message: "Cancelled reply lost the completed Git result or exact editor bytes") }
            report["cancelledGitReportedCompletedWriteAndRetainedBytes"] = true
            report["gitCancellationScenario"] = "Real post-checkout hook, exact saved UTF-8, WebKit protocol cancel after dispatch, editor frozen until Git completes; WORKTREE_SYNC requests explicit refresh, no rollback claim"
            try FileManager.default.removeItem(at: hook)
            cancellationEditor.forceClose()
            await model.refreshWorktrees("native-git-qa")

            let unsaved = "RETAIN_CONFLICT 中文 e\u{301}\n", external = Data("EXTERNAL_WRITER 中文\n".utf8)
            try await seed(unsaved)
            let conflict = try await openFile(root, path)
            defer { conflict.forceClose() }
            try await ContentSmoke.wait(conflict, "document.querySelector('.cm-content')?.textContent.includes('RETAIN_CONFLICT') === true")
            let conflictBranch = try git(["branch", "--show-current"])
            let conflictTarget = conflictBranch == "topic" ? "main" : "topic"
            try external.write(to: file)
            let code = try await ContentSmoke.request(content, method: "git_switch_branch", params: ["directory": root.path, "branch": conflictTarget, "expected": conflictBranch])
            let retainedDraft = try await bridge.call("editor.drafts.document", params: .object(["directory": .string(root.path), "path": .string(path)]))
            let retainedBranch = try git(["branch", "--show-current"]) == conflictBranch
            let retainedFile = try Data(contentsOf: file) == external
            let retainedText = retainedDraft["draft"]["text"].string.map({ Data($0.utf8) }) == Data(unsaved.utf8)
            let conflictDiagnostics: [String: Any] = ["expectedBranch": conflictBranch, "targetBranch": conflictTarget, "replyCode": code, "branchRetained": retainedBranch, "externalFileRetained": retainedFile, "draftRetained": retainedText]
            report["editorConflictDiagnostics"] = conflictDiagnostics
            guard code == "GIT_FILES", retainedBranch, retainedFile, retainedText else { throw BridgeFailure(code: "GIT_CONFLICT", message: "A conflicting editor did not prevent Git while preserving both writers") }
            try await ContentSmoke.wait(conflict, "document.querySelector('[role=alert]')?.textContent.includes('Another program modified this file') === true", allowAlert: true)
            captures.append("native-git-editor-conflict.png")
            try await capture(conflict, captures.last!)
            report["editorConflictBlockedGitAndPreservedBothWriters"] = true
            conflict.forceClose()
            let siblingBytes = try Data(contentsOf: sentinel)
            report["literalRootAndSiblingPreserved"] = content.directory.path == root.path && siblingBytes == sentinelBytes
            content.forceClose()
            await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
            let narrow = try await open(root)
            defer { narrow.forceClose() }
            narrow.window?.setContentSize(NSSize(width: 640, height: 600))
            try await ContentSmoke.wait(narrow, "innerWidth===640 && [...document.querySelectorAll('[role=tab]')].some(b=>b.textContent.trim()==='变更') && document.querySelector('.git-file') !== null && (()=>{const r=document.querySelector('.git-panel').getBoundingClientRect();return r.left===0 && r.top===0 && Math.abs(r.right-innerWidth)<=1})()")
            report["narrowPanelFillsWindow"] = true
            _ = try await narrow.webView.evaluateJavaScript("document.querySelector('.git-file').click()")
            try await ContentSmoke.wait(narrow, "document.querySelector('.git-diff')?.textContent.includes('EXTERNAL_WRITER') === true && [...document.querySelectorAll('.git-diff-actions button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1}) && document.documentElement.scrollWidth<=innerWidth")
            captures.append("native-git-zh-light-640.png")
            try await capture(narrow, captures.last!)
            report["narrowChineseLightGit"] = true
            report["gitCaptures"] = captures
            report["gitScenario"] = ["data": "isolated real Git repository with a trailing-space root and a protected sibling", "wide": "English/dark 1000px", "narrow": "Chinese/light 640px", "input": "DOM events/forms, real WK requests, AppKit table/menu/alert actions; not manual keyboard or IME acceptance", "worktree": "create, shared sidebar registration/selection, native delete confirmation/cancel/dirty refusal/clean removal"]
        } catch {
            let image = "native-git-failure.png"
            do { try await capture(content, image); report["failureCapture"] = image }
            catch { report["failureCaptureError"] = error.localizedDescription }
            do {
                let image = "native-git-workspace-failure.png"
                try await TerminalSmoke.capture(window: parent, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(image))
                report["failureWorkspaceCapture"] = image
            } catch { report["failureWorkspaceCaptureError"] = error.localizedDescription }
            report["gitCaptures"] = captures
            throw error
        }
    }
}
