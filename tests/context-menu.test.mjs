import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { suppressBrowserContextMenu } from "../src/lib/context-menu.ts";

test("browser menus are suppressed across the page without blocking application menus", () => {
  const dom = new JSDOM("<main><button>Session</button><input><dialog open></dialog></main>");
  const { window } = dom;
  const dispose = suppressBrowserContextMenu(window);
  let customMenus = 0;
  const button = window.document.querySelector("button");
  button.addEventListener("contextmenu", (event) => {
    assert.equal(event.defaultPrevented, true);
    customMenus++;
    event.stopPropagation();
  });
  for (const target of [
    window.document.body,
    button,
    window.document.querySelector("input"),
    window.document.querySelector("dialog"),
  ]) {
    const event = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    assert.equal(target.dispatchEvent(event), false);
    assert.equal(event.defaultPrevented, true);
  }
  assert.equal(customMenus, 1);
  dispose();
  const event = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  assert.equal(window.document.body.dispatchEvent(event), true);
  window.close();
});
