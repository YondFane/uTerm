import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { attachTerminalScrollInput } from "../src/lib/terminal-scroll.ts";

function fixture(type = "normal", tracking = "none") {
  const dom = new JSDOM('<div id="terminal"><div class="xterm-screen"></div></div>');
  const element = dom.window.document.getElementById("terminal");
  element.querySelector(".xterm-screen").getBoundingClientRect = () => ({ height: 320 });
  const dataListeners = new Set();
  const binaryListeners = new Set();
  const events = [];
  const scrolls = [];
  const writes = [];
  let clock = 0;
  const terminal = {
    element,
    rows: 20,
    buffer: { active: { type } },
    modes: { mouseTrackingMode: tracking },
    options: { disableStdin: false, fontSize: 16, lineHeight: 1, fastScrollSensitivity: 5 },
    scrollLines: (lines) => scrolls.push(lines),
    onData(callback) {
      dataListeners.add(callback);
      return { dispose: () => dataListeners.delete(callback) };
    },
    onBinary(callback) {
      binaryListeners.add(callback);
      return { dispose: () => binaryListeners.delete(callback) };
    },
  };
  const emitData = (value) => dataListeners.forEach((listener) => listener(value));
  const emitBinary = (value) => binaryListeners.forEach((listener) => listener(value));
  element.addEventListener("wheel", (event) => {
    events.push(event);
    if (terminal.options.disableStdin) return;
    if (terminal.modes.mouseTrackingMode === "vt200") emitData("\x1b[<65;6;4M");
    else if (terminal.modes.mouseTrackingMode === "drag") emitBinary("\x1b[M\xff\x21\x22");
    else if (terminal.buffer.active.type === "alternate") emitData("\x1bOA");
  });
  const dispose = attachTerminalScrollInput(terminal, (data) => writes.push(data));
  const wheel = (deltaY, options = {}) => {
    const { at = (clock += 20), ...init } = options;
    const event = new dom.window.WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY,
      ...init,
    });
    Object.defineProperty(event, "timeStamp", { value: at });
    element.dispatchEvent(event);
    return event;
  };
  return {
    terminal,
    events,
    scrolls,
    writes,
    wheel,
    emitData,
    emitBinary,
    dispose,
    close() {
      dispose();
      dom.window.close();
    },
  };
}

test("mouse-wheel distance scrolls history immediately without writing terminal input", () => {
  const value = fixture();
  try {
    assert.equal(value.wheel(3, { deltaMode: 1 }).defaultPrevented, true);
    value.wheel(-160);
    value.wheel(1, { deltaMode: 2 });
    value.wheel(100000);
    assert.deepEqual(value.scrolls, [6, -20, 40, 80]);
    assert.equal(value.events.length, 0);
    assert.equal(value.writes.length, 0);
  } finally {
    value.close();
  }
});

test("fine trackpad movement accumulates without acceleration or stale direction/gesture fractions", () => {
  const value = fixture();
  try {
    for (let index = 0; index < 7; index++) value.wheel(2);
    assert.deepEqual(value.scrolls, []);
    value.wheel(2);
    assert.deepEqual(value.scrolls, [1]);
    value.wheel(12);
    value.wheel(-12);
    assert.deepEqual(value.scrolls, [1]);
    value.wheel(-4);
    assert.deepEqual(value.scrolls, [1, -1]);
    value.wheel(12, { at: 1000 });
    value.wheel(4, { at: 1300 });
    assert.deepEqual(value.scrolls, [1, -1]);
  } finally {
    value.close();
  }
});

test("application scrolling retains distance, coordinates and modifiers in one bounded input write", () => {
  const value = fixture("normal", "vt200");
  try {
    value.wheel(4, { deltaMode: 1, clientX: 90, clientY: 70, buttons: 1 });
    assert.equal(value.events.length, 8);
    assert.equal(value.writes.length, 1);
    assert.equal(new TextDecoder().decode(value.writes[0]), "\x1b[<65;6;4M".repeat(8));
    for (const event of value.events) {
      assert.equal(event.deltaMode, 1);
      assert.equal(event.deltaY, 1);
      assert.equal(event.clientX, 90);
      assert.equal(event.clientY, 70);
      assert.equal(event.buttons, 1);
    }
    value.wheel(-100000, { altKey: true });
    assert.equal(value.events.length, 20);
    assert.equal(value.writes.length, 2);
    assert.ok(value.events.slice(8).every((event) => event.deltaY === -1 && event.altKey));
    assert.deepEqual(value.scrolls, []);
  } finally {
    value.close();
  }
});

test("alternate-screen arrow scrolling and legacy binary mouse reports keep xterm encoding intact", () => {
  const value = fixture("alternate");
  try {
    value.wheel(-48);
    assert.equal(new TextDecoder().decode(value.writes[0]), "\x1bOA".repeat(6));
    value.terminal.modes.mouseTrackingMode = "drag";
    value.wheel(2, { deltaMode: 1 });
    assert.deepEqual(
      [...value.writes[1]],
      Array.from({ length: 4 }, () => [27, 91, 77, 255, 33, 34]).flat(),
    );
    assert.equal(value.writes.length, 2);
  } finally {
    value.close();
  }
});

test("mouse protocols without wheel reporting still use local history; buffer changes reset fractions", () => {
  const value = fixture("normal", "x10");
  try {
    value.wheel(3, { deltaMode: 1 });
    assert.deepEqual(value.scrolls, [6]);
    value.wheel(12);
    value.terminal.buffer.active.type = "alternate";
    value.wheel(4);
    assert.equal(value.events.length, 0);
    value.wheel(12);
    assert.equal(value.events.length, 1);
  } finally {
    value.close();
  }
});

test("modifiers, horizontal gestures, disabled application input and non-cancelable events pass through", () => {
  const value = fixture();
  try {
    for (const options of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { deltaX: 100 },
      { cancelable: false },
    ])
      assert.equal(value.wheel(10, options).defaultPrevented, false);
    assert.deepEqual(value.scrolls, []);
    value.terminal.options.disableStdin = true;
    value.wheel(3, { deltaMode: 1 });
    assert.deepEqual(value.scrolls, [6]);
    value.terminal.buffer.active.type = "alternate";
    assert.equal(value.wheel(160).defaultPrevented, false);
    assert.equal(value.writes.length, 0);
  } finally {
    value.close();
  }
});

test("ordinary Unicode/binary input is unchanged and disposal removes scrolling and input listeners", () => {
  const value = fixture();
  try {
    value.emitData("中文\r");
    value.emitBinary("\xff\x00");
    assert.equal(new TextDecoder().decode(value.writes[0]), "中文\r");
    assert.deepEqual([...value.writes[1]], [255, 0]);
    value.dispose();
    value.emitData("after cleanup");
    value.emitBinary("\xff");
    assert.equal(value.wheel(160).defaultPrevented, false);
    assert.deepEqual(value.scrolls, []);
    assert.equal(value.writes.length, 2);
  } finally {
    value.close();
  }
});
