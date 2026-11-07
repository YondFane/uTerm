import AppKit
import UTermBridge

@MainActor
enum UpdateQuitGuardSmoke {
    private final class KeepTransferOpen {
        private var timer: Timer?
        private var deadline = Date().addingTimeInterval(10)
        private(set) var clicked = false
        func start() {
            let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            self.timer = timer
            RunLoop.main.add(timer, forMode: .modalPanel)
        }
        func stop() { timer?.invalidate(); timer = nil }
        private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { views($0) } }
        private func tick() {
            guard Date() < deadline else {
                stop()
                if NSApp.modalWindow != nil { NSApp.stopModal(withCode: .abort) }
                return
            }
            guard let root = NSApp.modalWindow?.contentView,
                  let button = views(root).compactMap({ $0 as? NSButton }).first(where: { $0.title == "Keep window open" && $0.isEnabled }) else { return }
            clicked = true; stop(); button.performClick(nil)
        }
    }

    static func run(model: WorkspaceModel, window: NSWindow, openSSH: () async throws -> SSHWindow,
                    openDatabase: () async throws -> ContentWindow, attemptQuit: () -> Void, evidence: URL) async throws -> [String: Any] {
        guard let bridge = model.bridge, let terminal = model.selectedTerminal, let generation = terminal.generation else { throw BridgeFailure(code: "UPDATE_QUIT_GUARD", message: "Missing retained fixture PTY") }
        let initialHost = try await bridge.call("host.status")
        let ssh = try await openSSH()
        defer { ssh.model.busy = false; ssh.model.active = nil }
        var captures: [String] = []
        for state in ["running", "cancelled"] {
            let value: JSONValue = .object(["id": .string(UUID().uuidString), "generation": .string(UUID().uuidString),
                "kind": .string("files.transfer"), "state": .string(state), "progress": .object([
                    "name": .string("Explicit simulated update transfer"), "completed": .string("1"), "total": .string("1024")])])
            ssh.model.active = try JSONDecoder().decode(CoreSshOperation.self, from: JSONEncoder().encode(value))
            ssh.model.busy = true; model.error = ""
            let driver = KeepTransferOpen(); driver.start()
            attemptQuit()
            do {
                try await TerminalSmoke.wait("Refuse update termination while simulated transfer worker remains") { model.error.contains("SSH operation") }
                guard driver.clicked, ssh.model.busy, model.ready else { throw BridgeFailure(code: "UPDATE_TRANSFER_GUARD", message: "Native transfer refusal bypassed the real Keep window open control") }
            } catch { driver.stop(); throw error }
            driver.stop()
            window.makeKeyAndOrderFront(nil)
            let name = "native-update-transfer-" + state + "-protected.png"
            try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent(name)); captures.append(name)
        }
        ssh.model.busy = false; ssh.model.active = nil
        await ssh.forceClose()
        guard let fixturePath = ProcessInfo.processInfo.environment["UTERM_QA_DATABASE_FIXTURE"] else { throw BridgeFailure(code: "UPDATE_DATABASE_FIXTURE", message: "Missing owned PostgreSQL fixture") }
        let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: URL(fileURLWithPath: fixturePath)))
        let content = try await openDatabase()
        guard let host = content.workbenchHost as? DatabaseHost else { throw BridgeFailure(code: "UPDATE_DATABASE_GUARD", message: "Missing real database window host") }
        _ = try await host.execute("database_components", params: ["action": .string("install"), "id": .string("postgresql")])
        let config: JSONValue = .object(["id": .string(UUID().uuidString), "name": .string("Update guard PostgreSQL"), "kind": .string("postgresql"),
            "host": .string("127.0.0.1"), "port": fixture["port"], "database": .string("uterm_qa"), "username": .string("uterm_qa"),
            "tls": .bool(false), "ca_file": .string(""), "credential_id": .null])
        let connection = try await host.execute("database_connect", params: ["config": config, "password": fixture["password"]])
        func request(_ value: JSONValue) async throws -> JSONValue {
            try await host.execute("database_request", params: ["handle": connection["handle"], "request": value])
        }
        func refuse(_ scenario: String) async throws {
            model.error = ""; attemptQuit()
            try await TerminalSmoke.wait("Refuse update termination during actual database " + scenario) { model.error.contains("database operations") }
            guard model.ready, !content.isPreparedForQuit else { throw BridgeFailure(code: "UPDATE_DATABASE_GUARD", message: "Native quit prepared an active database") }
            window.makeKeyAndOrderFront(nil)
            let name = "native-update-database-" + scenario + "-protected.png"
            try await TerminalSmoke.capture(window: window, path: evidence.appendingPathComponent(name)); captures.append(name)
        }
        do {
            let query = Task { @MainActor in try await request(.object(["op": .string("query"), "sql": .string("SELECT pg_sleep(8)"), "offset": .number(0)])) }
            try await Task.sleep(for: .milliseconds(250))
            do { try await refuse("query") }
            catch { _ = try? await query.value; throw error }
            _ = try await query.value
            _ = try await request(.object(["op": .string("writable"), "enabled": .bool(true)]))
            _ = try await request(.object(["op": .string("query"), "sql": .string("UPDATE qa_exact SET note='UNCOMMITTED_NATIVE_UPDATE' WHERE id=1"), "offset": .number(0)]))
            try await refuse("transaction")
            _ = try await request(.object(["op": .string("rollback")]))
            _ = try await request(.object(["op": .string("writable"), "enabled": .bool(false)]))
            let result = try await request(.object(["op": .string("query"), "sql": .string("SELECT note FROM qa_exact WHERE id=1"), "offset": .number(0)]))
            guard result["rows"].array.first?.array.first?.string == "ORIGINAL_DATABASE_TEXT" else { throw BridgeFailure(code: "UPDATE_DATABASE_GUARD", message: "Cancelled update did not retain rolled-back data") }
        } catch {
            _ = try? await host.execute("database_disconnect", params: ["handle": connection["handle"], "discard": .bool(true)])
            throw error
        }
        _ = try await host.execute("database_disconnect", params: ["handle": connection["handle"], "discard": .bool(true)])
        guard try await content.prepareForQuit() else { throw BridgeFailure(code: "UPDATE_DATABASE_GUARD", message: "Resolved database window cannot close") }
        content.forceClose(); model.error = ""
        let retainedHost = try await bridge.call("host.status")
        guard retainedHost["pid"] == initialHost["pid"], retainedHost["sessions"].array.contains(where: { $0["spec"]["id"].string == terminal.id && $0["generation"].string == generation }) else { throw BridgeFailure(code: "UPDATE_QUIT_GUARD", message: "Refused update termination replaced the retained host or generation") }
        terminal.enqueue(Data("printf 'GUARD_%s\\n' RETAINED\r".utf8))
        try await TerminalSmoke.wait("Fresh PTY output after refused update termination") { terminal.text.contains("GUARD_RETAINED") }
        return ["simulatedTransferWorkerState": true, "actualKeepWindowOpenButton": true,
            "actualPostgreSQLQueryQuitRefused": true, "actualTransactionQuitRefused": true, "rollbackRetainedOriginalData": true,
            "actualApplicationTerminationDelegate": true, "updateTerminationRequestSimulated": true, "sameHostAndGeneration": true, "captures": captures]
    }
}
