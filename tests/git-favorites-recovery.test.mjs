import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

execFileSync(
  "cargo",
  [
    "build",
    "--quiet",
    "--locked",
    "--manifest-path",
    "crates/uterm-core/Cargo.toml",
    "--bin",
    "uterm-core-contract",
  ],
  { stdio: "inherit" },
);
function signal() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "uterm-favorite-recovery-ui-")),
    directory = join(root, "repository");
  mkdirSync(directory);
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", `core.hooksPath=${join(root, "no-hooks")}`, "-C", directory, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  git("init", "--initial-branch=main");
  writeFileSync(join(directory, "tracked.txt"), "committed 中文 e\u0301\n");
  git("add", "--all");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    "isolated favorite recovery UI",
  );
  const store = join(root, "shared-state-v1"),
    target = resolve(process.env.CARGO_TARGET_DIR ?? "crates/uterm-core/target");
  const child = spawn(
    join(target, "debug", `uterm-core-contract${process.platform === "win32" ? ".exe" : ""}`),
    ["--serve", store],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const call = async (method, params = null, id = crypto.randomUUID()) => {
    child.stdin.write(JSON.stringify({ version: 1, id, method, params }) + "\n");
    const { value, done } = await lines.next();
    assert.equal(done, false);
    const response = JSON.parse(value);
    assert.equal(response.id, id);
    return response;
  };
  const raw = async (method, params) => {
    const reply = await call(method, params);
    assert.equal(reply.error, undefined);
    return reply.result;
  };
  const legacy = '[\r\n "refs/heads/alpha-中文-e\u0301-𝄞"' + " ".repeat(24000) + "\r\n]";
  const imported = await raw("git.favorites.import", { directory, legacy });
  const file = join(store, "git-favorites-v1.json"),
    initial = readFileSync(file);
  t.after(() => {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, directory, store, file, legacy, imported, initial, call, raw };
}
async function render(t, f, { intercept = async () => {} } = {}) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const saved = new Map();
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLDialogElement",
    "Node",
    "Event",
    "CustomEvent",
    "isTauri",
  ]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "isTauri" ? true : dom.window[key],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  let clipboard = "",
    clipboardFailure = false,
    closed = 0,
    restored = 0;
  const busy = [];
  const requests = [];
  dom.window.addEventListener("uterm:git-favorites-restored", () => {
    restored++;
  });
  mockIPC(async (command, args) => {
    if (command === "plugin:clipboard-manager|write_text") {
      if (clipboardFailure) throw Error("Native clipboard unavailable");
      clipboard = args.text;
      return;
    }
    assert.equal(command, "shared_core_request");
    const request = JSON.parse(args.request);
    requests.push(request);
    const reply = await f.call(request.method, request.params, request.id);
    await intercept(request, reply);
    return JSON.stringify(reply);
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { GitFavoritesRecovery } = await server.ssrLoadModule(
    "/src/components/GitFavoritesRecovery.tsx",
  );
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const { createRoot } = await import("react-dom/client");
  const renderer = createRoot(dom.window.document.getElementById("root"));
  let key = 0;
  const mount = () =>
    act(async () =>
      renderer.render(
        React.createElement(GitFavoritesRecovery, {
          key: ++key,
          onClose: () => {
            closed++;
            renderer.render(null);
          },
          onBusyChange: (value) => busy.push(value),
        }),
      ),
    );
  const wait = async (predicate, label) => {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 20));
      });
      if (predicate()) return;
    }
    assert.fail(label + "\n" + dom.window.document.body.textContent);
  };
  const button = (label) =>
    [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  const click = (label) =>
    act(async () => {
      const b = button(label);
      assert.ok(b, label);
      assert.equal(b.disabled, false, label);
      b.click();
    });
  const choose = (value) =>
    act(async () => {
      const select = dom.window.document.querySelector("select");
      assert.ok([...select.options].some((o) => o.value === value));
      assert.equal(select.disabled, false);
      select.value = value;
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  t.after(async () => {
    await act(async () => renderer.unmount());
    await server.close();
    clearMocks();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    dom,
    mount,
    wait,
    button,
    click,
    choose,
    requests,
    busy,
    failClipboard: (value) => {
      clipboardFailure = value;
    },
    get clipboard() {
      return clipboard;
    },
    get closed() {
      return closed;
    },
    get restored() {
      return restored;
    },
  };
}

test("real Core recovery dialog retains corrupt bytes on cancel/copy and protects a missing restore until acknowledgement", async (t) => {
  const f = await fixture(t);
  await f.raw("git.favorites.write", {
    directory: f.directory,
    expectedRevision: f.imported.revision,
    references: [],
  });
  const damaged = Buffer.from("{CORRUPT FAVORITE UI DATA 中文\r\n");
  writeFileSync(f.file, damaged);
  const held = signal(),
    release = signal();
  let hold = false;
  t.after(() => release.resolve());
  const ui = await render(t, f, {
    intercept: async (request) => {
      if (hold && request.method === "git.favorites.recovery.restore") {
        held.resolve();
        await release.promise;
      }
    },
  });
  await ui.mount();
  assert.equal(ui.dom.window.document.activeElement?.textContent, "Cancel");
  await ui.wait(
    () => ui.button("Restore all repository favorites")?.disabled === false,
    "verified snapshot preview",
  );
  assert.match(ui.dom.window.document.querySelector("textarea").value, /alpha-中文-e\u0301-𝄞/);
  assert.deepEqual(readFileSync(f.file), damaged);
  await ui.click("Cancel");
  assert.equal(ui.closed, 1);
  assert.deepEqual(readFileSync(f.file), damaged);
  await ui.mount();
  await ui.wait(
    () => ui.button("Restore all repository favorites")?.disabled === false,
    "second preview",
  );
  await ui.choose(`source:${f.imported.sourceDigest}`);
  await ui.wait(() => ui.button("Copy full preview")?.disabled === false, "old source preview");
  assert.equal(ui.button("Restore all repository favorites").disabled, true);
  assert.equal(
    ui.dom.window.document.querySelector("textarea").value.length < f.legacy.length,
    true,
  );
  assert.match(ui.dom.window.document.body.textContent, /Preview is truncated/);
  ui.failClipboard(true);
  await ui.click("Copy full preview");
  assert.match(
    ui.dom.window.document.querySelector('[role="alert"]').textContent,
    /Native clipboard unavailable/,
  );
  assert.deepEqual(readFileSync(f.file), damaged);
  ui.failClipboard(false);
  await ui.click("Copy full preview");
  assert.equal(ui.dom.window.document.querySelector('[role="alert"]'), null);
  assert.deepEqual(Buffer.from(ui.clipboard), Buffer.from(f.legacy));
  assert.deepEqual(readFileSync(f.file), damaged);
  await ui.click("Cancel");
  rmSync(f.file);
  hold = true;
  await ui.mount();
  await ui.wait(
    () => ui.button("Restore all repository favorites")?.disabled === false,
    "missing-store preview",
  );
  await ui.click("Restore all repository favorites");
  await held.promise;
  assert.deepEqual(readFileSync(f.file), f.initial);
  assert.equal(ui.button("Cancel").disabled, true);
  await act(async () => {
    ui.dom.window.document
      .querySelector("dialog")
      .dispatchEvent(new ui.dom.window.Event("cancel", { bubbles: false, cancelable: true }));
  });
  assert.equal(ui.closed, 2);
  assert.equal(ui.requests.filter((r) => r.method === "git.favorites.recovery.restore").length, 1);
  assert.equal(ui.busy.at(-1), true);
  release.resolve();
  await ui.wait(() => ui.closed === 3, "restore acknowledgement closes dialog");
  assert.equal(ui.restored, 1);
  assert.equal(ui.busy.at(-1), false);
  const request = ui.requests.find((r) => r.method === "git.favorites.recovery.restore");
  assert.equal(request.params.expectedRevision, null);
  assert.equal(request.params.expectedMissing, true);
  assert.deepEqual(readFileSync(f.file), f.initial);
});

test("real Core recovery previews ignore late replies and stale restore errors require an explicit catalog reload", async (t) => {
  const f = await fixture(t),
    alpha = digest(f.initial);
  let current = await f.raw("git.favorites.write", {
    directory: f.directory,
    expectedRevision: f.imported.revision,
    references: ["refs/heads/beta"],
  });
  const beta = digest(readFileSync(f.file));
  current = await f.raw("git.favorites.write", {
    directory: f.directory,
    expectedRevision: current.revision,
    references: ["refs/heads/current"],
  });
  const held = signal(),
    release = signal();
  let delayed = false;
  t.after(() => release.resolve());
  const ui = await render(t, f, {
    intercept: async (request) => {
      if (
        !delayed &&
        request.method === "git.favorites.recovery.preview" &&
        request.params.revision === beta
      ) {
        delayed = true;
        held.resolve();
        await release.promise;
      }
    },
  });
  await ui.mount();
  await ui.wait(
    () => ui.dom.window.document.querySelector("select")?.disabled === false,
    "loaded catalog",
  );
  if (ui.dom.window.document.querySelector("select").value !== `backup:${beta}`)
    await ui.choose(`backup:${beta}`);
  await held.promise;
  await ui.choose(`backup:${alpha}`);
  await ui.wait(
    () => ui.button("Restore all repository favorites")?.disabled === false,
    "newer preview response",
  );
  assert.match(ui.dom.window.document.querySelector("textarea").value, /alpha-中文-e\u0301-𝄞/);
  release.resolve();
  await act(async () => {
    await new Promise((done) => setTimeout(done, 60));
  });
  assert.match(ui.dom.window.document.querySelector("textarea").value, /alpha-中文-e\u0301-𝄞/);
  assert.doesNotMatch(ui.dom.window.document.querySelector("textarea").value, /refs\/heads\/beta/);
  await f.raw("git.favorites.write", {
    directory: f.directory,
    expectedRevision: current.revision,
    references: ["refs/heads/other-process"],
  });
  const changed = readFileSync(f.file);
  await ui.click("Restore all repository favorites");
  await ui.wait(
    () => !!ui.dom.window.document.querySelector('[role="alert"]'),
    "stale restore error",
  );
  assert.match(
    ui.dom.window.document.querySelector('[role="alert"]').textContent,
    /changed after preview/i,
  );
  assert.deepEqual(readFileSync(f.file), changed);
  assert.equal(ui.closed, 0);
  assert.equal(ui.requests.filter((r) => r.method === "git.favorites.recovery.restore").length, 1);
  await ui.click("Reload recovery copies");
  await ui.wait(
    () => ui.button("Restore all repository favorites")?.disabled === false,
    "explicit reload after conflict",
  );
  assert.equal(ui.dom.window.document.querySelector('[role="alert"]'), null);
  assert.deepEqual(readFileSync(f.file), changed);
  assert.equal(ui.requests.filter((r) => r.method === "git.favorites.recovery.restore").length, 1);
  await ui.click("Cancel");
  assert.equal(ui.closed, 1);
});
