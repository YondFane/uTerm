import AppKit
import UTermBridge

@MainActor
enum GitHubParitySmoke {
    static func run(model: WorkspaceModel, window: NSWindow, output: URL, fixture: JSONValue, phase: String, report: inout [String: Any], captures: inout [String]) async throws {
        guard let bridge = model.bridge, let terminal = model.selectedTerminal,
              let fixtureRoot = ProcessInfo.processInfo.environment["UTERM_GITHUB_FIXTURE_ROOT"],
              URL(fileURLWithPath: fixtureRoot).deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath() == output.standardizedFileURL.resolvingSymlinksInPath() else { throw BridgeFailure(code: "GITHUB_PARITY_CONTEXT", message: "Missing isolated GitHub CLI fixture") }
        let original = try await bridge.snapshot(), generation = terminal.generation, identity = ObjectIdentifier(terminal.view)
        let form = fixture["github"]
        var scenes: [[String: Any]] = []
        for scene in fixture["githubScenes"].array {
            guard let language = scene["language"].string, let appearance = scene["appearance"].string,
                  let widthNumber = scene["width"].number, let heightNumber = scene["height"].number,
                  let width = Int(exactly: widthNumber), let height = Int(exactly: heightNumber) else { throw BridgeFailure(code: "GITHUB_PARITY_SCENE", message: "Invalid GitHub comparison scene") }
            await model.patchSettings(["language": .string(language), "appearance": .string(appearance)])
            _ = try await TerminalSmoke.sizeCaptureWindow(window, width: width, height: height)
            try await TerminalSmoke.wait("Attach the current shared tools before GitHub navigation") { model.inspector.content?.webView.window === window }
            guard let tools = model.inspector.content else { throw BridgeFailure(code: "GITHUB_PARITY_TOOLS", message: "Missing live tools switcher") }
            do {
                // DOM click silently ignores controls inside a disabled fieldset; wait for the real action.
                // DOM click 会静默忽略禁用字段组内的控件，须先等待实际操作入口可用。
                try await ContentSmoke.wait(tools, "(()=>{const b=document.querySelector('.inspector-switcher button[aria-label=GitHub]');return !!b && !b.matches(':disabled')})()")
                guard model.inspector.content === tools, tools.webView.window === window else { throw BridgeFailure(code: "GITHUB_PARITY_TOOLS", message: "Tools changed before the actual GitHub action") }
                _ = try await tools.webView.evaluateJavaScript("document.querySelector('.inspector-switcher button[aria-label=GitHub]').click()")
                try await TerminalSmoke.wait("Open actual GitHub tools from the shared header") { model.inspector.content?.workbenchHost?.kind == "github" && model.inspector.content?.webView.window === window }
            } catch {
                let dom = try? await tools.webView.evaluateJavaScript("(()=>{const b=document.querySelector('.inspector-switcher button[aria-label=GitHub]');return {buttonPresent:!!b,buttonDisabled:b?b.matches(':disabled'):null,fieldsetDisabled:document.querySelector('fieldset')?.disabled??null,language:document.documentElement.lang,alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent)}})()")
                report["githubToolsOpenDiagnostics"] = ["phase": phase, "language": language, "width": width, "mode": model.inspector.mode.rawValue,
                    "kind": model.inspector.content?.workbenchHost?.kind ?? "", "sameContent": model.inspector.content === tools,
                    "capturedContentAttached": tools.webView.window === window, "modelBusy": model.busy, "workspaceModalPresented": model.workspaceModalPresented,
                    "DOM": dom ?? "Unavailable"] as [String: Any]
                throw error
            }
            guard let github = model.inspector.content else { throw BridgeFailure(code: "GITHUB_PARITY_TOOLS", message: "Missing GitHub tools") }
            try await ContentSmoke.wait(github, "document.documentElement.lang==='" + language + "' && document.querySelector('.compare-picker select')?.value==='fixture-owner/fixture-repo'")
            try await EditorSmoke.click(github, title: language == "en" ? "Pull Requests" : "合并请求")
            try await EditorSmoke.click(github, title: language == "en" ? "New PR" : "新建 PR")
            try await TerminalSmoke.wait("Attach real shared PR form over the workspace") { model.githubPRContent?.webView.window === window }
            guard let modal = model.githubPRContent else { throw BridgeFailure(code: "GITHUB_PARITY_MODAL", message: "Missing actual PR modal") }
            try await ContentSmoke.wait(modal, "document.querySelector('.pr-dialog[open] textarea')!==null")
            guard try await EditorSmoke.evaluate(modal, script: """
                const form=document.querySelector('.pr-dialog[open] form'),inputs=form.querySelectorAll('input:not([type=checkbox])');
                for(const [field,prototype,value] of [[inputs[0],HTMLInputElement.prototype,title],[inputs[1],HTMLInputElement.prototype,base],[inputs[2],HTMLInputElement.prototype,head],[form.querySelector('textarea'),HTMLTextAreaElement.prototype,body]]){
                    Object.getOwnPropertyDescriptor(prototype,'value').set.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));
                }
                const checkbox=form.querySelector('input[type=checkbox]');if(checkbox.checked!==draft)checkbox.click();return true;
                """, arguments: ["title": form["title"].string ?? "", "base": form["base"].string ?? "", "head": form["head"].string ?? "", "body": form["body"].string ?? "", "draft": form["draft"].bool ?? false]) else { throw BridgeFailure(code: "GITHUB_PARITY_INPUT", message: "PR form did not accept literal input") }
            guard try await EditorSmoke.evaluate(modal, script: """
                const form=document.querySelector('.pr-dialog[open] form'),inputs=form.querySelectorAll('input:not([type=checkbox])');
                return inputs[0].value===title && inputs[1].value===base && inputs[2].value===head && form.querySelector('textarea').value===body && form.querySelector('input[type=checkbox]').checked===draft;
                """, arguments: ["title": form["title"].string ?? "", "base": form["base"].string ?? "", "head": form["head"].string ?? "", "body": form["body"].string ?? "", "draft": form["draft"].bool ?? false]) else { throw BridgeFailure(code: "GITHUB_PARITY_INPUT", message: "PR form changed literal field values") }
            let geometry = try await GitHubSmoke.modalGeometry(modal, parent: window)
            guard github.webView.window === window, terminal.view.window === window, !terminal.view.visibleRect.isEmpty,
                  terminal.generation == generation, ObjectIdentifier(terminal.view) == identity,
                  (try await bridge.snapshot()).document.workspace == original.document.workspace else { throw BridgeFailure(code: "GITHUB_PARITY_STATE", message: "PR form replaced the live workspace") }
            let name = "personal-\(phase)-github-pr-draft-\(language)-\(appearance)-\(width).png"
            try await TerminalSmoke.capture(window: window, path: output.appendingPathComponent(name))
            captures.append(name); report["captures"] = captures
            var row: [String: Any] = ["language": language, "appearance": appearance, "width": width, "height": height, "screenshot": name,
                "sourceHeadSHA": report["sourceHeadSHA"] ?? "", "testedMergeSHA": report["testedMergeSHA"] ?? "", "platform": "macOS", "architecture": report["architecture"] ?? "", "system": report["system"] ?? "",
                "scenario": "github-pr-draft", "form": try JSONSerialization.jsonObject(with: JSONEncoder().encode(form)),
                "actualToolsSwitcher": true, "actualEnabledToolsSwitcher": true, "literalInputRetained": true, "readableFields": true, "workspaceVisibleAroundDialog": true, "terminalGenerationRetained": true, "savedWorkspaceUnchanged": true,
                "isolatedSimulatedCLI": true, "noGitHubWrites": true]
            for (key, value) in geometry { row["modal" + key.prefix(1).uppercased() + String(key.dropFirst())] = value }
            try await EditorSmoke.click(modal, title: language == "en" ? "Cancel" : "取消")
            try await TerminalSmoke.wait("Explicit PR Cancel retains the main window and terminal") { model.githubPRContent == nil && window.isVisible && terminal.view.window === window }
            guard terminal.generation == generation, (try await bridge.snapshot()).document.workspace == original.document.workspace else { throw BridgeFailure(code: "GITHUB_PARITY_CANCEL", message: "PR cancellation changed shared state") }
            let log = try String(contentsOf: URL(fileURLWithPath: fixtureRoot).appendingPathComponent("github-cli.jsonl"), encoding: .utf8)
            let calls = try log.split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
            guard !calls.isEmpty, calls.allSatisfy({ ($0["arguments"] as? [String])?.first != "api" }) else { throw BridgeFailure(code: "GITHUB_PARITY_WRITE", message: "PR comparison unexpectedly dispatched a write") }
            row["actualCancelPreservedState"] = true
            scenes.append(row); report["githubPRScenes"] = scenes
        }
    }
}
