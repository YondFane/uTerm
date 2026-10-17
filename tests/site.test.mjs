import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";

const source = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../site/site.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const releasePage = "https://github.com/YondFane/uTerm/releases/latest";

function setup(t, options = {}) {
  const dom = new JSDOM(source, {
    url: options.url ?? "https://yondfane.github.io/uTerm/?lang=zh-CN",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.fetch = options.fetch ?? (async () => ({ ok: false, status: 403 }));
  if (options.blockStorage) {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("Storage unavailable");
      },
    });
  }
  if (options.clipboard) {
    Object.defineProperty(window.navigator, "clipboard", { value: options.clipboard });
  }
  t.after(() => window.close());
  window.eval(script);
  return { window, document: window.document };
}

test("website assets and anchors resolve under the GitHub Pages project prefix", () => {
  const dom = new JSDOM(source, { url: "https://yondfane.github.io/uTerm/" });
  const ids = [...dom.window.document.querySelectorAll("[id]")].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, "IDs must be unique, including SVG symbols");
  for (const element of dom.window.document.querySelectorAll("[href], [src], [poster]")) {
    const value =
      element.getAttribute("href") ?? element.getAttribute("src") ?? element.getAttribute("poster");
    if (value.startsWith("#")) {
      if (value !== "#") assert.ok(ids.includes(value.slice(1)), value);
    } else if (!value.startsWith("https://")) {
      assert.ok(value.startsWith("./"), value);
      assert.ok(existsSync(new URL(`../site/${value}`, import.meta.url)), value);
      assert.ok(new URL(value, dom.window.location.href).pathname.startsWith("/uTerm/"));
    }
  }
  dom.window.close();
});

test("website language switching translates copy, metadata and labels with storage blocked", (t) => {
  const { document, window } = setup(t, { blockStorage: true });
  assert.equal(document.documentElement.lang, "zh-CN");
  document.querySelector("#language-toggle").click();
  assert.equal(document.documentElement.lang, "en");
  assert.match(document.title, /terminal workspace for coding agents/);
  for (const element of document.querySelectorAll("[data-i18n], [data-i18n-aria]")) {
    const value = element.hasAttribute("data-i18n")
      ? element.textContent
      : element.getAttribute("aria-label");
    assert.ok(value && value !== "undefined", element.outerHTML);
    assert.doesNotMatch(value, /[\u4e00-\u9fff]/, element.outerHTML);
  }
  assert.match(document.querySelector("[data-guide-link]").href, /features\.md$/);
  assert.match(document.querySelector('meta[property="og:title"]').content, /terminal workspace/);
  assert.equal(new URL(window.location.href).searchParams.get("lang"), "en");
  document.querySelector("#language-toggle").click();
  assert.match(document.querySelector("h1").textContent, /按项目展开/);
  assert.match(document.querySelector("[data-guide-link]").href, /features\.zh-CN\.md$/);
});

test("preview and install tabs support arrow navigation without changing the other group", (t) => {
  const { document, window } = setup(t);
  const first = document.querySelector("#tab-terminal");
  first.focus();
  first.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  assert.equal(document.activeElement.id, "tab-data");
  assert.equal(document.querySelector("#demo-data").hidden, false);
  assert.equal(document.querySelector("#demo-terminal").hidden, true);
  document.activeElement.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  assert.equal(document.activeElement.id, "tab-terminal");
  document.querySelector("#install-tab-win").click();
  assert.equal(document.querySelector("#install-win").hidden, false);
  assert.equal(document.querySelector("#install-npm").hidden, true);
  assert.match(document.querySelector("#install-note").textContent, /PowerShell/);
  assert.equal(document.querySelector("#demo-terminal").hidden, false);
  for (const group of document.querySelectorAll("[data-tabs]")) {
    assert.equal(group.querySelectorAll('[aria-selected="true"]').length, 1);
    assert.equal(group.querySelectorAll('[role="tab"][tabindex="0"]').length, 1);
  }
});

test("all six themes retain the current preview and one pressed choice", (t) => {
  const { document } = setup(t);
  document.querySelector("#tab-git").click();
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.click();
    assert.equal(document.querySelector("#app-preview").dataset.theme, button.dataset.themeChoice);
    assert.equal(document.querySelectorAll('[data-theme-choice][aria-pressed="true"]').length, 1);
    assert.equal(document.querySelector("#demo-git").hidden, false);
  }
});

test("copy writes the selected command and reports clipboard failures visibly", async (t) => {
  let copied;
  const { document } = setup(t, {
    clipboard: {
      writeText: async (text) => {
        copied = text;
      },
    },
  });
  document.querySelector("#install-tab-mac").click();
  document.querySelector("#copy-command").click();
  await tick();
  assert.equal(copied, document.querySelector("#install-mac code").textContent);
  assert.match(
    copied,
    /^curl -fsSL https:\/\/raw\.githubusercontent\.com\/YondFane\/uTerm\/release\//,
  );
  assert.match(document.querySelector("#copy-status").textContent, /已复制/);
  const failed = setup(t);
  failed.document.querySelector("#copy-command").click();
  await tick();
  assert.match(failed.document.querySelector("#copy-status").textContent, /无法访问剪贴板/);
  assert.equal(failed.window.getSelection().toString(), "npx @yondfane/uterm-install");
});

test("copy completion cannot label a different install tab as copied", async (t) => {
  let finish;
  const { document } = setup(t, {
    clipboard: {
      writeText: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  document.querySelector("#copy-command").click();
  document.querySelector("#install-tab-win").click();
  finish();
  await tick();
  assert.equal(document.querySelector("#copy-status").textContent, "");
  assert.equal(document.querySelector("#copy-command span").textContent, "复制");
  assert.equal(document.querySelector("#copy-command").disabled, false);
});

test("release resolution accepts only matching stable repository assets and retains safe fallbacks", async (t) => {
  const name = "uTerm-0.1.21-windows-x86_64-setup.exe";
  const url = `https://github.com/YondFane/uTerm/releases/download/uTerm-v0.1.21/${name}`;
  const { document } = setup(t, {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        tag_name: "uTerm-v0.1.21",
        draft: false,
        prerelease: false,
        assets: [
          { name, browser_download_url: url },
          {
            name: "uTerm-0.1.21-darwin-aarch64.dmg",
            browser_download_url: "https://example.com/installer.dmg",
          },
        ],
      }),
    }),
  });
  await tick();
  assert.equal(document.querySelector('[data-download="windows"]').href, url);
  assert.equal(document.querySelector('[data-download="mac-arm"]').href, releasePage);
  assert.equal(document.querySelector('[data-download="mac-intel"]').href, releasePage);
  assert.match(document.querySelector("#release-label").textContent, /0\.1\.21/);
  document.querySelector("#language-toggle").click();
  assert.match(document.querySelector("#release-state").textContent, /stable GitHub release/);
  for (const fetch of [
    async () => {
      throw new Error("Offline");
    },
    async () => ({ ok: false, status: 403 }),
    async () => ({
      ok: true,
      json: async () => ({ tag_name: "uTerm-v9.9.9", prerelease: true, assets: [] }),
    }),
  ]) {
    const fallback = setup(t, { fetch });
    await tick();
    for (const link of fallback.document.querySelectorAll("[data-download]"))
      assert.equal(link.href, releasePage);
    assert.match(fallback.document.querySelector("#release-state").textContent, /稳定版发布页/);
  }
});
