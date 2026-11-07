import AppKit
import UTermBridge

@MainActor
extension WorkspaceModel {
    func startSSHTrust(_ bridge: CoreBridge) {
        stopSSHTrust()
        sshTrustTask = Task { @MainActor [weak self, bridge] in
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let prompts = try await bridge.call("ssh.trust.pending").array
                    if let id = self.sshTrustID, !prompts.contains(where: { $0["id"].string == id }), let alert = self.sshTrustAlert {
                        if let parent = alert.window.sheetParent { parent.endSheet(alert.window, returnCode: .abort) }
                    }
                    if self.sshTrustAlert == nil, let prompt = prompts.first,
                       let id = prompt["id"].string, let parent = NSApp.keyWindow ?? NSApp.mainWindow,
                       parent.attachedSheet == nil {
                        let alert = NSAlert()
                        alert.messageText = localized("SSH host fingerprint", "SSH 主机指纹")
                        alert.informativeText = prompt["message"].string ?? ""
                        alert.addButton(withTitle: localized("Cancel", "取消"))
                        alert.addButton(withTitle: localized("Trust and connect", "信任并连接"))
                        self.sshTrustAlert = alert; self.sshTrustID = id; self.sshTrustPresented = true
                        alert.beginSheetModal(for: parent) { [weak self, bridge] response in
                            Task { @MainActor in
                                guard let self else { return }
                                if response != .abort {
                                    do { _ = try await bridge.call("ssh.trust.confirm", params: .object(["id": .string(id), "approve": .bool(response == .alertSecondButtonReturn)])) }
                                    catch { self.error = error.localizedDescription }
                                }
                                self.sshTrustAlert = nil; self.sshTrustID = nil; self.sshTrustPresented = false
                            }
                        }
                    }
                } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
                do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
            }
        }
    }
    func stopSSHTrust() {
        sshTrustTask?.cancel(); sshTrustTask = nil
        if let alert = sshTrustAlert, let parent = alert.window.sheetParent { parent.endSheet(alert.window, returnCode: .abort) }
        sshTrustAlert = nil; sshTrustID = nil; sshTrustPresented = false
    }
}
