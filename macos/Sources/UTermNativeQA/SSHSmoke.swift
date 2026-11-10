import AppKit
import Darwin
import UTermBridge

@MainActor
enum SSHSmoke {
    private static func waitForRemotePrompt(_ terminal: TerminalSession) async throws {
        // PTY ownership precedes authentication; avoid sending a command into the password handshake.
        // PTY 输入所有权早于认证完成，避免将命令发送到密码握手阶段。
        try await TerminalSmoke.wait("Parse the authenticated remote shell prompt") {
            guard terminal.generation != nil, terminal.inputControl?.owned == true,
                  let last = terminal.text.trimmingCharacters(in: .whitespacesAndNewlines).last else { return false }
            return "$#%>".contains(last)
        }
    }
    static func run(model: WorkspaceModel, open: () async throws -> SSHWindow, lookup: @escaping () -> SSHWindow?, report: inout [String: Any]) async throws {
        guard let bridge = model.sshBridge,
              let reportPath = WorkspaceModel.argument("--ssh-smoke-report"),
              let fixturePath = WorkspaceModel.argument("--ssh-smoke-fixture") else { throw BridgeFailure(code: "SSH_QA", message: "Missing isolated SSH fixture") }
        let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: URL(fileURLWithPath: fixturePath)))
        let evidence = URL(fileURLWithPath: reportPath).deletingLastPathComponent()
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        guard let menu = NSApp.mainMenu?.items.compactMap(\.submenu).first(where: { $0.items.contains { $0.title == "SSH connections…" } }),
              let index = menu.items.firstIndex(where: { $0.title == "SSH connections…" }) else { throw BridgeFailure(code: "SSH_QA", message: "SSH menu is missing") }
        menu.performActionForItem(at: index)
        try await TerminalSmoke.wait("Open actual native SSH menu") { lookup()?.model.snapshot != nil }
        guard let controller = lookup(), let window = controller.window else { throw BridgeFailure(code: "SSH_QA", message: "SSH window missing") }
        let ssh = controller.model
        ssh.name = "SSH QA 中文"; ssh.host = fixture["alias"].string ?? ""; ssh.mode = "alias"; ssh.port = ""; ssh.authentication = "key"; ssh.identity = fixture["identity"].string ?? ""; ssh.rootPath = fixture["remote"].string ?? ""
        guard await ssh.save(), !ssh.dirty else { throw BridgeFailure(code: "SSH_QA", message: ssh.error) }
        let profileID = ssh.selectedID
        report["nativeSSHMenuAndProfileSaved"] = window.isVisible && !profileID.isEmpty
        let previousRevision = ssh.snapshot?.revision
        _ = try await bridge.call("settings.patch", params: .object(["expectedRevision": .string(previousRevision ?? ""), "patch": .object(["fontSize": .number(15)])]))
        ssh.name = "RETAINED_DRAFT"
        guard !(await ssh.save()), ssh.name == "RETAINED_DRAFT", ssh.dirty, ssh.error.contains("CONFLICT") else { throw BridgeFailure(code: "SSH_QA", message: "Stale profile save lost its draft") }
        var captures: [String] = []
        func capture(_ target: NSWindow, _ name: String) async throws {
            target.makeKeyAndOrderFront(nil)
            try await Task.sleep(for: .milliseconds(300))
            try await TerminalSmoke.capture(window: target, path: evidence.appendingPathComponent(name))
        }
        try await capture(window, "native-ssh-profile-conflict-en-dark.png"); captures.append("native-ssh-profile-conflict-en-dark.png")
        report["profileCASRetainedDraft"] = true
        await ssh.reload(select: profileID)
        await ssh.connectFiles()
        guard ssh.connected, ssh.error.isEmpty, ssh.listing.contains(where: { $0["name"].string == "original 中文.txt" }) else { throw BridgeFailure(code: "SSH_QA", message: ssh.error) }
        let source = URL(fileURLWithPath: fixture["source"].string ?? "")
        await ssh.transfer(direction: "upload", paths: [source])
        guard ssh.error.isEmpty, ssh.listing.contains(where: { $0["name"].string == source.lastPathComponent }) else { throw BridgeFailure(code: "SSH_QA", message: ssh.error) }
        ssh.selection = source.lastPathComponent
        let downloaded = source.deletingLastPathComponent().appendingPathComponent("download 中文.txt")
        await ssh.transfer(direction: "download", paths: [downloaded])
        guard ssh.error.isEmpty, try Data(contentsOf: downloaded) == Data(contentsOf: source) else { throw BridgeFailure(code: "SSH_QA", message: "SFTP download bytes differ") }
        report["realAuthenticatedSFTPUploadAndDownload"] = true
        try await capture(window, "native-ssh-files-en-dark.png"); captures.append("native-ssh-files-en-dark.png")
        let large = source.deletingLastPathComponent().appendingPathComponent("cancelled-transfer.bin")
        try Data(repeating: 71, count: 32 * 1024 * 1024).write(to: large)
        let transfer = Task { @MainActor in await ssh.transfer(direction: "upload", paths: [large]) }
        try await TerminalSmoke.wait("Render real SFTP transfer progress") { ssh.active?.kind == "files.transfer" && ssh.active?.progress != nil && ssh.active?.state == "running" }
        let progress = ssh.active!
        guard ssh.feedback.isEmpty else { throw BridgeFailure(code: "SSH_QA", message: "Running transfer retained stale completion feedback") }
        do {
            _ = try await bridge.call("ssh.operation.cancel", params: .object(["id": .string(progress.id), "generation": .string(UUID().uuidString)]))
            throw BridgeFailure(code: "SSH_QA", message: "Stale transfer cancel succeeded")
        } catch let error as BridgeFailure where error.code == "SSH_OPERATION_CHANGED" {}
        scrollToBottom(window)
        try await capture(window, "native-ssh-transfer-progress-en-dark.png"); captures.append("native-ssh-transfer-progress-en-dark.png")
        guard ssh.active?.state == "running" else { throw BridgeFailure(code: "SSH_QA", message: "Transfer finished before progress capture") }
        await ssh.cancelTransfer(); await transfer.value
        guard ssh.feedback.contains("cancelled") else { throw BridgeFailure(code: "SSH_QA", message: "Transfer cancellation feedback is missing") }
        let finalOperations = try await bridge.call("ssh.operations")
        guard finalOperations.array.contains(where: { $0["id"].string == progress.id && $0["state"].string == "cancelled" }) else { throw BridgeFailure(code: "SSH_QA", message: "Transfer cancellation did not complete") }

        guard !FileManager.default.fileExists(atPath: URL(fileURLWithPath: fixture["remote"].string ?? "").appendingPathComponent(large.lastPathComponent).path) else { throw BridgeFailure(code: "SSH_QA", message: "Cancelled upload committed its destination") }
        report["nativeTransferProgressAndGenerationCancel"] = true
        await ssh.list()
        ssh.localPort = String(try freePort()); ssh.remoteHost = "127.0.0.1"; ssh.remotePort = fixture["port"].string ?? "22"
        await ssh.addForward()
        guard ssh.error.isEmpty, let rule = ssh.forwards.first else { throw BridgeFailure(code: "SSH_QA", message: ssh.error) }
        await ssh.startForward(rule)
        try await TerminalSmoke.wait("Real SSH tunnel listener") { ssh.tunnels.contains(where: { $0["id"] == rule["id"] && $0["state"].string == "running" }) }
        try tunnelBanner(port: UInt16(rule["local_port"].number ?? 0))
        report["nativeForwardingStarted"] = true
        report["nativeForwardingBannerReceived"] = true
        scrollToBottom(window)
        try await capture(window, "native-ssh-forwarding-en-dark.png"); captures.append("native-ssh-forwarding-en-dark.png")
        guard let status = ssh.tunnels.first(where: { $0["id"] == rule["id"] }) else { throw BridgeFailure(code: "SSH_QA", message: "Forward status missing") }
        do {
            _ = try await bridge.call("ssh.tunnel.stop", params: .object(["connection_id": status["connection_id"], "id": status["id"], "generation": .string(UUID().uuidString)]))
            throw BridgeFailure(code: "SSH_QA", message: "Stale tunnel stop succeeded")
        } catch let error as BridgeFailure where error.code == "SSH_FORWARD_CHANGED" {}
        await ssh.stopForward(status)
        try await TerminalSmoke.wait("Stop owned SSH tunnel") { !ssh.tunnels.contains(where: { $0["id"] == rule["id"] }) }
        report["nativeForwardingStaleStopRejected"] = true
        await ssh.newTerminal()
        guard ssh.error.isEmpty, let first = model.selectedTerminal else { throw BridgeFailure(code: "SSH_QA", message: ssh.error) }
        try await waitForRemotePrompt(first)
        let command = "printf 'UTERM_%s\\n' 'SSH_NATIVE_中文'\r"
        first.view.insertText(command, replacementRange: NSRange(location: NSNotFound, length: 0))
        try await TerminalSmoke.wait("Render authenticated remote shell output") { first.text.contains("UTERM_SSH_NATIVE_中文") }
        let firstGeneration = first.generation
        let hostBefore = try await bridge.call("host.status")
        report["realRemoteTerminalOutput"] = true
        if let parent = NSApp.windows.first(where: { $0.title == "uTerm Native QA" }) {
            try await capture(parent, "native-ssh-terminal-en-dark.png"); captures.append("native-ssh-terminal-en-dark.png")
        }
        await model.reconnectTransport()
        guard let rebound = model.terminals[first.id], let current = model.bridge else { throw BridgeFailure(code: "SSH_QA", message: "SSH terminal lost during reconnect") }
        try await TerminalSmoke.wait("Reattach remote session after Core reopen") { rebound.generation == firstGeneration && rebound.text.contains("UTERM_SSH_NATIVE_中文") }
        let hostAfter = try await current.call("host.status")
        guard hostBefore["pid"] == hostAfter["pid"] else { throw BridgeFailure(code: "SSH_QA", message: "Reconnect replaced the SSH host") }
        report["remoteDetachReplayAndHostRetained"] = true
        var reopened = try await open()
        await reopened.model.newTerminal()
        guard reopened.model.error.isEmpty, let second = model.selectedTerminal, second.id != first.id else { throw BridgeFailure(code: "SSH_QA", message: reopened.model.error) }
        try await TerminalSmoke.wait("Second real SSH terminal") { second.generation != nil }
        await model.selectSession(first.id); await model.closeSession()
        let remaining = try await current.call("host.status")
        guard !remaining["sessions"].array.contains(where: { $0["spec"]["id"].string == first.id }), remaining["sessions"].array.contains(where: { $0["spec"]["id"].string == second.id && $0["running"].bool == true }) else { throw BridgeFailure(code: "SSH_QA", message: "Closing SSH session affected its sibling") }
        report["exactRemoteClosePreservedSibling"] = true
        await model.selectSession(second.id); await model.closeSession()
        await reopened.model.reload(select: profileID)
        await model.patchSettings(["language": .string("zh-Hans"), "appearance": .string("light")])
        if let smaller = reopened.window {
            smaller.setContentSize(NSSize(width: 760, height: 700))
            await reopened.model.connectFiles()
            try await capture(smaller, "native-ssh-files-zh-light-760.png"); captures.append("native-ssh-files-zh-light-760.png")
        }
        await reopened.model.disconnectFiles()
        await model.patchSettings(["language": .string("en"), "appearance": .string("dark")])
        await reopened.model.reload(select: profileID)
        if fixture["passwordServiceLogin"].bool == true {
            await reopened.model.select(nil)
            reopened.model.name = "Password login QA"; reopened.model.host = fixture["passwordAlias"].string ?? ""; reopened.model.mode = "alias"; reopened.model.port = ""; reopened.model.authentication = "password"; reopened.model.password = fixture["password"].string ?? ""; reopened.model.remember = true; reopened.model.rootPath = fixture["passwordRemote"].string ?? ""
            guard await reopened.model.save() else { throw BridgeFailure(code: "SSH_QA", message: reopened.model.error) }
            var reference = reopened.model.profile["credential_id"]
            do {
                await reopened.model.connectFiles()
                guard reopened.model.connected, reopened.model.error.isEmpty else { throw BridgeFailure(code: "SSH_QA", message: reopened.model.error) }
                try await capture(reopened.window!, "native-ssh-password-keychain-en-dark.png"); captures.append("native-ssh-password-keychain-en-dark.png")
                await reopened.model.disconnectFiles()
                report["passwordServiceLogin"] = true
                let passwordProfile = reopened.model.selectedID
                await reopened.model.newTerminal()
                guard reopened.model.error.isEmpty, let terminal = model.selectedTerminal else { throw BridgeFailure(code: "SSH_QA", message: reopened.model.error) }
                try await waitForRemotePrompt(terminal)
                report["remotePromptObservedBeforePasswordCommand"] = true
                terminal.view.insertText("printf 'UTERM_%s\\n' 'SSH_PASSWORD_NATIVE'\r", replacementRange: NSRange(location: NSNotFound, length: 0))
                try await TerminalSmoke.wait("Password reaches the independent SSH session host") { terminal.text.contains("UTERM_SSH_PASSWORD_NATIVE") }
                if let parent = NSApp.windows.first(where: { $0.title == "uTerm Native QA" }) {
                    try await capture(parent, "native-ssh-password-terminal-en-dark.png"); captures.append("native-ssh-password-terminal-en-dark.png")
                }
                await model.closeSession()
                await reopened.model.reload(select: passwordProfile)
                report["actualPasswordRemoteTerminal"] = true
                for remembered in [false, true] {
                    let previous = try reopened.model.target()
                    reopened.model.remember = remembered
                    guard await reopened.model.save(), reopened.model.error.isEmpty else { throw BridgeFailure(code: "SSH_QA", message: reopened.model.error) }
                    reference = reopened.model.profile["credential_id"]
                    do {
                        _ = try await reopened.model.perform(["kind": .string("auth.configure"), "connection": previous, "password": .null, "remember": previous["remember_password"]])
                        throw BridgeFailure(code: "SSH_QA", message: "Obsolete password reference was retained")
                    } catch let failure as BridgeFailure where failure.message.contains("SSH_PASSWORD_REQUIRED") {}
                    if !remembered {
                        let passwordProfile = reopened.model.selectedID
                        await model.reconnectTransport()
                        reopened = try await open()
                        await reopened.model.reload(select: passwordProfile)
                    }
                    await reopened.model.connectFiles()
                    guard reopened.model.connected, reopened.model.error.isEmpty else { throw BridgeFailure(code: "SSH_QA", message: "Password retention conversion failed: " + reopened.model.error) }
                    await reopened.model.disconnectFiles()
                    if !remembered { report["temporaryPasswordSurvivedTerminalTransportReconnect"] = true }
                }
                report["rememberedAndTemporaryPasswordConversion"] = true
            } catch {
                _ = try? await reopened.model.perform(["kind": .string("auth.forget"), "reference": reference, "remember": reopened.model.profile["remember_password"]])
                throw error
            }
            _ = try await reopened.model.perform(["kind": .string("auth.forget"), "reference": reference, "remember": .bool(true)])
        }
        await reopened.model.select(nil)
        guard reopened.model.lastTransfer == nil else { throw BridgeFailure(code: "SSH_QA", message: "New connection inherited another profile's transfer status") }
        reopened.model.name = "Host trust QA"; reopened.model.host = fixture["unknownAlias"].string ?? ""; reopened.model.mode = "alias"; reopened.model.port = ""; reopened.model.authentication = "password"; reopened.model.password = fixture["password"].string ?? "isolated-qa-password"; reopened.model.rootPath = fixture["passwordRemote"].string ?? ""
        guard await reopened.model.save() else { throw BridgeFailure(code: "SSH_QA", message: reopened.model.error) }
        let connecting = Task { @MainActor in await reopened.model.connectFiles() }
        try await TerminalSmoke.wait("Native host trust sheet through actual askpass") { model.sshTrustPresented && model.sshTrustAlert?.window.isVisible == true }
        guard let alert = model.sshTrustAlert, let view = alert.window.contentView,
              let cancel = TerminalSmoke.descendants(view).compactMap({ $0 as? NSButton }).first(where: { $0.title == "Cancel" }) else { throw BridgeFailure(code: "SSH_QA", message: "Real host trust Cancel button missing") }
        try await capture(alert.window, "native-ssh-host-trust-en-dark.png"); captures.append("native-ssh-host-trust-en-dark.png")
        cancel.performClick(nil); await connecting.value
        guard !reopened.model.connected, !reopened.model.error.isEmpty else { throw BridgeFailure(code: "SSH_QA", message: "Declined host trust permitted a connection") }
        report["nativeAskpassHostTrustCancellation"] = true
        try await TerminalSmoke.wait("Dismiss declined native host trust") { !model.sshTrustPresented }
        if fixture["passwordServiceLogin"].bool == true {
            let approving = Task { @MainActor in await reopened.model.connectFiles() }
            try await TerminalSmoke.wait("Offer native host trust again after cancellation") { model.sshTrustPresented && model.sshTrustAlert?.window.isVisible == true }
            guard let view = model.sshTrustAlert?.window.contentView,
                  let approve = TerminalSmoke.descendants(view).compactMap({ $0 as? NSButton }).first(where: { $0.title == "Trust and connect" }) else { throw BridgeFailure(code: "SSH_QA", message: "Real native Trust button missing") }
            approve.performClick(nil); await approving.value
            guard reopened.model.connected, reopened.model.error.isEmpty else { throw BridgeFailure(code: "SSH_QA", message: reopened.model.error) }
            try await capture(reopened.window!, "native-ssh-host-trust-accepted-en-dark.png"); captures.append("native-ssh-host-trust-accepted-en-dark.png")
            await reopened.model.disconnectFiles()
            report["nativeAskpassHostTrustApprovedAndAuthenticated"] = true
        }
        let exported = try JSONEncoder().encode(try await bridge.call("snapshot.read"))
        let operations = try JSONEncoder().encode(try await bridge.call("ssh.operations"))
        guard !String(decoding: exported, as: UTF8.self).contains("isolated-qa-password"), !String(decoding: operations, as: UTF8.self).contains("isolated-qa-password") else { throw BridgeFailure(code: "SSH_QA", message: "Credential escaped into state or operation history") }
        report["passwordNotExportedOrReported"] = true
        if let actualPassword = fixture["password"].string {
            guard !String(decoding: exported, as: UTF8.self).contains(actualPassword), !String(decoding: operations, as: UTF8.self).contains(actualPassword) else { throw BridgeFailure(code: "SSH_QA", message: "Actual password escaped into state or operation history") }
        }
        report["sshCaptures"] = captures
        report["inputMethod"] = "Actual NSMenu, native model actions used by buttons, SwiftTerm insertText, real NSAlert button; isolated OpenSSH"
        report["manualKeyboardIMEAcceptance"] = false
        report["manualPickerAcceptance"] = false
        if report["passwordServiceLogin"] == nil { report["passwordServiceLogin"] = false }
    }
    static func scrollToBottom(_ window: NSWindow) {
        guard let view = window.contentView else { return }
        for scroll in TerminalSmoke.descendants(view).compactMap({ $0 as? NSScrollView }) where scroll.documentView?.frame.height ?? 0 > scroll.contentSize.height {
            scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, (scroll.documentView?.frame.height ?? 0) - scroll.contentSize.height)))
            scroll.reflectScrolledClipView(scroll.contentView)
        }
    }
    static func tunnelBanner(port: UInt16) throws {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw BridgeFailure(code: "SSH_QA", message: "Cannot create tunnel probe") }
        defer { close(descriptor) }
        var timeout = timeval(tv_sec: 3, tv_usec: 0)
        setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_port = port.bigEndian; address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard result == 0 else { throw BridgeFailure(code: "SSH_QA", message: "Cannot connect to owned tunnel") }
        var buffer = [UInt8](repeating: 0, count: 256)
        let count = buffer.withUnsafeMutableBytes { recv(descriptor, $0.baseAddress, $0.count, 0) }
        guard count > 0, String(decoding: buffer.prefix(count), as: UTF8.self).hasPrefix("SSH-") else { throw BridgeFailure(code: "SSH_QA", message: "Tunnel did not reach the real SSH server") }
    }
    static func freePort() throws -> UInt16 {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw BridgeFailure(code: "SSH_QA", message: "Cannot reserve a test port") }
        defer { close(descriptor) }
        var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard bound == 0 else { throw BridgeFailure(code: "SSH_QA", message: "Cannot bind test port") }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let result = withUnsafeMutablePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(descriptor, $0, &length) } }
        guard result == 0 else { throw BridgeFailure(code: "SSH_QA", message: "Cannot inspect test port") }
        return UInt16(bigEndian: address.sin_port)
    }
}
