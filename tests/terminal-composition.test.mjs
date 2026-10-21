import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { attachTerminalPunctuationInput } from "../src/lib/terminal-input.ts";

const dom = new JSDOM('<div id="terminal"></div>', { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Text"])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
dom.window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
dom.window.HTMLCanvasElement.prototype.getContext = () => null;
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function fixture() {
  const term = new Terminal({ screenReaderMode: true, allowProposedApi: true });
  term.open(document.getElementById("terminal"));
  const textarea = term.textarea;
  const sent = [];
  const listener = term.onData((text) => sent.push(text));
  let enabled = true;
  const dispose = attachTerminalPunctuationInput(
    textarea,
    (text) => term.input(text, true),
    () => enabled,
  );
  const key = (key, keyCode, extra = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", {
      key,
      keyCode,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    textarea.dispatchEvent(event);
    return event;
  };
  const compose = async (text) => {
    textarea.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
    textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, "end");
    for (const type of ["compositionupdate", "compositionend"])
      textarea.dispatchEvent(new dom.window.CompositionEvent(type, { data: text, bubbles: true }));
    await settle();
  };
  return {
    term,
    textarea,
    sent,
    key,
    compose,
    disable() {
      enabled = false;
    },
    dispose,
    close() {
      dispose();
      listener.dispose();
      term.dispose();
      document.getElementById("terminal").replaceChildren();
    },
  };
}

test("real xterm sends only the new IME text after pasting and moving left", async () => {
  const value = fixture();
  try {
    await new Promise((resolve) => value.term.write("\x1b[?2004h", resolve));
    value.term.paste("请打开当前会话");
    await value.compose("会");
    for (let i = 0; i < 3; i++) {
      value.key("ArrowLeft", 37);
      const cursor = Math.max(0, value.textarea.selectionStart - 1);
      value.textarea.setSelectionRange(cursor, cursor);
    }
    await value.compose("是");
    assert.deepEqual(value.sent, [
      "\x1b[200~请打开当前会话\x1b[201~",
      "会",
      "\x1b[D",
      "\x1b[D",
      "\x1b[D",
      "是",
    ]);
    assert.equal(value.textarea.value, "会是");
  } finally {
    value.close();
  }
});

test("real xterm's key-229 fallback does not replay old text when the helper caret is in the middle", async () => {
  const value = fixture();
  try {
    value.textarea.value = "会话😀";
    value.textarea.setSelectionRange(1, 1);
    value.key("Process", 229);
    value.textarea.setRangeText(
      "新",
      value.textarea.selectionStart,
      value.textarea.selectionEnd,
      "end",
    );
    await settle();
    assert.deepEqual(value.sent, ["新"]);
    assert.equal(value.textarea.value, "会话😀新");
  } finally {
    value.close();
  }
});

test("cursor alignment preserves navigation, active composition, shortcuts, disabled input and cleanup", async () => {
  const value = fixture();
  try {
    value.textarea.value = "旧内容";
    value.textarea.setSelectionRange(0, 1);
    for (const [key, keyCode, extra] of [
      ["ArrowLeft", 37, {}],
      ["c", 67, { metaKey: true }],
      ["Process", 229, { isComposing: true }],
    ]) {
      value.key(key, keyCode, extra);
      assert.equal(value.textarea.selectionStart, 0);
      assert.equal(value.textarea.selectionEnd, 1);
    }
    value.textarea.dispatchEvent(new dom.window.CompositionEvent("compositionstart"));
    value.textarea.setSelectionRange(0, 1);
    value.key("Process", 229);
    assert.equal(value.textarea.selectionStart, 0);
    value.textarea.dispatchEvent(new dom.window.CompositionEvent("compositionend"));
    await settle();
    value.disable();
    value.key("Process", 229);
    assert.equal(value.textarea.selectionStart, 0);
    value.dispose();
    value.textarea.dispatchEvent(new dom.window.CompositionEvent("compositionstart"));
    assert.equal(value.textarea.selectionStart, 0);
  } finally {
    value.close();
  }
});

test.after(() => dom.window.close());
