import AppKit
import UTermBridge

@MainActor
enum RedisSmoke {
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
        let initial = try await bridge.snapshot()
        _ = try await bridge.call("redis.profile.save", params: .object(["expectedRevision": .string(initial.revision), "workspaceId": .string(model.groupID), "config": .object(config)]))
        await model.reload()
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        let content = try await open()
        guard let window = content.window else { throw BridgeFailure(code: "REDIS_WINDOW", message: "Native Redis window missing") }
        var captures: [String] = []
        func capture(_ filename: String) async throws {
            try await TerminalSmoke.capture(window: window, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(filename))
            captures.append(filename)
        }
        try await wait(content, "!!document.querySelector('.native-redis .native-database-profile-name')")
        guard try await EditorSmoke.evaluate(content, script: "const b=document.querySelector('.native-redis button[aria-label^=\"Edit Redis\"]');if(!b)return false;b.click();return true;", arguments: [:]) else { throw BridgeFailure(code: "REDIS_PROFILE", message: "Redis edit action unavailable") }
        try await wait(content, "!!document.querySelector('dialog[open] input[type=password]')")
        try await input(content, selector: "dialog[open] input[type=password]", text: password)
        try await input(content, selector: "dialog[open] input", text: "Redis saved 中文")
        try await EditorSmoke.click(content, title: "Save connection")
        try await wait(content, "!document.querySelector('dialog[open]') && document.querySelector('.native-database-profile-name')?.textContent==='Redis saved 中文'")
        let saved = try await bridge.snapshot()
        let bytes = try JSONEncoder().encode(saved)
        guard !String(decoding: bytes, as: UTF8.self).contains(password) else { throw BridgeFailure(code: "REDIS_PERSISTENCE", message: "Temporary Redis password was persisted") }
        report["nativeRedisProfileSaveWithoutPasswordPersistence"] = true
        try await EditorSmoke.click(content, title: "Redis saved 中文")
        try await EditorSmoke.click(content, title: "Connect")
        try await wait(content, "!!document.querySelector('.redis-toolbar input[aria-label=\"Allow editing\"]') && !!document.querySelector('.redis-key')")
        try await wait(content, "document.querySelector('.redis-toolbar input[aria-label=\"Allow editing\"]').checked===false")
        report["nativeRedisRealConnectionDefaultsReadonly"] = true
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
        try await capture("native-redis-draft-en-dark.png")
        window.performClose(nil)
        guard !window.isVisible, lookup() === content else { throw BridgeFailure(code: "REDIS_DETACH", message: "Redis window close discarded its application-lived controller") }
        let reopened = try await open()
        guard reopened === content else { throw BridgeFailure(code: "REDIS_DETACH", message: "Redis window was recreated") }
        try await wait(content, "document.querySelector('.redis-detail .cm-content')?.textContent==='NATIVE_REDIS_SAVED_9223372036854775807 中文🚀'")
        report["nativeRedisHiddenWindowRetainsDraftAndConnection"] = true
        try await EditorSmoke.click(content, title: "Save")
        try await wait(content, "!document.querySelector('.redis-dirty')")
        config["name"] = .string("Redis saved 中文")
        let probe = try await operation(.object(["kind": .string("connect"), "config": .object(config), "password": .string(password)]))
        let handle = probe["handle"]
        let text = try await operation(.object(["kind": .string("request"), "handle": handle, "request": .object(["op": .string("read"), "key": .string(Data("native:中文".utf8).base64EncodedString()), "field": .null, "cursor": .string("0"), "offset": .number(0), "pattern": .string("*")])]))
        guard text["value"]["text"] == .string(edited), case .number(let ttl) = text["ttl"], ttl > 0 else { throw BridgeFailure(code: "REDIS_WRITE_RESULT", message: "Native Redis save lost exact text or TTL") }
        let binary = try await operation(.object(["kind": .string("request"), "handle": handle, "request": .object(["op": .string("read"), "key": .string("AP9rZXk="), "field": .null, "cursor": .string("0"), "offset": .number(0), "pattern": .string("*")])]))
        guard binary["value"]["data"] == .string("/wB/") else { throw BridgeFailure(code: "REDIS_BINARY_RESULT", message: "Native Redis operation changed the binary value") }
        _ = try await operation(.object(["kind": .string("disconnect"), "handle": handle]))
        report["nativeRedisWritePreservesExactTextTTLAndBinarySibling"] = true
        await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
        window.setContentSize(NSSize(width: 760, height: 620))
        try await wait(content, "document.documentElement.lang==='zh-Hans' && document.documentElement.dataset.appearance==='light' && document.querySelector('.native-database-toolbar')?.textContent.includes('Redis 连接')")
        try await capture("native-redis-zh-light-narrow.png")
        report["nativeRedisThemeLanguageAndNarrowLayout"] = true
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        try await wait(content, "document.documentElement.lang==='en'")
        try await EditorSmoke.click(content, title: "Disconnect")
        try await wait(content, "!!document.querySelector('.redis-toolbar input[aria-label=\"Temporary password\"]')")
        try await EditorSmoke.click(content, title: "Connect")
        try await wait(content, "!!document.querySelector('.redis-toolbar input[aria-label=\"Allow editing\"]')")
        report["nativeRedisTemporaryPasswordSurvivesReconnect"] = true
        try await EditorSmoke.click(content, title: "Disconnect")
        report["nativeRedisCaptures"] = captures
        report["nativeRedisManualPickerAcceptance"] = false
        report["nativeRedisManualInteractionAcceptance"] = false
        content.forceClose()
    }
}
