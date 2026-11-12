import AppKit
import WebKit
import UTermBridge

@MainActor
enum DatabaseSmoke {
    private static func wait(_ content: ContentWindow, _ script: String, allowError: Bool = false) async throws {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if !content.navigationError.isEmpty { throw BridgeFailure(code: "DB_NAVIGATION", message: "Database navigation failed") }
            if !allowError, let text = try? await content.webView.evaluateJavaScript("document.querySelector('[role=alert]')?.textContent || ''"), let error = text as? String, !error.isEmpty {
                throw BridgeFailure(code: "DB_SCENE", message: error)
            }
            if let value = try? await content.webView.evaluateJavaScript(script), value as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(40))
        }
        // DOM snapshots can include password input attributes; report only the failed scene code.
        // DOM 快照可能包含密码输入属性，因此仅报告失败场景代码。
        throw BridgeFailure(code: "DB_SCENE_TIMEOUT", message: "Native database scene did not complete")
    }
    private static func input(_ content: ContentWindow, selector: String, value: String) async throws {
        let accepted = try await EditorSmoke.evaluate(content, script: """
            const input=document.querySelector(selector);
            if(!input) return false;
            const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));return true;
            """, arguments: ["selector": selector, "value": value])
        guard accepted else { throw BridgeFailure(code: "DB_INPUT", message: "Native database input is missing") }
    }
    private static func waitForSQLInput(_ content: ContentWindow) async throws {
        // A connection handle precedes catalog loading; wait for enabled controls and the painted editor.
        // 连接句柄早于目录加载返回；等待控件启用且编辑器实际显示后再输入。
        try await wait(content, """
            (() => {
                const disconnect=[...document.querySelectorAll('.database-connection-bar button')].find(b=>b.textContent.trim()==='Disconnect');
                const execute=document.querySelector('.database-run');
                const editor=document.querySelector('.database-sql-editor:not([hidden]) .cm-content[contenteditable=true]');
                if(!disconnect || disconnect.disabled || !execute || execute.disabled || !editor) return false;
                const bounds=editor.getBoundingClientRect();
                return bounds.width>0 && bounds.height>0 && getComputedStyle(editor).visibility==='visible';
            })()
            """)
    }
    static func run(model: WorkspaceModel, open: () async throws -> ContentWindow, lookup: () -> ContentWindow?, report: inout [String: Any]) async throws {
        guard model.ready, let bridge = model.sshBridge, let path = WorkspaceModel.argument("--database-smoke-report"),
              let driver = ProcessInfo.processInfo.environment["UTERM_NATIVE_DATABASE_DRIVER"],
              let portText = ProcessInfo.processInfo.environment["UTERM_NATIVE_DATABASE_PORT"], let port = UInt16(portText),
              let password = ProcessInfo.processInfo.environment["UTERM_NATIVE_DATABASE_PASSWORD"] else {
            throw BridgeFailure(code: "DB_FIXTURE", message: "Missing isolated PostgreSQL QA context")
        }
        func operation(_ params: JSONValue) async throws -> JSONValue {
            let started = try await bridge.call("database.operation.start", params: params)
            for _ in 0..<1000 {
                let value = try await bridge.call("database.operation.read", params: .object(["id": started["id"], "generation": started["generation"], "consume": .bool(true)]))
                if value["state"] == .string("completed") { return value["result"] }
                if let error = value["error"].string { throw BridgeFailure(code: error, message: error) }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw BridgeFailure(code: "DB_OPERATION_TIMEOUT", message: "Database fixture operation timed out")
        }
        _ = try await operation(.object(["kind": .string("components"), "action": .string("import"), "id": .string("postgresql"), "path": .string(driver)]))
        let id = UUID().uuidString
        let name = "PostgreSQL Native QA 中文"
        let config: JSONValue = .object(["id": .string(id), "name": .string(name), "kind": .string("postgresql"), "host": .string("127.0.0.1"), "port": .number(Double(port)), "database": .string("uterm_qa"), "username": .string("uterm_qa"), "tls": .bool(false), "ca_file": .string(""), "credential_id": .null])
        let snapshot = try await bridge.snapshot()
        _ = try await bridge.call("database.profile.save", params: .object(["expectedRevision": .string(snapshot.revision), "workspaceId": .string(model.groupID), "config": config]))
        await model.reload()
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        let content = try await open()
        guard let native = content.window else { throw BridgeFailure(code: "DB_WINDOW", message: "Missing native database window") }
        var captures: [String] = []
        func capture(_ name: String) async throws {
            // Wait for WebKit paint submission before capturing WindowServer's composited image.
            // 等待 WebKit 提交绘制后再截取 WindowServer 合成图像。
            _ = try await EditorSmoke.evaluate(content, script: "await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true;", arguments: [:])
            try await Task.sleep(for: .milliseconds(200))
            try await TerminalSmoke.capture(window: native, path: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name))
            captures.append(name)
        }
        try await wait(content, "document.querySelector('.native-database-profile-name')?.textContent === 'PostgreSQL Native QA 中文'")
        let components = NativeDatabaseComponentsModel(workspace: model)
        components.startObserving()
        defer { components.stopObserving() }
        await components.refresh()
        guard components.error.isEmpty else { throw BridgeFailure(code: "DB_COMPONENT_SETTINGS", message: "Could not read shared component status") }
        guard try await EditorSmoke.evaluate(content, script: "window.__qaComponentEvents=0;window.addEventListener('uterm-content-event',event=>{if(event.detail.kind==='database-components-changed')window.__qaComponentEvents++});return true;", arguments: [:]) else { throw BridgeFailure(code: "DB_COMPONENT_SETTINGS", message: "Could not observe actual WebKit component events") }
        let beforeEvents = components.receivedComponentEvents
        _ = try await operation(.object(["kind": .string("components"), "action": .string("import"), "id": .string("postgresql"), "path": .string(driver)]))
        try await TerminalSmoke.wait("Deliver component events to native settings and the existing workbench") { components.receivedComponentEvents > beforeEvents }
        try await wait(content, "window.__qaComponentEvents>0")
        report["sharedComponentEventsReachSettingsAndWorkbench"] = true
        guard try await EditorSmoke.evaluate(content, script: "const button=document.querySelector('.native-database-profile button[aria-label^=\"Edit database\"]');if(!button)return false;button.click();return true;", arguments: [:]) else { throw BridgeFailure(code: "DB_PROFILE", message: "Edit database profile action missing") }
        try await wait(content, "!!document.querySelector('dialog[open] input[type=password]')")
        try await input(content, selector: "dialog[open] input[type=password]", value: password)
        try await input(content, selector: "dialog[open] input", value: "PostgreSQL saved 中文")
        try await EditorSmoke.click(content, title: "Save connection")
        try await wait(content, "!document.querySelector('dialog[open]') && document.querySelector('.native-database-profile-name')?.textContent==='PostgreSQL saved 中文'")
        let saved = try await bridge.snapshot()
        var storedProfile: JSONValue?
        for group in saved.document.workspace["groups"].array {
            for profile in group["databaseConnections"].array {
                if profile["id"].string == id { storedProfile = profile }
            }
        }
        guard let storedProfile, storedProfile["name"].string == "PostgreSQL saved 中文" else {
            throw BridgeFailure(code: "DB_PERSISTENCE", message: "Native profile save did not persist its name")
        }
        guard storedProfile["credential_id"] == .null else {
            throw BridgeFailure(code: "DB_PERSISTENCE", message: "Temporary password unexpectedly produced a stored credential")
        }
        let savedBytes = try JSONEncoder().encode(saved)
        guard !String(decoding: savedBytes, as: UTF8.self).contains(password) else {
            throw BridgeFailure(code: "DB_PERSISTENCE", message: "Temporary password appeared in the saved snapshot")
        }
        report["nativeProfileSaveWithoutPasswordPersistence"] = true
        try await EditorSmoke.click(content, title: "PostgreSQL saved 中文")
        try await EditorSmoke.click(content, title: "Connect")
        try await waitForSQLInput(content)
        report["nativeRealPostgresqlConnection"] = true
        report["nativeSQLInputWaitedForReadyControls"] = true
        let sql = "SELECT 9223372036854775807::bigint AS exact_integer, 12345678901234567890.1234567890::numeric(30,10) AS exact_decimal, 'NATIVE_DATABASE_中文'::text AS text_value"
        try await EditorSmoke.replace(content, text: sql)
        let inputDeadline = Date().addingTimeInterval(5)
        var copied = false
        while Date() < inputDeadline {
            try await EditorSmoke.click(content, title: "Copy SQL")
            if NSPasteboard.general.string(forType: .string) == sql { copied = true; break }
            try await Task.sleep(for: .milliseconds(40))
        }
        guard copied else { throw BridgeFailure(code: "DB_INPUT_SYNC", message: "The SQL toolbar did not copy the actual edited query") }
        report["nativeSQLClipboardMatchesEditedQuery"] = true
        try await EditorSmoke.click(content, title: "Execute SQL")
        try await wait(content, "document.querySelector('.database-grid-container')?.textContent.includes('9223372036854775807') && document.querySelector('.database-grid-container')?.textContent.includes('12345678901234567890.1234567890')")
        report["nativeExactBigintDecimalAndUnicode"] = true
        try await capture("native-database-sql-dark-en.png")
        native.performClose(nil)
        guard !native.isVisible, lookup() === content else { throw BridgeFailure(code: "DB_DETACH", message: "Closing database window lost its application-lived controller") }
        let reopened = try await open()
        guard reopened === content else { throw BridgeFailure(code: "DB_DETACH", message: "Database window was recreated") }
        try await wait(content, "document.querySelector('.database-grid-container')?.textContent.includes('NATIVE_DATABASE_中文')")
        report["hiddenWindowRetainedConnectionDraftAndResult"] = true
        let blocked = try await bridge.call("database.status")
        guard blocked["connected"] == .bool(true), blocked["dirty"] == .bool(true) else { throw BridgeFailure(code: "DB_GUARD", message: "Active connection/draft protection missing") }
        do {
            let current = try await bridge.snapshot()
            _ = try await bridge.call("database.profile.remove", params: .object(["expectedRevision": .string(current.revision), "workspaceId": .string(model.groupID), "id": .string(id)]))
            throw BridgeFailure(code: "DB_GUARD", message: "Active profile removal was accepted")
        } catch let error as BridgeFailure where error.code == "DB_BUSY" { report["nativeActiveProfileMutationRefused"] = true }
        try await EditorSmoke.click(content, title: "Disconnect")
        try await wait(content, "!![...document.querySelectorAll('.database-connection-bar button')].find(b=>b.textContent.trim()==='Connect')")
        try await EditorSmoke.click(content, title: "Connect")
        try await waitForSQLInput(content)
        report["temporaryPasswordSurvivedWindowHideAndReconnect"] = true
        try await EditorSmoke.click(content, title: "Execute SQL")
        try await wait(content, "document.querySelector('.database-grid-container')?.textContent.includes('9223372036854775807')")
        await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
        native.setContentSize(NSSize(width: 760, height: 620))
        try await wait(content, "document.documentElement.lang==='zh-Hans' && document.documentElement.dataset.appearance==='light' && document.querySelector('.native-database-toolbar')?.textContent.includes('数据库连接')")
        try await capture("native-database-sql-light-zh-narrow.png")
        report["nativeDatabaseThemeLanguageAndNarrowLayout"] = true
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        native.setContentSize(NSSize(width: 1080, height: 720))
        try await wait(content, "document.documentElement.lang==='en'")
        try await EditorSmoke.click(content, title: "Disconnect")
        try await wait(content, "!![...document.querySelectorAll('.database-connection-bar button')].find(b=>b.textContent.trim()==='Connect' && !b.disabled)")
        var status = try await bridge.call("database.status")
        let disconnectDeadline = Date().addingTimeInterval(10)
        while (status["connected"] != .bool(false) || status["busy"] != .bool(false)) && Date() < disconnectDeadline {
            try await Task.sleep(for: .milliseconds(50))
            status = try await bridge.call("database.status")
        }
        report["databaseDisconnectStatus"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(status))
        guard status["connected"] == .bool(false), status["busy"] == .bool(false) else { throw BridgeFailure(code: "DB_CLEANUP", message: "Database work remained after disconnect") }
        let sidebarCapture = "native-database-sidebar-profile-en-dark.png"
        try await NativeChromeSmoke.selectConnection(model: model, name: name, category: "database", capture: URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(sidebarCapture))
        try await wait(content, "document.querySelector('.native-database-profile-name[aria-pressed=true]') !== null")
        report["databaseSidebarSelectionProof"] = ["actualAppKitRow": true, "selectedTarget": true, "capture": sidebarCapture]
        captures.append(sidebarCapture)
        report["nativeDatabaseCaptures"] = captures
        report["databaseService"] = "Real isolated PostgreSQL"
        report["nativeManualPickerAcceptance"] = false
        report["nativeDocumentDatabaseAcceptance"] = false
        report["nativeManualInteractionAcceptance"] = false
        content.forceClose()
    }
}
