import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("Pi activity waits for final settlement, closes reporter input and preserves literal arguments", async () => {
  const source = readFileSync(
    new URL("../src-tauri/integrations/pi-activity.js", import.meta.url),
    "utf8",
  );
  const reporter = "C:\\用户 files\\$literal'&\\integration\\uterm-report.exe";
  const calls = [];
  const env = {};
  let fail = false;
  const sandbox = {
    process: { env },
    execFile(program, args, options, callback) {
      calls.push({ program, args: [...args], options: { ...options } });
      return {
        stdin: {
          end() {
            callback(fail ? new Error("report failed") : null);
          },
        },
      };
    },
  };
  vm.runInNewContext(
    source
      .replace('import { execFile } from "node:child_process";', "")
      .replace("__UTERM_REPORTER__", JSON.stringify(reporter))
      .replace("export default function (pi)", "globalThis.register = function (pi)"),
    sandbox,
  );
  const events = new Map();
  sandbox.register({ on: (event, handler) => events.set(event, handler) });
  await events.get("agent_start")();
  assert.equal(calls.length, 0);
  Object.assign(env, {
    UTERM_DESKTOP_HOST: "fixture",
    UTERM_DESKTOP_SESSION: "session",
    UTERM_DESKTOP_GENERATION: "generation",
  });
  for (const [event, state] of [
    ["session_start", "idle"],
    ["agent_start", "working"],
    ["tool_execution_start", "working"],
    ["agent_settled", "done"],
  ]) {
    await events.get(event)();
    assert.equal(calls.at(-1).program, reporter);
    assert.deepEqual(calls.at(-1).args, ["--agent-report", state]);
    assert.equal(calls.at(-1).options.timeout, 10000);
    assert.equal(calls.at(-1).options.windowsHide, true);
  }
  assert.equal(events.has("agent_end"), false);
  fail = true;
  await assert.rejects(events.get("agent_start")(), /report failed/);
});
