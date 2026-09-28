import test from "node:test";
import assert from "node:assert/strict";
import { isBareShiftTab, terminalClipboardAction } from "../src/lib/terminal-input.ts";

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
