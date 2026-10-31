import test from "node:test";
import assert from "node:assert/strict";
import {
  followTaskReplayViewport,
  restoreTaskReplayViewport,
  taskLogText,
} from "../src/lib/terminal-replay.ts";

test("copying task logs joins wrapped lines without dropping spaces or combining separate records", () => {
  const rows = [
    { value: "word ", isWrapped: false },
    { value: "中文", isWrapped: true },
    { value: "next record   ", isWrapped: false },
    { value: "", isWrapped: false },
  ];
  const buffer = {
    length: rows.length,
    getLine(index) {
      const row = rows[index];
      return (
        row && {
          isWrapped: row.isWrapped,
          translateToString: (trim) => (trim ? row.value.trimEnd() : row.value),
        }
      );
    },
  };
  assert.equal(taskLogText(buffer), "word 中文\nnext record");
});

function fixture(
  lines = ["Starting Application", "Tomcat started", "Started Application", "", "", ""],
  rows = 3,
) {
  const moves = [];
  const buffer = {
    type: "normal",
    baseY: lines.length - rows,
    viewportY: lines.length - rows,
    get length() {
      return lines.length;
    },
    getLine(index) {
      return lines[index] === undefined ? undefined : { translateToString: () => lines[index] };
    },
  };
  const terminal = {
    rows,
    buffer: { active: buffer },
    scrollToLine(row) {
      buffer.viewportY = row;
      moves.push(row);
    },
    scrollToBottom() {
      buffer.viewportY = buffer.baseY;
      moves.push("bottom");
    },
  };
  return { lines, buffer, terminal, moves };
}

test("task replay reveals the last retained log lines behind a padded empty screen", () => {
  const value = fixture();
  assert.equal(restoreTaskReplayViewport(value.terminal), 1);
  assert.deepEqual(value.moves, [1]);
  assert.equal(value.lines[2], "Started Application");
});

test("short history and whitespace padding remain visible without changing output", () => {
  const value = fixture(["one log", "  ", "", "", ""], 4);
  assert.equal(restoreTaskReplayViewport(value.terminal), 0);
  assert.deepEqual(value.moves, [0]);
  assert.equal(value.lines[0], "one log");
});

test("normal visible output, empty history, alternate screens and manual scroll are left alone", () => {
  for (const configure of [
    (value) => {
      value.lines[4] = "new log";
    },
    (value) => {
      value.lines.fill("");
    },
    (value) => {
      value.buffer.type = "alternate";
    },
    (value) => {
      value.buffer.viewportY = 0;
    },
  ]) {
    const value = fixture();
    configure(value);
    assert.equal(restoreTaskReplayViewport(value.terminal), null);
    assert.deepEqual(value.moves, []);
  }
});

test("new text resumes following after restored history while control-only updates keep it visible", () => {
  const value = fixture();
  let restored = restoreTaskReplayViewport(value.terminal);
  restored = followTaskReplayViewport(value.terminal, restored);
  assert.equal(restored, 1);
  value.lines[3] = "new request log";
  restored = followTaskReplayViewport(value.terminal, restored);
  assert.equal(restored, 2);
  assert.equal(value.lines[value.buffer.viewportY], "Started Application");
  value.lines[5] = "more request logs";
  restored = followTaskReplayViewport(value.terminal, restored);
  assert.equal(restored, null);
  assert.deepEqual(value.moves, [1, 2, "bottom"]);
});

test("a user scrolling away from restored logs prevents automatic jumps on new output", () => {
  const value = fixture();
  const restored = restoreTaskReplayViewport(value.terminal);
  value.buffer.viewportY = 0;
  value.lines[4] = "new log";
  assert.equal(followTaskReplayViewport(value.terminal, restored), null);
  assert.deepEqual(value.moves, [1]);
});

test("fitting a smaller viewport retains the most recent replayed text", () => {
  const value = fixture();
  const restored = restoreTaskReplayViewport(value.terminal);
  value.terminal.rows = 2;
  assert.equal(followTaskReplayViewport(value.terminal, restored), 2);
  assert.equal(value.lines[value.buffer.viewportY], "Started Application");
});

test("a one-row task pane shows log text instead of reserving its only row for the cursor", () => {
  const value = fixture(["older log", "latest log", ""], 1);
  const restored = restoreTaskReplayViewport(value.terminal);
  assert.equal(restored, 1);
  assert.equal(value.lines[value.buffer.viewportY], "latest log");
  value.lines[2] = "newest log";
  assert.equal(followTaskReplayViewport(value.terminal, restored), null);
  assert.equal(value.buffer.viewportY, 2);
});
