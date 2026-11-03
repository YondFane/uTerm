import AppKit
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
            guard selectedTree.directory.map({ Data($0.utf8) }) == Data(tree.path.utf8) else { throw BridgeFailure(code: "GIT_WORKTREE", message: "Native Worktree selection resolved a different directory") }
            captures.append("native-git-worktree-sidebar.png")
            try await TerminalSmoke.capture(window: parent, path: URL(fileURLWithPath: reportPath).deletingLastPathComponent().appendingPathComponent(captures.last!))
            report["worktreeSidebarRegisteredAndSelected"] = true
            let retained = tree.appendingPathComponent("keep-dirty.txt"), dirty = Data("RETAIN_DIRTY 中文 e\u{301}\n".utf8)
            try dirty.write(to: retained)
            let deletion = try await ContentSmoke.request(content, method: "delete_worktree", params: ["directory": root.path, "path": tree.path])
            let dirtyBytes = try Data(contentsOf: retained)
            report["dirtyWorktreeDeletionRefused"] = deletion == "GIT_ERROR" && dirtyBytes == dirty
            try FileManager.default.removeItem(at: retained)
            guard try await ContentSmoke.request(content, method: "delete_worktree", params: ["directory": root.path, "path": tree.path]) == "SUCCESS" else { throw BridgeFailure(code: "GIT_WORKTREE", message: "Clean Worktree deletion failed") }
            report["worktreeBridgeCreateAndCleanDelete"] = !FileManager.default.fileExists(atPath: tree.path)
            report["worktreeRemovedFromSharedSidebar"] = model.projects.first(where: { $0["id"].string == "native-git-qa" })?["worktrees"].array.isEmpty == true && model.workspace["selectedWorktree"] == .null

            let unsaved = "RETAIN_CONFLICT 中文 e\u{301}\n", external = Data("EXTERNAL_WRITER 中文\n".utf8)
            try await seed(unsaved)
            let conflict = try await openFile(root, path)
            defer { conflict.forceClose() }
            try await ContentSmoke.wait(conflict, "document.querySelector('.cm-content')?.textContent.includes('RETAIN_CONFLICT') === true")
            try external.write(to: file)
            let code = try await ContentSmoke.request(content, method: "git_switch_branch", params: ["directory": root.path, "branch": "topic", "expected": "main"])
            let retainedDraft = try await bridge.call("editor.drafts.document", params: .object(["directory": .string(root.path), "path": .string(path)]))
            guard code == "GIT_FILES", try git(["branch", "--show-current"]) == "main", try Data(contentsOf: file) == external,
                  retainedDraft["draft"]["text"].string.map({ Data($0.utf8) }) == Data(unsaved.utf8) else { throw BridgeFailure(code: "GIT_CONFLICT", message: "A conflicting editor did not prevent Git while preserving both writers") }
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
            report["gitScenario"] = ["data": "isolated real Git repository with a trailing-space root and a protected sibling", "wide": "English/dark 1000px", "narrow": "Chinese/light 640px", "input": "DOM events/forms, real WK requests and AppKit table selection; not manual keyboard or IME acceptance", "worktree": "bridge create/dirty refusal/clean delete, shared sidebar registration/selection/removal; native delete menu pending"]
        } catch {
            let image = "native-git-failure.png"
            do { try await capture(content, image); report["failureCapture"] = image }
            catch { report["failureCaptureError"] = error.localizedDescription }
            report["gitCaptures"] = captures
            throw error
        }
    }
}
