import XCTest
@testable import UTermBridge

final class BreakReminderScheduleTests: XCTestCase {
    func testSleepDoesNotReplayAndDismissalStartsAnotherFullInterval() {
        var schedule = BreakReminderSchedule()
        schedule.configure(enabled: true, minutes: 1, now: 0)
        schedule.tick(now: 59); XCTAssertFalse(schedule.visible)
        schedule.tick(now: 3600); XCTAssertTrue(schedule.visible)
        schedule.tick(now: 3609); XCTAssertTrue(schedule.visible)
        schedule.tick(now: 3610); XCTAssertFalse(schedule.visible)
        schedule.tick(now: 3669); XCTAssertFalse(schedule.visible)
        schedule.tick(now: 3670); XCTAssertTrue(schedule.visible)
        schedule.dismiss(now: 3671)
        schedule.tick(now: 3730); XCTAssertFalse(schedule.visible)
        schedule.tick(now: 3731); XCTAssertTrue(schedule.visible)
    }

    func testSameSettingsDoNotRestartAndDisableOrIntervalChangesHideNotice() {
        var schedule = BreakReminderSchedule()
        schedule.configure(enabled: true, minutes: 1, now: 0)
        schedule.configure(enabled: true, minutes: 1, now: 59)
        schedule.tick(now: 60); XCTAssertTrue(schedule.visible)
        schedule.configure(enabled: true, minutes: 2, now: 61)
        XCTAssertFalse(schedule.visible)
        schedule.tick(now: 180); XCTAssertFalse(schedule.visible)
        schedule.tick(now: 181); XCTAssertTrue(schedule.visible)
        schedule.configure(enabled: false, minutes: 2, now: 182)
        schedule.tick(now: 100000); XCTAssertFalse(schedule.visible)
    }
}
