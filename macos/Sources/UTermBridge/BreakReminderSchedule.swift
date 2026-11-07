import Foundation

public struct BreakReminderSchedule: Sendable {
    private var enabled = false
    private var interval: TimeInterval = 0
    private var deadline: TimeInterval = .infinity
    public private(set) var visible = false

    public init() {}
    public mutating func configure(enabled: Bool, minutes: Double, now: TimeInterval) {
        let interval = minutes * 60
        guard self.enabled != enabled || self.interval != interval else { return }
        self.enabled = enabled
        self.interval = interval
        visible = false
        deadline = enabled ? now + interval : .infinity
    }
    public mutating func tick(now: TimeInterval) {
        guard enabled, now >= deadline else { return }
        if visible { dismiss(now: now) }
        else {
            visible = true
            // Start the ten-second notice now; never replay reminders missed during sleep.
            // 从现在开始显示十秒提醒，绝不补发休眠期间错过的提醒。
            deadline = now + 10
        }
    }
    public mutating func dismiss(now: TimeInterval) {
        visible = false
        deadline = enabled ? now + interval : .infinity
    }
}
