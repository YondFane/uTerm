import Foundation
import UTermBridge

extension WorkspaceModel {
    func startControl() async {
        guard !controlBusy, let bridge else { return }
        controlBusy = true
        defer { controlBusy = false }
        await stopControl()
        do {
            controlStatus = try await bridge.call("control.start")
            controlError = ""
            controlTask = Task { @MainActor [weak self, bridge] in
                while !Task.isCancelled {
                    do {
                        let request = try await bridge.call("control.poll")
                        if request["id"].string != nil, let self {
                            let response: JSONValue
                            do { response = .object(["result": try await self.controlResult(request)]) }
                            catch { response = .object(["error": .string(Task.isCancelled
                                ? localized("Control was interrupted; check the app before retrying.", "控制操作被打断；请先检查应用再重试。")
                                : error.localizedDescription)]) }
                            _ = try await bridge.call("control.reply", params: .object(["id": request["id"], "result": response]))
                        }
                    } catch {
                        if Task.isCancelled { return }
                        self?.controlError = error.localizedDescription
                    }
                    do { try await Task.sleep(for: .milliseconds(250)) }
                    catch { return }
                }
            }
        } catch {
            controlStatus = .null
            controlError = error.localizedDescription
        }
    }

    func stopControl() async {
        let task = controlTask
        controlTask = nil
        task?.cancel()
        await task?.value
    }

    func configureControl(_ enabled: Bool) async {
        guard !controlBusy, let bridge else { return }
        controlBusy = true
        defer { controlBusy = false }
        do {
            controlStatus = try await bridge.call("control.configure", params: .object(["enabled": .bool(enabled)]))
            controlError = ""
        } catch { controlError = error.localizedDescription }
    }

    private func controlResult(_ request: JSONValue) async throws -> JSONValue {
        switch request["method"].string {
        case "status":
            return .object([
                "version": .string(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"),
                "selectedSession": workspace["selectedSession"],
                "sessions": .number(Double(state?.sessions.count ?? 0))
            ])
        case "projects.list":
            return .array(workspace["projects"].array.map { project in
                .object(["id": project["id"], "name": project["name"], "directory": project["directory"], "workspaceId": project["workspaceId"]])
            })
        case "sessions.list":
            return .array((state?.sessions ?? []).map { entry in
                var value: [String: JSONValue] = [:]
                if case .object(let session) = entry.session { value = session }
                value["directory"] = .string(entry.directory)
                value["state"] = .null
                value["link"] = .string("uterm://session/\(entry.sessionID)")
                return .object(value)
            })
        default:
            return try await performControlAction(request)
        }
    }
}
