import test from "node:test";
import assert from "node:assert/strict";
import {
  isBareShiftTab,
  terminalClipboardAction,
  terminalPunctuationKey,
} from "../src/lib/terminal-input.ts";

const keyEvent = (overrides = {}) => ({
  key: "Tab",
  shiftKey: true,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...overrides,
});

const clipboardEvent = (overrides = {}) => ({
  code: "KeyC",
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

test("Windows Ctrl+C copies a selection but otherwise preserves terminal interrupt", () => {
  assert.equal(terminalClipboardAction(clipboardEvent(), false, true), "copy");
  assert.equal(terminalClipboardAction(clipboardEvent(), false, false), null);
  assert.equal(terminalClipboardAction(clipboardEvent({ shiftKey: true }), false, true), "copy");
});

test("Windows Ctrl+V and Ctrl+Shift+V paste without sending a control character", () => {
  for (const shiftKey of [false, true])
    for (const selected of [false, true])
      assert.equal(
        terminalClipboardAction(clipboardEvent({ code: "KeyV", shiftKey }), false, selected),
        "paste",
      );
});

test("macOS leaves Command copy/paste to native events and Control to terminal programs", () => {
  for (const code of ["KeyC", "KeyV"]) {
    assert.equal(terminalClipboardAction(clipboardEvent({ code }), true, true), null);
    for (const selected of [false, true])
      for (const shiftKey of [false, true])
        assert.equal(
          terminalClipboardAction(
            clipboardEvent({ code, ctrlKey: false, metaKey: true, shiftKey }),
            true,
            selected,
          ),
          null,
        );
  }
});

test("clipboard shortcuts do not intercept composition, AltGr or unrelated keys", () => {
  for (const patch of [
    { isComposing: true },
    { altKey: true },
    { metaKey: true },
    { ctrlKey: false },
    { code: "KeyX" },
  ])
    assert.equal(terminalClipboardAction(clipboardEvent(patch), false, true), null);
});

test("only bare Shift-Tab is reserved for the focused terminal", () => {
  assert.equal(isBareShiftTab(keyEvent()), true);
  assert.equal(isBareShiftTab(keyEvent({ shiftKey: false })), false);
  assert.equal(isBareShiftTab(keyEvent({ key: "Enter" })), false);

  for (const modifier of ["ctrlKey", "altKey", "metaKey"])
    assert.equal(isBareShiftTab(keyEvent({ [modifier]: true })), false);
});

test("committed Unicode punctuation bypasses xterm without mutating the IME textarea", async () => {
  const { JSDOM } = await import("jsdom");
  const { attachTerminalPunctuationInput } = await import("../src/lib/terminal-input.ts");
  const dom = new JSDOM("<textarea></textarea>");
  const textarea = dom.window.document.querySelector("textarea");
  const sent = [];
  let enabled = true;
  const dispose = attachTerminalPunctuationInput(
    textarea,
    (text) => sent.push(text),
    () => enabled,
  );
  const insert = (data, extra = {}) => {
    const event = new dom.window.InputEvent("beforeinput", {
      data,
      inputType: "insertText",
      cancelable: true,
      bubbles: true,
      ...extra,
    });
    textarea.dispatchEvent(event);
    return event;
  };
  try {
    textarea.value = "previous composition";
    for (const punctuation of ["，", "。", "！", "？", "；", "：", "、", "“”", "……", "——", "（）"])
      assert.equal(insert(punctuation).defaultPrevented, true);
    assert.equal(textarea.value, "previous composition");
    assert.deepEqual(sent, ["，", "。", "！", "？", "；", "：", "、", "“”", "……", "——", "（）"]);
    for (const text of [",", ".", "!", "$", "+"]) {
      assert.equal(insert(text).defaultPrevented, true);
      assert.equal(sent.at(-1), text);
    }
    for (const text of ["abc", "你好", "😀"]) assert.equal(insert(text).defaultPrevented, false);
    assert.equal(insert("，", { inputType: "insertFromPaste" }).defaultPrevented, false);
    assert.equal(insert("，", { cancelable: false }).defaultPrevented, false);
    assert.equal(insert("，", { isComposing: true }).defaultPrevented, false);
    textarea.dispatchEvent(new dom.window.CompositionEvent("compositionstart"));
    assert.equal(insert("，").defaultPrevented, false);
    textarea.dispatchEvent(new dom.window.CompositionEvent("compositionend"));
    assert.equal(insert("，").defaultPrevented, false);
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(insert("，").defaultPrevented, true);
    enabled = false;
    assert.equal(insert("，").defaultPrevented, false);
    const count = sent.length;
    dispose();
    enabled = true;
    assert.equal(insert("，").defaultPrevented, false);
    assert.equal(sent.length, count);
  } finally {
    dispose();
    dom.window.close();
  }
});

test("punctuation key events defer to native input while composition and control keys pass through", () => {
  const event = {
    key: "，",
    keyCode: 0,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  };
  for (const key of [
    ",",
    ".",
    "!",
    "$",
    "@",
    "+",
    "=",
    "，",
    "。",
    "！",
    "？",
    "；",
    "：",
    "“",
    "”",
    "（",
    "）",
  ])
    assert.equal(terminalPunctuationKey({ ...event, key }), key);
  for (const patch of [
    { key: "a" },
    { key: "Process" },
    { key: "你" },
    { key: "😀" },
    { keyCode: 229 },
    { isComposing: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
  ])
    assert.equal(terminalPunctuationKey({ ...event, ...patch }), null);
});
