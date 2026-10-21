import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { attachTerminalAccessibilityLimit } from "../src/lib/terminal-accessibility.ts";

test("cursor redraw announcements stay bounded without changing readable rows or selection", async () => {
  const dom = new JSDOM(
    '<div id="terminal"><div class="xterm-accessibility"><div class="xterm-accessibility-tree"><div>Readable 中文 output</div></div><div class="live-region" aria-live="assertive"></div></div><textarea></textarea></div>',
  );
  const { document } = dom.window;
  globalThis.MutationObserver = dom.window.MutationObserver;
  const element = document.getElementById("terminal");
  const row = element.querySelector(".xterm-accessibility-tree > div");
  const region = element.querySelector(".live-region");
  const selection = dom.window.getSelection();
  selection.selectAllChildren(row);
  const dispose = attachTerminalAccessibilityLimit(element, () => "Too much output");
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    region.textContent = "Short announcement";
    await flush();
    assert.equal(region.textContent, "Short announcement");
    for (let i = 0; i < 5; i++) {
      const recent = `latest ${i} / 最新输出`;
      region.textContent += "\r原地重绘😀".repeat(10000) + recent;
      await flush();
      assert.ok(region.textContent.length <= 8192);
      assert.ok(region.textContent.startsWith("Too much output\n"));
      assert.ok(region.textContent.endsWith(recent));
      assert.equal(region.textContent.isWellFormed(), true);
    }
    assert.equal(row.textContent, "Readable 中文 output");
    assert.equal(selection.toString(), "Readable 中文 output");
    assert.equal(element.querySelector("textarea").value, "");
    assert.equal(region.getAttribute("aria-live"), "assertive");

    const accessibility = region.parentElement;
    accessibility.remove();
    await flush();
    const replacement = accessibility.cloneNode(true);
    const replacementRegion = replacement.querySelector(".live-region");
    replacementRegion.textContent = "Restored / 恢复".repeat(10000);
    element.prepend(replacement);
    await flush();
    assert.ok(replacementRegion.textContent.length <= 8192);

    dispose();
    replacementRegion.textContent = "Unobserved".repeat(10000);
    await flush();
    assert.ok(replacementRegion.textContent.length > 8192);
  } finally {
    dispose();
    dom.window.close();
    delete globalThis.MutationObserver;
  }
});
