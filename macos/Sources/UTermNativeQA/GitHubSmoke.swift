import AppKit
import UTermBridge

@MainActor
enum GitHubSmoke {
    static func run(model: WorkspaceModel, parent: NSWindow, open: (URL) async throws -> ContentWindow, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.bridge, let path = WorkspaceModel.argument("--github-smoke-report"),
              let fixture = ProcessInfo.processInfo.environment["UTERM_GITHUB_FIXTURE_ROOT"],
              URL(fileURLWithPath: fixture).standardizedFileURL.resolvingSymlinksInPath() == (try WorkspaceModel.dataRoot()).deletingLastPathComponent() else { throw BridgeFailure(code: "GITHUB_QA_CONTEXT", message: "Missing isolated GitHub CLI fixture") }
        let temporary = URL(fileURLWithPath: fixture), root = temporary.appendingPathComponent("github-project")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        func git(_ arguments: [String]) throws {
            let process = Process(), pipe = Pipe(); process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["-c", "core.hooksPath=" + temporary.appendingPathComponent("no-hooks").path, "-C", root.path] + arguments
            process.standardOutput = pipe; process.standardError = pipe; try process.run()
            let bytes = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw BridgeFailure(code: "GITHUB_QA_GIT", message: String(decoding: bytes, as: UTF8.self)) }
        }
        try git(["init", "--initial-branch=qa-feature"])
        try Data("GITHUB_QA\n".utf8).write(to: root.appendingPathComponent("notes.txt")); try git(["add", "notes.txt"])
        try git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--no-gpg-sign", "-m", "Native GitHub fixture"])
        try git(["remote", "add", "origin", "https://github.com/fixture-owner/fixture-repo.git"])
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        guard await model.mutate("project.open", ["id": .string(UUID().uuidString), "name": .string("GitHub QA 中文"), "directory": .string(root.path), "workspaceId": .string(model.groupID)]) else { throw BridgeFailure(code: "GITHUB_QA_PROJECT", message: model.error) }
        await model.newTerminal()
        try await TerminalSmoke.wait("Start GitHub fixture PTY") { model.selectedTerminal?.generation != nil && model.selectedTerminal?.error.isEmpty == true }
        guard let first = model.selectedTerminal else { throw BridgeFailure(code: "GITHUB_QA_PTY", message: "Missing fixture terminal") }
        let content = try await open(root)
        guard let window = content.window, let host = content.workbenchHost as? GitHubHost else { throw BridgeFailure(code: "GITHUB_QA_HOST", message: "No GitHub workbench") }
        defer { content.forceClose() }
        try await ContentSmoke.wait(content, "document.querySelectorAll('.github-items button').length === 1")
        let wrongRoot = try await ContentSmoke.request(content, method: "github_repositories", params: ["directory": temporary.path])
        let unknown = try await ContentSmoke.request(content, method: "file_save", params: ["directory": root.path, "path": "notes.txt", "text": "WRONG"])
        let privateArgument = try await ContentSmoke.request(content, method: "github_read", params: ["directory": root.path, "repository": "fixture-owner/fixture-repo", "kind": "issue", "token": "not-a-secret"])
        guard wrongRoot == "ROOT_DENIED", unknown == "ROOT_DENIED", privateArgument == "GITHUB_ARGUMENT", try Data(contentsOf: root.appendingPathComponent("notes.txt")) == Data("GITHUB_QA\n".utf8) else { throw BridgeFailure(code: "GITHUB_QA_SCOPE", message: "GitHub content crossed its method, parameter or root boundary") }
        report["githubNativeRootMethodAndPrivateParameterBoundaries"] = true
        _ = try await content.webView.evaluateJavaScript("document.querySelector('.github-items button').click()")
        try await ContentSmoke.wait(content, "document.querySelector('.github-detail')?.textContent.includes('BOLD_FIXTURE') === true || document.querySelector('.github-panel')?.textContent.includes('BOLD_FIXTURE') === true")
        guard try await EditorSmoke.evaluate(content, script: "return !document.querySelector('.github-panel script, .github-panel img, .github-panel iframe') && ![...document.querySelectorAll('button')].find(b=>b.textContent==='Link current session').disabled && [...document.querySelectorAll('button')].find(b=>b.textContent==='Insert into agent input').disabled;", arguments: [:]) else { throw BridgeFailure(code: "GITHUB_QA_RENDER", message: "Unsafe Markdown or incorrect session capabilities") }
        try await EditorSmoke.click(content, title: "Link current session")
        try await TerminalSmoke.wait("Associate issue through shared revisioned session operation") { model.state?.sessions.first(where: { $0.sessionID == first.id })?.session["issue"]["url"].string == "https://github.com/fixture-owner/fixture-repo/issues/7" }
        var captures: [String] = []
        func capture(_ name: String) async throws { try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name)) }
        try await capture("native-github-issue-dark-en.png"); captures.append("native-github-issue-dark-en.png")
        try await EditorSmoke.click(content, title: "New linked session")
        try await TerminalSmoke.wait("Create linked project session") { model.terminals.count == 2 && model.selectedTerminal?.generation != nil }
        guard model.state?.sessions.first(where: { $0.sessionID == model.selectedID })?.session["issue"]["url"].string == "https://github.com/fixture-owner/fixture-repo/issues/7", first.generation != nil else { throw BridgeFailure(code: "GITHUB_QA_LINK", message: "Linked session lost issue metadata or the original PTY") }
        report["nativeGithubMarkdownAssociationAndLinkedSession"] = true
        try Data().write(to: temporary.appendingPathComponent("github-offline"))
        try await EditorSmoke.click(content, title: "Pull Requests")
        try await ContentSmoke.wait(content, "document.querySelector('[role=alert]')?.textContent.includes('fixture is offline') === true", allowAlert: true)
        try FileManager.default.removeItem(at: temporary.appendingPathComponent("github-offline"))
        try await EditorSmoke.click(content, title: "Issues")
        try await ContentSmoke.wait(content, "document.querySelectorAll('.github-items button').length === 1 && !document.querySelector('[role=alert]')")
        report["nativeGithubOfflineFailureVisibleAndRetryRecovered"] = true
        try await EditorSmoke.click(content, title: "Pull Requests")
        try await ContentSmoke.wait(content, "document.querySelectorAll('.github-items button').length === 1")
        _ = try await content.webView.evaluateJavaScript("document.querySelector('.github-items button').click()")
        try await EditorSmoke.click(content, title: "View diff")
        try await ContentSmoke.wait(content, "document.querySelector('.github-panel')?.textContent.includes('GITHUB_FIXTURE_DIFF') === true")
        try await capture("native-github-pr-diff-dark-en.png"); captures.append("native-github-pr-diff-dark-en.png")
        report["nativeGithubPRDetailsAndDiff"] = true
        try Data().write(to: temporary.appendingPathComponent("github-slow-read"))
        let cancelledRead = Task { @MainActor in
            try await EditorSmoke.evaluate(content, script: """
                const handler=window.webkit.messageHandlers.utermContent, document=window.utermContentDocument;
                const pending=handler.postMessage({kind:'request',version:1,id:operationID,document,method:'github_read',params:{directory,repository:'fixture-owner/fixture-repo',kind:'issue',number:7}});
                setTimeout(()=>void handler.postMessage({kind:'cancel',version:1,id:operationID,document}),100);
                const reply=await pending; return reply.error?.code==='CANCELLED';
                """, arguments: ["directory": root.path, "operationID": UUID().uuidString])
        }
        try await TerminalSmoke.wait("Fixture CLI starts cancelled read") { FileManager.default.fileExists(atPath: temporary.appendingPathComponent("github-read-started").path) }
        guard try await host.prepareForQuit() == false, try await cancelledRead.value else { throw BridgeFailure(code: "GITHUB_QA_CANCEL", message: "Cancellation released the API operation before its actual result") }
        try FileManager.default.removeItem(at: temporary.appendingPathComponent("github-slow-read"))
        report["nativeGithubCancellationRetainsPendingOperationUntilCLICompletes"] = true
        try await EditorSmoke.click(content, title: "New PR")
        try await ContentSmoke.wait(content, "document.querySelector('dialog[open] textarea') !== null")
        let literalTitle = "Keep `literal` $(literal) 中文", literalBody = "Line one\n$(literal)\n`literal` 中文"
        guard try await EditorSmoke.evaluate(content, script: """
            const form=document.querySelector('dialog[open] form');
            const input=form.querySelector('input'),body=form.querySelector('textarea');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,title);input.dispatchEvent(new Event('input',{bubbles:true}));
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(body,text);body.dispatchEvent(new Event('input',{bubbles:true}));
            return true;
            """, arguments: ["title": literalTitle, "text": literalBody]) else { throw BridgeFailure(code: "GITHUB_QA_FORM", message: "PR form did not accept input") }
        window.performClose(nil)
        guard !window.isVisible else { throw BridgeFailure(code: "GITHUB_QA_HIDE", message: "Close did not hide the GitHub window") }
        let reopened = try await open(root)
        guard reopened === content else { throw BridgeFailure(code: "GITHUB_QA_REUSE", message: "Reopening replaced the PR draft window") }
        try await ContentSmoke.wait(content, "document.querySelector('dialog[open] textarea')?.value.includes('$(literal)') === true")
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(200)) {
            var queue = NSApp.modalWindow?.contentView.map { [$0] } ?? []
            while !queue.isEmpty { let view = queue.removeFirst(); if let button = view as? NSButton, button.title == "Cancel" { button.performClick(nil); return }; queue += view.subviews }
            NSApp.abortModal()
        }
        guard try await host.prepareForQuit() == false else { throw BridgeFailure(code: "GITHUB_QA_QUIT", message: "Cancel discarded a PR draft") }
        guard try await EditorSmoke.evaluate(content, script: "return document.querySelector('dialog[open] input').value===title && document.querySelector('dialog[open] textarea').value===text;", arguments: ["title": literalTitle, "text": literalBody]) else { throw BridgeFailure(code: "GITHUB_QA_DRAFT", message: "Quit cancellation changed the PR draft") }
        try await capture("native-github-pr-draft-dark-en.png"); captures.append("native-github-pr-draft-dark-en.png")
        report["nativeGithubHideReopenAndQuitCancelRetainDraft"] = true
        try await EditorSmoke.click(content, title: "Create on GitHub")
        try await TerminalSmoke.wait("Fixture CLI starts explicit PR creation") { FileManager.default.fileExists(atPath: temporary.appendingPathComponent("github-create-started").path) }
        guard try await host.prepareForQuit() == false else { throw BridgeFailure(code: "GITHUB_QA_PENDING", message: "Quit bypassed an active API write") }
        try await ContentSmoke.wait(content, "document.querySelector('[role=status]')?.textContent.includes('Created PR #99') === true")
        let lines = try String(contentsOf: temporary.appendingPathComponent("github-cli.jsonl"), encoding: .utf8).split(separator: "\n")
        let completed = try lines.map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }.filter { $0["event"] as? String == "create-completed" }
        guard completed.count == 1, let payload = completed[0]["payload"] as? [String: Any], payload["title"] as? String == literalTitle, payload["body"] as? String == literalBody, payload["draft"] as? Bool == true else { throw BridgeFailure(code: "GITHUB_QA_PAYLOAD", message: "CLI did not receive exactly one literal PR payload") }
        report["nativeGithubExplicitCreateLiteralPayloadAndPendingQuitGuard"] = true
        try await EditorSmoke.click(content, title: "New PR")
        try await ContentSmoke.wait(content, "document.querySelector('dialog[open] textarea') !== null")
        await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
        window.setContentSize(NSSize(width: 680, height: 620))
        try await ContentSmoke.wait(content, "document.documentElement.lang==='zh-Hans' && document.querySelector('dialog[open]')?.textContent.includes('新建 Pull Request') === true")
        try await capture("native-github-pr-draft-light-zh-narrow.png"); captures.append("native-github-pr-draft-light-zh-narrow.png")
        try await EditorSmoke.click(content, title: "取消")
        try await ContentSmoke.wait(content, "document.querySelector('dialog[open]') === null")
        guard try await host.prepareForQuit() else { throw BridgeFailure(code: "GITHUB_QA_FINAL_QUIT", message: "Clean GitHub workbench could not prepare to quit") }
        await host.resumeAfterQuit()
        report["nativeGithubBilingualThemeAndCleanQuitResume"] = true
        report["captures"] = captures; report["githubCLI"] = "isolated simulated gh; no account, network request, real PR, push or fork"
        report["inputMethod"] = "Actual native WKWebView DOM events and AppKit quit dialog cancellation; manual IME acceptance waived by user"
        for id in Array(model.terminals.keys) { await model.selectSession(id); await model.closeSession() }
        guard try await bridge.call("host.status")["sessions"].array.isEmpty else { throw BridgeFailure(code: "GITHUB_QA_CLEANUP", message: "GitHub fixture PTYs remain") }
        _ = try await bridge.call("host.shutdownIdle"); report["explicitFixtureCloseAndIdleHostShutdown"] = true
        parent.makeKeyAndOrderFront(nil)
    }
}
