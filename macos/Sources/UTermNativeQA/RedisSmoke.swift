import AppKit
import UTermBridge

@MainActor
enum RedisSmoke {
    @MainActor
    private final class QuitCancellation {
        private let path: URL
        private let deadline = Date().addingTimeInterval(10)
        private var timer: Timer?
        private var observedWindow: Int?
        private var observedAt: Date?
        private(set) var clicked = false
        private(set) var captured = false
        init(path: URL) { self.path = path }
        func start() {
            let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            self.timer = timer
            RunLoop.main.add(timer, forMode: .modalPanel)
        }
        func stop() { timer?.invalidate(); timer = nil }
        private func views(_ root: NSView) -> [NSView] {
            [root] + root.subviews.flatMap { views($0) }
        }
        private func tick() {
            if Date() > deadline {
                stop()
                if NSApp.modalWindow != nil { NSApp.stopModal(withCode: .abort) }
                return
            }
            guard let modal = NSApp.modalWindow, let root = modal.contentView else { return }
            let contents = views(root)
            guard contents.contains(where: { ($0 as? NSTextField)?.stringValue == "Discard Redis drafts and quit?" }),
                  let cancel = contents.compactMap({ $0 as? NSButton }).first(where: { $0.title == "Cancel" && $0.isEnabled }) else { return }
            if observedWindow != modal.windowNumber {
                observedWindow = modal.windowNumber; observedAt = Date(); return
            }
            guard let observedAt, Date().timeIntervalSince(observedAt) >= 0.15 else { return }
            modal.displayIfNeeded()
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-o", "-l", String(modal.windowNumber), path.path]
            capture.standardOutput = FileHandle.nullDevice; capture.standardError = FileHandle.nullDevice
            do {
                try capture.run(); capture.waitUntilExit()
                captured = capture.terminationStatus == 0 && FileManager.default.fileExists(atPath: path.path)
            } catch { captured = false }
            clicked = true
            cancel.performClick(nil)
            stop()
        }
    }
    private static func wait(_ content: ContentWindow, _ script: String) async throws {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            guard content.navigationError.isEmpty else { throw BridgeFailure(code: "REDIS_NAVIGATION", message: "Redis content navigation failed") }
            if let value = try? await content.webView.evaluateJavaScript(script), value as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(40))
        }
        throw BridgeFailure(code: "REDIS_SCENE_TIMEOUT", message: "Native Redis scene did not complete")
    }
    private static func input(_ content: ContentWindow, selector: String, text: String) async throws {
        let found = try await EditorSmoke.evaluate(content, script: """
            const input=document.querySelector(selector); if(!input)return false;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,text);
            input.dispatchEvent(new Event('input',{bubbles:true}));return true;
            """, arguments: ["selector": selector, "text": text])
        guard found else { throw BridgeFailure(code: "REDIS_INPUT", message: "Redis input is unavailable") }
    }
    private static func click(_ content: ContentWindow, title: String, selector: String = "button", prefix: Bool = false) async throws {
        // Rows can repaint before the operation releases its busy guard; click once after readiness.
        // 列表可能先于操作释放忙碌保护重绘；等待控件就绪后只点击一次。
        let label = String(decoding: try JSONEncoder().encode(title), as: UTF8.self)
        let query = String(decoding: try JSONEncoder().encode(selector), as: UTF8.self)
        let comparison = prefix ? "text.startsWith(\(label))" : "text===\(label)"
        try await wait(content, """
            (()=>{const b=[...document.querySelectorAll(\(query))].find(b=>{
            const text=b.textContent.trim(),r=b.getBoundingClientRect();
            return \(comparison)&&!b.disabled&&r.width>0&&r.height>0&&getComputedStyle(b).visibility==='visible';});
            if(!b)return false;b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();
            if(r.top<0||r.bottom>innerHeight||r.left<0||r.right>innerWidth)return false;
            b.click();return true;})()
            """)
    }
    private static func selectKey(_ content: ContentWindow, _ title: String) async throws {
        let encoded = String(decoding: try JSONEncoder().encode(title), as: UTF8.self)
        try await wait(content, """
            (()=>{const toggle=document.querySelector('.redis-browser-toggle');
            if(!toggle||toggle.disabled)return false;
            if(toggle.getAttribute('aria-expanded')!=='true'){toggle.click();return false;}
            const row=[...document.querySelectorAll('.redis-key')].find(b=>b.title===\(encoded));
            if(!row||row.disabled)return false;row.scrollIntoView({block:'nearest'});
            const r=row.getBoundingClientRect(),w=document.querySelector('.redis-workspace').getBoundingClientRect();
            if(getComputedStyle(row).visibility!=='visible'||r.width<=0||r.left<w.left-1||r.right>innerWidth||r.top<0||r.bottom>innerHeight)return false;
            row.click();return true;})()
            """)
    }
    private static func modalClick(_ content: ContentWindow, _ title: String) async throws {
        try await click(content, title: title, selector: "dialog[open] button")
    }
    static func run(model: WorkspaceModel, open: () async throws -> ContentWindow, lookup: () -> ContentWindow?, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.sshBridge, let path = WorkspaceModel.argument("--redis-smoke-report"),
              let password = ProcessInfo.processInfo.environment["UTERM_NATIVE_REDIS_PASSWORD"],
              let portText = ProcessInfo.processInfo.environment["UTERM_NATIVE_REDIS_PORT"], let port = UInt16(portText) else {
            throw BridgeFailure(code: "REDIS_FIXTURE", message: "Missing isolated Redis QA context")
        }
        func operation(_ params: JSONValue) async throws -> JSONValue {
            let started = try await bridge.call("redis.operation.start", params: params)
            let value = try JSONDecoder().decode(CoreRedisOperation.self, from: JSONEncoder().encode(started))
            for _ in 0..<1000 {
                let response = try await bridge.call("redis.operation.read", params: .object(["id": .string(value.id), "generation": .string(value.generation), "consume": .bool(true)]))
                if response["state"] == .string("completed") { return response["result"] }
                if response["state"] == .string("failed") {
                    let code = response["error"].string ?? "REDIS_OPERATION_FAILED"
                    throw BridgeFailure(code: code, message: code)
                }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw BridgeFailure(code: "REDIS_OPERATION_TIMEOUT", message: "Redis fixture operation timed out")
        }
        let id = UUID().uuidString
        var config: [String: JSONValue] = ["id": .string(id), "name": .string("Redis Native QA 中文"), "host": .string("127.0.0.1"), "port": .number(Double(port)), "db": .number(0), "username": .string(""), "tls": .bool(false), "ca_file": .string(""), "server_name": .string(""), "ssh_host": .string(""), "credential_id": .null]
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        report["redisFixtureStep"] = "read-profile-snapshot"
        let initial = try await bridge.snapshot()
        report["redisFixtureStep"] = "save-profile"
        guard await model.mutate("redis.profile.save", ["workspaceId": .string(model.groupID), "config": .object(config)], revision: initial.revision) else {
            throw BridgeFailure(code: "REDIS_FIXTURE_SAVE", message: "Queued Redis fixture profile save failed")
        }
        report["redisFixtureProfileUsedApplicationWriteQueue"] = true
        report["redisFixtureStep"] = "open-window"
        await model.reload()
        let content = try await open()
        guard let window = content.window else { throw BridgeFailure(code: "REDIS_WINDOW", message: "Native Redis window missing") }
        var captures: [String] = []
        func capture(_ filename: String) async throws {
            // Wait for WebKit paint submission before capturing WindowServer's composited image.
            // 等待 WebKit 提交绘制后再截取 WindowServer 合成图像。
            _ = try await EditorSmoke.evaluate(content, script: "await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true;", arguments: [:])
            try await Task.sleep(for: .milliseconds(200))
            try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(filename))
            captures.append(filename)
        }
        try await wait(content, "!!document.querySelector('.native-redis .native-database-profile-name')")
        guard try await EditorSmoke.evaluate(content, script: "const b=document.querySelector('.native-redis button[aria-label^=\"Edit Redis\"]');if(!b)return false;b.click();return true;", arguments: [:]) else { throw BridgeFailure(code: "REDIS_PROFILE", message: "Redis edit action unavailable") }
        try await wait(content, "!!document.querySelector('dialog[open] input[type=password]')")
        try await input(content, selector: "dialog[open] input[type=password]", text: password)
        try await input(content, selector: "dialog[open] input", text: "Redis saved 中文")
        try await click(content, title: "Save connection")
        try await wait(content, "!document.querySelector('dialog[open]') && document.querySelector('.native-database-profile-name')?.textContent==='Redis saved 中文'")
        let saved = try await bridge.snapshot()
        let bytes = try JSONEncoder().encode(saved)
        guard !String(decoding: bytes, as: UTF8.self).contains(password) else { throw BridgeFailure(code: "REDIS_PERSISTENCE", message: "Temporary Redis password was persisted") }
        report["nativeRedisProfileSaveWithoutPasswordPersistence"] = true
        try await click(content, title: "Redis saved 中文")
        try await click(content, title: "Connect")
        try await wait(content, "!!document.querySelector('.redis-toolbar input[aria-label=\"Allow editing\"]') && !!document.querySelector('.redis-key')")
        try await wait(content, "document.querySelector('.redis-toolbar input[aria-label=\"Allow editing\"]').checked===false")
        report["nativeRedisRealConnectionDefaultsReadonly"] = true
        let reference = try await operation(.object(["kind": .string("credential"), "config": .object(config), "password": .string(password), "remove": .bool(false)]))
        guard reference.string != nil else { throw BridgeFailure(code: "REDIS_CREDENTIAL_TEST", message: "System credential reference is missing") }
        var savedCredential = config; savedCredential["credential_id"] = reference
        var credentialHandle: JSONValue = .null
        do {
            let authenticated = try await operation(.object(["kind": .string("connect"), "config": .object(savedCredential), "password": .null]))
            credentialHandle = authenticated["handle"]
            let ping = try await operation(.object(["kind": .string("request"), "handle": credentialHandle, "request": .object(["op": .string("console"), "args": .array([.string("PING")])])]))
            guard ping["result"] == .string("PONG") else { throw BridgeFailure(code: "REDIS_CREDENTIAL_TEST", message: "Stored OS credential did not authenticate") }
            var changedTarget = savedCredential; changedTarget["host"] = .string("127.0.0.2")
            do {
                let unexpected = try await operation(.object(["kind": .string("connect"), "config": .object(changedTarget), "password": .null]))
                _ = try await operation(.object(["kind": .string("disconnect"), "handle": unexpected["handle"]]))
                throw BridgeFailure(code: "REDIS_CREDENTIAL_TEST", message: "Changed target accepted a stored credential")
            } catch let error as BridgeFailure where error.code == "REDIS_CREDENTIAL_TARGET_CHANGED" {}
            _ = try await operation(.object(["kind": .string("disconnect"), "handle": credentialHandle])); credentialHandle = .null
        } catch {
            if credentialHandle != .null { _ = try? await operation(.object(["kind": .string("disconnect"), "handle": credentialHandle])) }
            _ = try? await operation(.object(["kind": .string("credential"), "config": .object(savedCredential), "password": .null, "remove": .bool(true)]))
            throw error
        }
        _ = try await operation(.object(["kind": .string("credential"), "config": .object(savedCredential), "password": .null, "remove": .bool(true)]))
        do {
            let unexpected = try await operation(.object(["kind": .string("connect"), "config": .object(savedCredential), "password": .null]))
            _ = try await operation(.object(["kind": .string("disconnect"), "handle": unexpected["handle"]]))
            throw BridgeFailure(code: "REDIS_CREDENTIAL_TEST", message: "Removed OS credential remained usable")
        } catch let error as BridgeFailure where error.code == "REDIS_CREDENTIAL_MISSING" {}
        report["nativeRedisOSCredentialBinding"] = true
        guard try await EditorSmoke.evaluate(content, script: "const b=document.querySelector('.redis-key[title=\"00 ff 6b 65 79\"]');if(!b)return false;b.click();return true;", arguments: [:]) else { throw BridgeFailure(code: "REDIS_BINARY_KEY", message: "Binary Redis key identity unavailable") }
        try await wait(content, "document.querySelector('.redis-binary-preview')?.textContent.includes('ff 00 7f') && !document.querySelector('.redis-detail .cm-content[contenteditable=true]')")
        report["nativeRedisBinaryIdentityAndReadonlyPreview"] = true
        try await capture("native-redis-binary-en-dark.png")
        guard try await EditorSmoke.evaluate(content, script: "const b=document.querySelector('.redis-key[title=\"native:中文\"]');if(!b)return false;b.click();return true;", arguments: [:]) else { throw BridgeFailure(code: "REDIS_TEXT_KEY", message: "Unicode Redis key unavailable") }
        try await wait(content, "document.querySelector('.redis-detail .cm-content')?.textContent==='9223372036854775807 中文🚀'")
        guard try await EditorSmoke.evaluate(content, script: "const b=document.querySelector('.redis-toolbar input[aria-label=\"Allow editing\"]');if(!b||b.disabled)return false;b.click();return true;", arguments: [:]) else { throw BridgeFailure(code: "REDIS_WRITE_SWITCH", message: "Redis write permission action unavailable") }
        try await wait(content, "!!document.querySelector('.redis-detail .cm-content[contenteditable=true]')")
        let edited = "NATIVE_REDIS_SAVED_9223372036854775807 中文🚀"
        try await EditorSmoke.replace(content, text: edited)
        try await wait(content, "!!document.querySelector('.redis-dirty')")
        try await click(content, title: "Disconnect")
        try await wait(content, "!!document.querySelector('dialog[open]')")
        try await modalClick(content, "Cancel")
        try await wait(content, "!document.querySelector('dialog[open]') && document.querySelector('.redis-detail .cm-content')?.textContent==='NATIVE_REDIS_SAVED_9223372036854775807 中文🚀' && document.querySelector('.redis-toolbar input[aria-label=\"Allow editing\"]')?.checked===true")
        report["nativeRedisCancelledDisconnectKeepsDraft"] = true
        let quitImage = "native-redis-quit-cancel.png"
        let quitDriver = QuitCancellation(path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(quitImage))
        quitDriver.start()
        defer { quitDriver.stop() }
        NSApp.terminate(nil)
        for _ in 0..<100 {
            if quitDriver.clicked && model.error.contains("QUIT_REFUSED") { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        guard quitDriver.clicked, quitDriver.captured, model.error.contains("QUIT_REFUSED") else { throw BridgeFailure(code: "REDIS_QUIT", message: "Actual native quit cancellation was not observed") }
        captures.append(quitImage)
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        try await wait(content, "document.querySelector('.native-redis')?.inert===false && document.querySelector('.redis-detail .cm-content')?.textContent==='NATIVE_REDIS_SAVED_9223372036854775807 中文🚀' && document.querySelector('.redis-toolbar input[aria-label=\"Allow editing\"]')?.checked===true")
        let afterQuit = try await bridge.call("redis.status")
        guard afterQuit["dirty"] == .bool(true), afterQuit["connected"] == .bool(true), afterQuit["quitting"] == .bool(false) else { throw BridgeFailure(code: "REDIS_QUIT", message: "Cancelled quit lost the Redis draft guard") }
        report["nativeRedisCancelledApplicationQuitKeepsDraft"] = true
        model.error = ""
        try await capture("native-redis-draft-en-dark.png")
        window.performClose(nil)
        guard !window.isVisible, lookup() === content else { throw BridgeFailure(code: "REDIS_DETACH", message: "Redis window close discarded its application-lived controller") }
        let reopened = try await open()
        guard reopened === content else { throw BridgeFailure(code: "REDIS_DETACH", message: "Redis window was recreated") }
        try await wait(content, "document.querySelector('.redis-detail .cm-content')?.textContent==='NATIVE_REDIS_SAVED_9223372036854775807 中文🚀'")
        report["nativeRedisHiddenWindowRetainsDraftAndConnection"] = true
        try await click(content, title: "Save")
        try await wait(content, "!document.querySelector('.redis-dirty')")
        config["name"] = .string("Redis saved 中文")
        let probe = try await operation(.object(["kind": .string("connect"), "config": .object(config), "password": .string(password)]))
        let handle = probe["handle"]
        let text = try await operation(.object(["kind": .string("request"), "handle": handle, "request": .object(["op": .string("read"), "key": .string(Data("native:中文".utf8).base64EncodedString()), "field": .null, "cursor": .string("0"), "offset": .number(0), "pattern": .string("*")])]))
        guard text["value"]["text"] == .string(edited), case .number(let ttl) = text["ttl"], ttl > 0 else { throw BridgeFailure(code: "REDIS_WRITE_RESULT", message: "Native Redis save lost exact text or TTL") }
        let binary = try await operation(.object(["kind": .string("request"), "handle": handle, "request": .object(["op": .string("read"), "key": .string("AP9rZXk="), "field": .null, "cursor": .string("0"), "offset": .number(0), "pattern": .string("*")])]))
        guard binary["value"]["data"] == .string("/wB/") else { throw BridgeFailure(code: "REDIS_BINARY_RESULT", message: "Native Redis operation changed the binary value") }
        report["nativeRedisWritePreservesExactTextTTLAndBinarySibling"] = true
        func inspect(_ request: [String: JSONValue]) async throws -> JSONValue {
            try await operation(.object(["kind": .string("request"), "handle": handle, "request": .object(request)]))
        }
        func list(_ offset: Int, key: String = "qa:paged") async throws -> JSONValue {
            try await inspect(["op": .string("read"), "key": .string(Data(key.utf8).base64EncodedString()), "field": .null, "cursor": .string("0"), "offset": .number(Double(offset)), "pattern": .string("*")])
        }
        try await selectKey(content, "qa:large")
        try await wait(content, "document.querySelectorAll('.redis-members tbody tr').length===200 && document.querySelector('.redis-members tbody td')?.textContent==='0'")
        try await click(content, title: "Next page")
        try await wait(content, "document.querySelectorAll('.redis-members tbody tr').length===200 && document.querySelector('.redis-members tbody td')?.textContent==='200'")
        let large = try await list(200, key: "qa:large")
        guard large["size"] == .number(20001), large["items"].array.count == 200, large["version"] == .null else { throw BridgeFailure(code: "REDIS_PAGING", message: "Large list page exceeded its bounds or edit limit") }
        guard try await EditorSmoke.evaluate(content, script: "const buttons=[...document.querySelectorAll('.redis-members button')].filter(b=>['Edit member','Delete member'].includes(b.textContent.trim()));return buttons.length===400&&buttons.every(b=>b.disabled);", arguments: [:]) else { throw BridgeFailure(code: "REDIS_PAGING", message: "Large list edit controls bypassed the snapshot limit") }
        report["nativeRedisLargeListBoundsAndReadOnlyLimit"] = true
        report["nativeRedisLargeListRenderedRows"] = 200
        report["nativeRedisLargeListMembers"] = 20001
        try await capture("native-redis-list-pages.png")
        try await selectKey(content, "qa:paged")
        try await wait(content, "document.querySelectorAll('.redis-members tbody tr').length===200 && document.querySelector('.redis-members tbody td')?.textContent==='0'")
        try await click(content, title: "Next page")
        try await wait(content, "document.querySelectorAll('.redis-members tbody tr').length===200 && document.querySelector('.redis-members tbody td')?.textContent==='200'")
        let paged = try await list(200)
        guard paged["size"] == .number(401) else { throw BridgeFailure(code: "REDIS_PAGING", message: "List fixture size differs") }
        try await click(content, title: "Next page")
        try await wait(content, "document.querySelectorAll('.redis-members tbody tr').length===1 && document.querySelector('.redis-members tbody td')?.textContent==='400'")
        try await click(content, title: "Delete member")
        try await wait(content, "!!document.querySelector('.redis-action-dialog[open]')")
        try await modalClick(content, "Cancel")
        try await wait(content, "!document.querySelector('dialog[open]')")
        let retained = try await list(400)
        guard retained["size"] == .number(401), retained["items"].array.first?["text"] == .string("QA_ROW_0400 中文") else { throw BridgeFailure(code: "REDIS_CANCEL", message: "Cancelled list deletion changed server data") }
        try await click(content, title: "Delete member")
        try await wait(content, "!!document.querySelector('.redis-action-dialog[open]')")
        try await modalClick(content, "Confirm")
        try await wait(content, "!document.querySelector('dialog[open]') && document.querySelectorAll('.redis-members tbody tr').length===200 && document.querySelector('.redis-members tbody td')?.textContent==='200'")
        let shortened = try await list(200)
        guard shortened["size"] == .number(400), shortened["items"].array.last?["text"] == .string("QA_ROW_0399 中文") else { throw BridgeFailure(code: "REDIS_DELETE", message: "List deletion changed the wrong position") }
        try await click(content, title: "TTL", selector: ".redis-value-heading button", prefix: true)
        try await wait(content, "!!document.querySelector('.redis-action-dialog[open]')")
        try await input(content, selector: ".redis-action-dialog[open] input[aria-label=\"TTL (seconds)\"]", text: "1800")
        try await Task.sleep(for: .milliseconds(100))
        try await modalClick(content, "Confirm")
        try await wait(content, "!document.querySelector('dialog[open]')")
        let expiring = try await list(0)
        guard case .number(let expiry) = expiring["ttl"], expiry > 0, expiry <= 1800000 else { throw BridgeFailure(code: "REDIS_TTL", message: "GUI TTL did not reach Redis") }
        try await selectKey(content, "qa:delete")
        func reviewDelete() async throws {
            guard try await EditorSmoke.evaluate(content, script: "const s=document.querySelector('.redis-value-heading details summary');if(!s)return false;s.click();return true;", arguments: [:]) else { throw BridgeFailure(code: "REDIS_DELETE", message: "Key action menu is missing") }
            try await click(content, title: "Delete key")
            try await wait(content, "!!document.querySelector('.redis-action-dialog[open]')")
        }
        try await reviewDelete(); try await modalClick(content, "Cancel")
        try await wait(content, "!document.querySelector('dialog[open]')")
        let preserved = try await inspect(["op": .string("console"), "args": .array([.string("EXISTS"), .string("qa:delete")])])
        guard preserved["result"] == .number(1) else { throw BridgeFailure(code: "REDIS_CANCEL", message: "Cancelled key deletion changed server data") }
        try await reviewDelete(); try await modalClick(content, "Confirm")
        try await wait(content, "!document.querySelector('dialog[open]') && !document.querySelector('.redis-key[title=\"qa:delete\"]')")
        let removed = try await inspect(["op": .string("console"), "args": .array([.string("EXISTS"), .string("qa:delete")])])
        guard removed["result"] == .number(0) else { throw BridgeFailure(code: "REDIS_DELETE", message: "Reviewed key was not deleted") }
        try await selectKey(content, "qa:paged")
        try await wait(content, "document.querySelectorAll('.redis-members tbody tr').length===200 && document.querySelector('.redis-members tbody td')?.textContent==='0'")
        try await click(content, title: "Next page")
        try await wait(content, "document.querySelectorAll('.redis-members tbody tr').length===200 && document.querySelector('.redis-members tbody td')?.textContent==='200'")
        try await capture("native-redis-protected-mutations.png")
        report["nativeRedisPagedListAndProtectedMutations"] = true
        _ = try await operation(.object(["kind": .string("disconnect"), "handle": handle]))
        await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
        window.setContentSize(NSSize(width: 760, height: 620))
        try await wait(content, "document.documentElement.lang==='zh-Hans' && document.documentElement.dataset.appearance==='light' && document.querySelector('.native-database-toolbar')?.textContent.includes('Redis 连接')")
        try await capture("native-redis-zh-light-narrow.png")
        report["nativeRedisThemeLanguageAndNarrowLayout"] = true
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        try await wait(content, "document.documentElement.lang==='en'")
        try await click(content, title: "Reconnect")
        try await wait(content, "document.querySelector('.redis-toolbar input[aria-label=\"Allow editing\"]')?.checked===false && !!document.querySelector('.redis-key')")
        report["nativeRedisTemporaryPasswordSurvivesReconnect"] = true
        try await click(content, title: "Disconnect")
        report["nativeRedisCaptures"] = captures
        report["nativeRedisManualPickerAcceptance"] = false
        report["nativeRedisManualInteractionAcceptance"] = false
        content.forceClose()
    }
}
