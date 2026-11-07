import AppKit
import UserNotifications
import UTermBridge

@MainActor
final class AgentNotifications {
    private weak var workspace: WorkspaceModel?
    private var gate = AgentNotificationGate()
    private var tasks: [String: Task<Void, Never>] = [:]
    private(set) var simulatedDeliveries: [AgentNotificationTicket] = []
    var simulatedPermission = true
    var simulatedDelay: Duration = .zero
    private var simulated: Bool { WorkspaceModel.argument("--agent-smoke-report") != nil && WorkspaceModel.argument("--qa-data-root") != nil }
    init(workspace: WorkspaceModel) { self.workspace = workspace }
    var enabled: Bool {
        workspace?.settings["agentNotifications"].bool ?? (workspace?.state?.snapshot.document.legacy["uterm.desktop.agentNotifications"] == "true")
    }
    func setEnabled(_ enabled: Bool) async throws {
        guard let workspace else { return }
        if enabled {
            let granted: Bool
            if simulated { granted = simulatedPermission }
            else { granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) }
            guard granted else { throw BridgeFailure(code: "NOTIFICATION_DENIED", message: localized("Allow notifications in System Settings, then retry.", "请在系统设置中允许通知后重试。")) }
        }
        guard await workspace.mutate("settings.patch", ["patch": .object(["agentNotifications": .bool(enabled)])]) else {
            throw BridgeFailure(code: "NOTIFICATION_SAVE", message: localized("Could not save the notification setting. Retry.", "无法保存通知设置，请重试。"))
        }
        if !enabled { for id in tasks.keys { gate.cancel(id); tasks[id]?.cancel() }; tasks.removeAll() }
    }
    func retain(_ ids: Set<String>) {
        gate.retain(ids)
        for id in Array(tasks.keys) where !ids.contains(id) { tasks.removeValue(forKey: id)?.cancel() }
    }
    func consume(_ header: CoreTerminalHeader, session: String) {
        guard header.agent_activity_error == nil else { gate.cancel(session); return }
        guard let generation = header.generation, !generation.isEmpty else { return }
        guard let ticket = gate.consume(session: session, generation: generation, state: header.agent_state, events: header.agent_events ?? [], replay: header.reset) else { return }
        tasks[session]?.cancel()
        guard allowed(ticket) else { return }
        tasks[session] = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { if self.gate.current(ticket) { self.tasks[session] = nil } }
            do {
                let granted: Bool
                if self.simulated {
                    try await Task.sleep(for: self.simulatedDelay)
                    granted = self.simulatedPermission
                } else {
                    let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
                    granted = status == .authorized || status == .provisional
                }
                guard !Task.isCancelled, granted, self.allowed(ticket) else { return }
                if self.simulated { self.simulatedDeliveries.append(ticket); return }
                let content = UNMutableNotificationContent()
                content.title = self.workspace?.state?.sessions.first { $0.sessionID == session }?.session["name"].string ?? "uTerm"
                content.body = self.body(ticket); content.sound = .default
                let request = UNNotificationRequest(identifier: ticket.token.uuidString, content: content, trigger: nil)
                try await UNUserNotificationCenter.current().add(request)
                if !self.allowed(ticket) {
                    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [request.identifier])
                    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [request.identifier])
                }
            } catch is CancellationError {} catch {
                if self.gate.current(ticket) { self.workspace?.error = localized("Could not send the Agent notification. Check notification settings.", "无法发送 Agent 通知，请检查通知设置。") }
            }
        }
    }
    private func allowed(_ ticket: AgentNotificationTicket) -> Bool {
        #if DEBUG
        guard simulated else { return false }
        #endif
        guard gate.current(ticket), enabled, let workspace,
              workspace.state?.sessions.contains(where: { $0.sessionID == ticket.session }) == true else { return false }
        return !(NSApp.isActive && workspace.selectedID == ticket.session)
    }
    private func body(_ ticket: AgentNotificationTicket) -> String {
        switch ticket.kind {
        case "notice": localized("The session has a new reminder.", "会话有新提醒。")
        case "waiting": localized("Your attention is needed.", "需要你处理。")
        case "error": ticket.source == "process" ? localized("The session exited unexpectedly.", "会话异常退出。") : localized("The task failed.", "任务执行失败。")
        default: ticket.source == "process" ? localized("The session ended.", "会话已结束。") : localized("The task finished.", "任务已完成。")
        }
    }
}
