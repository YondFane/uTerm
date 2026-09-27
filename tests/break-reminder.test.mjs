import test from "node:test";
import assert from "node:assert/strict";
import { scheduleBreakReminder } from "../src/lib/break-reminder.ts";
import { defaults, readSettings } from "../src/lib/settings.ts";

test("break reminders dismiss after ten seconds, restart and clean up", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states = [];
  const reminder = scheduleBreakReminder(1, (value) => states.push(value));
  t.mock.timers.tick(59999);
  assert.deepEqual(states, []);
  t.mock.timers.tick(1);
  assert.deepEqual(states, [true]);
  t.mock.timers.tick(9999);
  assert.deepEqual(states, [true]);
  t.mock.timers.tick(1);
  assert.deepEqual(states, [true, false]);
  t.mock.timers.tick(60000);
  assert.deepEqual(states, [true, false, true]);
  reminder.dismiss();
  t.mock.timers.tick(10000);
  assert.deepEqual(states, [true, false, true, false]);
  reminder.stop();
  t.mock.timers.tick(60000);
  assert.equal(states.length, 4);
});

test("break preferences default safely and reject invalid intervals", () => {
  const legacy = { ...defaults };
  delete legacy.breakReminder;
  delete legacy.breakInterval;
  assert.equal(readSettings(JSON.stringify(legacy)).breakReminder, false);
  assert.equal(readSettings(JSON.stringify(legacy)).breakInterval, 60);
  for (const breakInterval of [0, -1, 1.5, 1441, "60", null])
    assert.throws(() => readSettings(JSON.stringify({ ...defaults, breakInterval })));
  assert.equal(
    readSettings(JSON.stringify({ ...defaults, breakReminder: true, breakInterval: 30 }))
      .breakInterval,
    30,
  );
});
