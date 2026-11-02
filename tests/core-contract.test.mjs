import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { defaults, readSettings } from "../src/lib/settings.ts";
import {
  emptyWorkspace,
  createWorkspaceGroup,
  readWorkspace,
  switchWorkspace,
  removeWorkspace,
  removeProject,
  moveProject,
  selectProject,
} from "../src/lib/workspace.ts";
import { draftKey, readDraft } from "../src/lib/file-document.ts";
import { EditorDraftQueue } from "../src/lib/editor-drafts.ts";
import { ContentFailure, ContentScope, editorDraftMethods } from "../src/lib/content-transport.ts";
import { tauriContentPort } from "../src/lib/tauri-content.ts";

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
async function client(t, existingRoot) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "uterm-contract-"));
  const target = resolve(process.env.CARGO_TARGET_DIR ?? "crates/uterm-core/target");
  const child = spawn(
    join(target, "debug", `uterm-core-contract${process.platform === "win32" ? ".exe" : ""}`),
    ["--serve", root],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  t.after(() => {
    child.kill();
    if (!existingRoot) rmSync(root, { recursive: true, force: true });
  });
  return async (method, params = null, id = crypto.randomUUID()) => {
    child.stdin.write(JSON.stringify({ version: 1, id, method, params }) + "\n");
    const { value, done } = await lines.next();
    assert.equal(done, false, "core process must reply");
    const reply = JSON.parse(value);
    assert.equal(reply.id, id);
    return reply;
  };
}

function queueDraft(path, text) {
  return {
    directory: "/qa/editor",
    path,
    kind: "text",
    text,
    saved: "disk",
    version: "a".repeat(64),
    line_ending: "\n",
    bom: false,
  };
}
function signal() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function draftCall(call) {
  return async (method, params) => {
    const reply = await call(editorDraftMethods[method], params);
    if (reply.error) throw Object.assign(Error(reply.error.message), { code: reply.error.code });
    return reply.result ?? null;
  };
}

test("shared draft queues use Rust document revisions without replacing another writer", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "uterm-draft-clients-"));
  const callA = await client(t, root),
    callB = await client(t, root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = new EditorDraftQueue(draftCall(callA)),
    b = new EditorDraftQueue(draftCall(callB));
  t.after(() => {
    a.close();
    b.close();
  });
  await a.initialize(null);
  await b.initialize(null);
  await a.put(queueDraft("a.txt", "A"));
  await b.put(queueDraft("b.txt", "B"));
  await b.load("/qa/editor", "a.txt");
  await a.put(queueDraft("a.txt", "A new"));
  await assert.rejects(b.put(queueDraft("a.txt", "stale B")), { code: "CONFLICT" });
  await assert.rejects(b.flush(), { code: "CONFLICT" });
  await assert.rejects(b.retry(), { code: "CONFLICT" });
  const current = (
    await callA("editor.drafts.document", { directory: "/qa/editor", path: "a.txt" })
  ).result;
  assert.equal(current.draft.text, "A new");
  await b.remove("/qa/editor", "b.txt");
  assert.equal((await callA("editor.drafts.list")).result.drafts.length, 1);
});

test("draft text coalesces and flush drains writes added during an earlier real Rust write", async (t) => {
  const call = await client(t);
  const invoke = draftCall(call),
    started = signal(),
    release = signal(),
    writes = [],
    completed = [];
  const queue = new EditorDraftQueue(async (method, params) => {
    if (method === "editor_drafts_put") {
      writes.push(params.draft.text);
      if (writes.length === 1) {
        started.resolve();
        await release.promise;
      }
    }
    const result = await invoke(method, params);
    if (method === "editor_drafts_put") completed.push(params.draft.text);
    return result;
  });
  t.after(() => queue.close());
  await queue.initialize(null);
  const first = queue.put(queueDraft("coalesce.txt", "first"));
  await started.promise;
  const second = queue.put(queueDraft("coalesce.txt", "second"));
  const third = queue.put(queueDraft("coalesce.txt", "latest 中文"));
  const late = first.then(() => queue.put(queueDraft("coalesce.txt", "typed during flush 中文")));
  const flushing = queue.flush();
  release.resolve();
  await flushing;
  assert.deepEqual(completed, ["first", "latest 中文", "typed during flush 中文"]);
  await Promise.all([first, second, third, late]);
  assert.deepEqual(writes, completed);
  assert.equal(
    (await call("editor.drafts.document", { directory: "/qa/editor", path: "coalesce.txt" })).result
      .draft.text,
    "typed during flush 中文",
  );
});

test("lost draft delivery is reconciled from actual Rust data without rewriting newer text", async (t) => {
  const call = await client(t),
    invoke = draftCall(call);
  let writes = 0;
  const queue = new EditorDraftQueue(async (method, params) => {
    const result = await invoke(method, params);
    if (method === "editor_drafts_put" && ++writes === 1)
      throw new ContentFailure("TIMEOUT", "Reply delivery was interrupted after commit");
    return result;
  });
  t.after(() => queue.close());
  await queue.initialize(null);
  await assert.rejects(queue.put(queueDraft("reply.txt", "retained after commit")), {
    code: "TIMEOUT",
  });
  await queue.retry();
  assert.equal(writes, 1);
  const other = new EditorDraftQueue(invoke);
  t.after(() => other.close());
  await other.initialize();
  await other.put(queueDraft("reply.txt", "newer external draft"));
  await assert.rejects(queue.put(queueDraft("reply.txt", "stale local text")), {
    code: "CONFLICT",
  });
  await assert.rejects(queue.retry(), { code: "CONFLICT" });
  assert.equal(
    (await call("editor.drafts.document", { directory: "/qa/editor", path: "reply.txt" })).result
      .draft.text,
    "newer external draft",
  );
});

test(
  "closing a draft queue rejects active and waiting delivery but never claims host rollback",
  { timeout: 10000 },
  async (t) => {
    const unopened = await client(t),
      initialCall = draftCall(unopened),
      initialRead = signal(),
      initialRelease = signal();
    let imports = 0;
    const initial = new EditorDraftQueue(async (method, params) => {
      if (method === "editor_drafts_import") imports++;
      try {
        return await initialCall(method, params);
      } catch (reason) {
        initialRead.resolve();
        await initialRelease.promise;
        throw reason;
      }
    });
    const initialization = assert.rejects(initial.initialize(null), { code: "CLOSED" });
    await initialRead.promise;
    initial.close();
    await initialization;
    initialRelease.resolve();
    assert.equal((await unopened("editor.drafts.read")).error.code, "DRAFTS_NOT_IMPORTED");
    assert.equal(imports, 0);
    const call = await client(t),
      invoke = draftCall(call),
      committed = signal(),
      release = signal();
    let writes = 0;
    const queue = new EditorDraftQueue(async (method, params) => {
      const result = await invoke(method, params);
      if (method === "editor_drafts_put") {
        writes++;
        committed.resolve();
        await release.promise;
      }
      return result;
    });
    await queue.initialize(null);
    const first = queue.put(queueDraft("close.txt", "already committed"));
    const rejectedFirst = assert.rejects(first, { code: "CLOSED" });
    await committed.promise;
    const waiting = queue.put(queueDraft("close.txt", "never dispatched"));
    const rejectedWaiting = assert.rejects(waiting, { code: "CLOSED" });
    const flushed = assert.rejects(queue.flush(), { code: "CLOSED" });
    queue.close();
    await Promise.all([rejectedFirst, rejectedWaiting, flushed]);
    release.resolve();
    assert.equal(
      (await call("editor.drafts.document", { directory: "/qa/editor", path: "close.txt" })).result
        .draft.text,
      "already committed",
    );
    assert.equal(writes, 1);
    await assert.rejects(queue.put(queueDraft("close.txt", "late")), { code: "CLOSED" });
  },
);

test("draft queue initialization retry preserves the actual legacy source", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "uterm-draft-import-")),
    call = await client(t, root),
    invoke = draftCall(call);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let fail = true;
  const queue = new EditorDraftQueue(async (method, params) => {
    if (fail && method === "editor_drafts_list") {
      fail = false;
      throw new ContentFailure("IO", "Temporary read failure");
    }
    return invoke(method, params);
  });
  t.after(() => queue.close());
  const raw = ` \n${JSON.stringify(queueDraft("legacy.txt", "old 中文"))}\n`;
  await assert.rejects(queue.initialize(raw), { code: "IO" });
  await assert.rejects(queue.put(queueDraft("legacy.txt", "newer text")), { code: "IO" });
  await queue.retry();
  const stored = (await call("editor.drafts.read")).result;
  assert.equal(stored.document.drafts[0].text, "newer text");
  assert.equal(
    readFileSync(
      join(root, `editor-draft-source-${stored.document.sourceDigest}.original`),
      "utf8",
    ),
    raw,
  );
});

test("draft content scope routes through Tauri to Rust and rejects a misidentified core reply", async (t) => {
  const call = await client(t),
    previous = global.window;
  global.window = {};
  mockIPC(async (command, args) => {
    assert.equal(command, "shared_core_request");
    const request = JSON.parse(args.request);
    return JSON.stringify(await call(request.method, request.params, request.id));
  });
  const scope = new ContentScope(tauriContentPort, "draft-content");
  const queue = new EditorDraftQueue((method, params) => scope.call(method, params));
  t.after(() => {
    queue.close();
    scope.close();
    clearMocks();
    if (previous === undefined) delete global.window;
    else global.window = previous;
  });
  await queue.initialize(null);
  await queue.put(queueDraft("transport.txt", "actual transport 中文"));
  assert.equal(
    (await queue.load("/qa/editor", "transport.txt")).draft.text,
    "actual transport 中文",
  );
  await queue.remove("/qa/editor", "transport.txt");
  await queue.flush();
  assert.equal((await call("editor.drafts.list")).result.drafts.length, 0);
  mockIPC(() => JSON.stringify({ version: 1, id: "another-operation", result: null }));
  await assert.rejects(scope.call("editor_drafts_list"), { code: "INVALID_REPLY" });
});

test("real Rust draft storage preserves legacy text and rejects stale multi-document writes", async (t) => {
  const call = await client(t);
  const original = {
    id: 19,
    directory: "/qa/editor",
    path: "中文.md",
    kind: "text",
    text: "未保存 é\r\n",
    saved: "saved\r\n",
    version: "a".repeat(64),
    line_ending: "\r\n",
    bom: true,
  };
  const raw = ` \n${JSON.stringify(original)}\n`;
  const legacy = readDraft(raw);
  const baseline = await call("state.defaults");
  const imported = await call("migration.import", {
    workspace: baseline.result.workspace,
    settings: baseline.result.settings,
    legacy: { [draftKey]: raw },
  });
  assert.ok(imported.result);
  const drafts = await call("editor.drafts.import");
  assert.equal(drafts.error, undefined);
  const recovered = readDraft(JSON.stringify(drafts.result.document.drafts[0]));
  assert.equal(recovered.text, legacy.text);
  assert.equal(recovered.saved, legacy.saved);
  assert.equal(recovered.bom, true);
  assert.equal(recovered.line_ending, "\r\n");
  const next = await call("editor.drafts.put", {
    expectedRevision: drafts.result.revision,
    draft: { ...original, path: "second.txt", text: "second draft" },
  });
  assert.equal(next.result.document.drafts.length, 2);
  const stale = await call("editor.drafts.remove", {
    expectedRevision: drafts.result.revision,
    directory: original.directory,
    path: original.path,
  });
  assert.equal(stale.error.code, "CONFLICT");
  const current = await call("editor.drafts.read");
  assert.equal(current.result.revision, next.result.revision);
  assert.equal(current.result.document.drafts.length, 2);
  const sources = await call("editor.drafts.recovery.list");
  assert.equal(sources.result.sources.length, 1);
  const retained = await call("legacy.export");
  assert.equal(retained.result.values[draftKey], raw);
});

test("real Rust core preserves legacy defaults and normalized workspace/project transitions", async (t) => {
  const call = await client(t);
  const baseline = (await call("state.defaults")).result;
  assert.deepEqual(baseline.settings, defaults);
  assert.deepEqual(baseline.workspace, emptyWorkspace());
  const workspace = readWorkspace(
    JSON.stringify({
      ...emptyWorkspace(),
      groups: [createWorkspaceGroup("local", "本地"), createWorkspaceGroup("other", "Other")],
      projects: [
        {
          id: "p",
          name: "项目",
          directory: "/tmp/项目",
          workspaceId: "local",
          sessions: [{ id: "s", name: "终端", shell: "default" }],
        },
        { id: "q", name: "Other", directory: "/tmp/other", workspaceId: "other", sessions: [] },
      ],
    }),
  );
  let actual = (await call("migration.import", { workspace, settings: defaults, legacy: {} }))
    .result;
  let expected = workspace;
  for (const [method, params, legacy] of [
    ["workspace.switch", { id: "other" }, (w) => switchWorkspace(w, "other")],
    ["workspace.switch", { id: "local" }, (w) => switchWorkspace(w, "local")],
    ["project.select", { id: "p", worktreeId: null }, (w) => selectProject(w, "p")],
    ["project.remove", { id: "p" }, (w) => removeProject(w, "p")],
    ["project.move", { id: "q", workspaceId: "local" }, (w) => moveProject(w, "q", "local")],
    ["workspace.remove", { id: "other" }, (w) => removeWorkspace(w, "other")],
  ]) {
    expected = legacy(expected);
    const response = await call(method, { ...params, expectedRevision: actual.revision });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    actual = response.result;
    assert.deepEqual(actual.document.workspace, expected, method);
  }
});

test("Tauri adoption serializes real core writes, preserves source keys and blocks stale queues", async (t) => {
  const call = await client(t);
  const dom = new JSDOM("", { url: "http://localhost/" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: dom.window.localStorage,
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
  });
  t.after(async () => {
    clearMocks();
    await server.close();
    dom.window.close();
  });
  const original = JSON.stringify({ ...emptyWorkspace(), version: 3 });
  localStorage.setItem("uterm.desktop.workspace.v1", original);
  localStorage.setItem("uterm.desktop.editorDraft.v1", '{"text":"未保存"}');
  mockIPC(async (command, args) => {
    assert.equal(command, "shared_core_request");
    const request = JSON.parse(args.request);
    return JSON.stringify(await call(request.method, request.params, request.id));
  });
  const state = await server.ssrLoadModule("/src/lib/shared-state.ts");
  await state.initializeSharedState();
  const first = state.persistWorkspace((w) => ({
    ...w,
    groups: [...w.groups, createWorkspaceGroup("second", "二")],
  }));
  const settings = state.persistSettings((s) => ({ ...s, fontSize: 19 }));
  const second = state.persistWorkspace((w) => ({
    ...w,
    groups: w.groups.map((g) => (g.id === "second" ? { ...g, name: "renamed" } : g)),
  }));
  await Promise.all([first, settings, second]);
  await state.flushSharedState();
  const persisted = (await call("snapshot.read")).result;
  assert.equal(persisted.document.workspace.groups[1].name, "renamed");
  assert.equal(persisted.document.settings.fontSize, 19);
  assert.equal(localStorage.getItem("uterm.desktop.workspace.v1"), original);
  assert.equal(persisted.document.legacy["uterm.desktop.editorDraft.v1"], '{"text":"未保存"}');
  const external = await call("settings.patch", {
    expectedRevision: persisted.revision,
    patch: { fontSize: 21 },
  });
  assert.equal(external.error, undefined);
  await assert.rejects(
    state.persistWorkspace((w) => ({ ...w, selectedSession: "stale" })),
    { code: "CONFLICT" },
  );
  await assert.rejects(
    state.persistSettings((s) => ({ ...s, fontSize: 20 })),
    { code: "CONFLICT" },
  );
  await assert.rejects(state.flushSharedState(), { code: "CONFLICT" });
  await state.initializeSharedState();
  await state.persistSettings((s) => ({ ...s, opacity: 0.8 }));
  assert.equal((await call("snapshot.read")).result.document.settings.fontSize, 21);
});

test("real Rust validation rejects malformed snapshots and agrees with settings boundaries", async (t) => {
  const call = await client(t);
  const imported = (
    await call("migration.import", { workspace: emptyWorkspace(), settings: defaults, legacy: {} })
  ).result;
  for (const patch of [
    { fontSize: 9 },
    { fontSize: 10 },
    { fontSize: 32 },
    { fontSize: 32.1 },
    { fileFontSize: 12.5 },
    { opacity: 0.3 },
    { opacity: 0.299 },
    { enabledAgents: ["codex", "codex"] },
    { shortcuts: { palette: "Mod+Alt+Shift+KeyP" } },
    { activeIconColor: "#FFFFFF" },
    { activeIconColor: "#fff" },
    { interfaceFont: "😀".repeat(151) },
  ]) {
    const settings = { ...defaults, ...patch };
    let accepted = true;
    try {
      readSettings(JSON.stringify(settings));
    } catch {
      accepted = false;
    }
    const reply = await call("snapshot.replace", {
      expectedRevision: imported.revision,
      workspace: emptyWorkspace(),
      settings,
    });
    if (accepted) {
      assert.equal(reply.error, undefined, JSON.stringify(patch));
      imported.revision = reply.result.revision;
    } else {
      assert.equal(reply.error?.code, "INVALID_SETTINGS", JSON.stringify(patch));
    }
  }
  const invalid = emptyWorkspace();
  invalid.groups[0].terminals = [
    { id: "unsafe", name: "shell", shell: "default", directory: "/tmp", unexpected: true },
  ];
  assert.throws(() => readWorkspace(JSON.stringify(invalid)));
  const reply = await call("snapshot.replace", {
    expectedRevision: imported.revision,
    workspace: invalid,
    settings: defaults,
  });
  assert.equal(reply.error?.code, "INVALID_WORKSPACE");
  const fixture = JSON.parse(readFileSync("shared/fixtures/legacy-state.json", "utf8"));
  assert.deepEqual(fixture.settings, defaults);
});

test("legacy export is readable by unchanged release readers and retains opaque recovery keys", async (t) => {
  const call = await client(t);
  const legacy = {
    "uterm.desktop.workspace.v1": ' {"version":3} ',
    "uterm.desktop.settings.v1": "{}",
    "uterm.desktop.editorDraft.v1": '{"text":"未保存\\n中文","future":null}',
    "uterm.desktop.editorDraft.v1.invalid": "{broken draft",
    "uterm.desktop.workspace.v1.backup": "  original backup bytes  ",
    "uterm.git.favorites:/temporary/repository": '["main"]',
  };
  let snapshot = (
    await call("migration.import", { workspace: emptyWorkspace(), settings: defaults, legacy })
  ).result;
  for (const [method, params] of [
    ["session.create", { id: "first", name: "中文终端", directory: "/temporary/项目" }],
    [
      "session.split",
      { anchor: "first", id: "peer", name: "Peer", splitId: "split", axis: "horizontal" },
    ],
    ["settings.patch", { patch: { fontSize: 21, language: "zh-Hans", appearance: "light" } }],
  ]) {
    const response = await call(method, { ...params, expectedRevision: snapshot.revision });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    snapshot = response.result;
  }
  const exported = (await call("legacy.export")).result;
  assert.equal(exported.revision, snapshot.revision);
  assert.deepEqual(
    readWorkspace(exported.values["uterm.desktop.workspace.v1"]),
    snapshot.document.workspace,
  );
  assert.deepEqual(
    readSettings(exported.values["uterm.desktop.settings.v1"]),
    snapshot.document.settings,
  );
  for (const [key, value] of Object.entries(legacy)) {
    if (key === "uterm.desktop.workspace.v1" || key === "uterm.desktop.settings.v1") continue;
    assert.equal(exported.values[key], value, key);
  }
  const repeated = await call("migration.import", {
    workspace: emptyWorkspace(),
    settings: defaults,
    legacy,
  });
  assert.equal(repeated.result.revision, snapshot.revision);
  assert.deepEqual((await call("legacy.export")).result, exported);
});

test("Rust request failures retain operation identity and missing/null values do not reset state", async (t) => {
  const call = await client(t);
  const baseline = (await call("state.defaults")).result;
  const imported = (
    await call("migration.import", {
      workspace: baseline.workspace,
      settings: baseline.settings,
      legacy: {},
    })
  ).result;
  for (const params of [
    { settings: baseline.settings },
    { workspace: null, settings: baseline.settings },
    { workspace: baseline.workspace, settings: null },
    { workspace: baseline.workspace },
    { workspace: {}, settings: baseline.settings },
  ]) {
    const response = await call(
      "snapshot.replace",
      { ...params, expectedRevision: imported.revision },
      "boundary-failure",
    );
    assert.equal(response.id, "boundary-failure");
    assert.equal(response.version, 1);
    assert.equal(typeof response.error.code, "string");
    assert.equal(typeof response.error.recoverable, "boolean");
    assert.equal(response.result, undefined);
    assert.deepEqual((await call("snapshot.read")).result, imported);
  }
  assert.deepEqual((await call("snapshot.read", null)).result, imported);
  const unknown = await call("unknown.operation", null, "unknown-id");
  assert.equal(unknown.id, "unknown-id");
  assert.equal(unknown.error.code, "UNKNOWN_METHOD");
  const empty = await call("settings.patch", {
    expectedRevision: imported.revision,
    patch: { enabledAgents: [] },
  });
  assert.equal(empty.error, undefined);
  assert.deepEqual(empty.result.document.settings.enabledAgents, []);
});

test("shared files preserve BOM, line endings, CAS conflicts and readonly previews through a real Rust process", async (t) => {
  const call = await client(t);
  const directory = mkdtempSync(join(tmpdir(), "uterm-files-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = "中文.txt";
  writeFileSync(join(directory, path), "\ufeff第一行\r\nsecond\r\n");
  const initial = (await call("files.read", { directory, path })).result;
  assert.equal(initial.bom, true);
  assert.equal(initial.line_ending, "\r\n");
  assert.equal(initial.text, "第一行\r\nsecond\r\n");
  const listing = await call("files.list", { directory, path: "", hidden: false });
  assert.equal(listing.result.entries[0].path, path);
  const text = "\ufeff已保存\r\n";
  const saved = await call("files.save", {
    directory,
    path,
    text,
    expected: initial.version,
    force: false,
  });
  assert.equal(saved.error, undefined);
  assert.equal(readFileSync(join(directory, path), "utf8"), text);
  writeFileSync(join(directory, path), "external");
  const conflict = await call("files.save", {
    directory,
    path,
    text: "draft",
    expected: saved.result,
    force: false,
  });
  assert.equal(conflict.error.code, "CONFLICT");
  assert.equal(readFileSync(join(directory, path), "utf8"), "external");
  const forced = await call("files.save", {
    directory,
    path,
    text: "explicit override",
    expected: saved.result,
    force: true,
  });
  assert.equal(forced.error, undefined);
  assert.equal(readFileSync(join(directory, path), "utf8"), "explicit override");
  writeFileSync(join(directory, "mixed.txt"), "LF\nCR\r");
  assert.equal((await call("files.read", { directory, path: "mixed.txt" })).result.readonly, true);
  assert.equal(
    (
      await call("files.save", {
        directory,
        path: "mixed.txt",
        text: "loss",
        expected: "",
        force: true,
      })
    ).error.code,
    "FILE_ERROR",
  );
  assert.equal(readFileSync(join(directory, "mixed.txt"), "utf8"), "LF\nCR\r");
  writeFileSync(join(directory, "preview.pdf"), "%PDF-1.7\nfixture");
  const pdf = (await call("files.read", { directory, path: "preview.pdf" })).result;
  assert.equal(pdf.kind, "pdf");
  assert.equal(pdf.readonly, true);
});

test("shared file requests reject root escape, linked writes and malformed parameters", async (t) => {
  const call = await client(t);
  const root = mkdtempSync(join(tmpdir(), "uterm-files-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(directory);
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "untouched");
  symlinkSync(
    outside,
    join(directory, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const path of ["../outside/keep.txt", "linked/keep.txt"]) {
    assert.equal((await call("files.read", { directory, path })).error.code, "FILE_ERROR");
    assert.equal(
      (await call("files.save", { directory, path, text: "escape", expected: "", force: true }))
        .error.code,
      "FILE_ERROR",
    );
  }
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "untouched");
  for (const params of [
    null,
    { directory, path: null },
    { directory, path: "", capability: "exec" },
  ]) {
    assert.equal((await call("files.read", params)).error.code, "INVALID_PARAMS");
  }
  assert.equal((await call("files.exec", { directory, path: "" })).error.code, "INVALID_PARAMS");
});

test("settings saves from a stale view change only its requested fields", async (t) => {
  const call = await client(t);
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await React.act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  });
  mockIPC(async (command, args) => {
    if (command === "window_appearance") return null;
    assert.equal(command, "shared_core_request");
    const request = JSON.parse(args.request);
    return JSON.stringify(await call(request.method, request.params, request.id));
  });
  const state = await server.ssrLoadModule("/src/lib/shared-state.ts");
  await state.initializeSharedState();
  const { SettingsProvider, useSettings } = await server.ssrLoadModule(
    "/src/lib/SettingsContext.tsx",
  );
  let context;
  function Harness() {
    context = useSettings();
    return null;
  }
  await React.act(async () =>
    root.render(React.createElement(SettingsProvider, null, React.createElement(Harness))),
  );
  const stale = context.settings;
  await React.act(async () => {
    await context.save({ ...stale, fontSize: 18 }, false, stale);
    await context.save({ ...stale, opacity: 0.8 }, false, stale);
  });
  const stored = (await call("snapshot.read")).result.document.settings;
  assert.equal(stored.fontSize, 18, "A stale view must not revert another committed setting");
  assert.equal(stored.opacity, 0.8);
  assert.equal(context.settings.fontSize, 18);
  const external = (await call("snapshot.read")).result;
  await call("settings.patch", {
    expectedRevision: external.revision,
    patch: { fileFontSize: 17, fontSize: 21 },
  });
  const previous = context.settings;
  await React.act(async () => {
    await assert.rejects(context.save({ ...previous, fileFontSize: 19 }, false, previous), {
      code: "CONFLICT",
    });
  });
  assert.equal(
    context.settings.fileFontSize,
    previous.fileFontSize,
    "Uncommitted draft must not be published",
  );
  assert.equal(context.failedSettings.fileFontSize, 19);
  assert.throws(context.assertSaved);
  await React.act(async () => context.reload());
  assert.equal(context.settings.fileFontSize, 17, "Explicit reload sees external writes");
  assert.equal(context.settings.fontSize, 21);
  assert.equal(
    context.failedSettings.fileFontSize,
    19,
    "Reload keeps a draft even for the same changed field",
  );
  assert.throws(context.assertSaved, "Reload alone must not allow quitting with an unsaved draft");
  await React.act(async () =>
    context.save({ ...context.settings, ...context.failedSettings }, false, context.settings),
  );
  assert.deepEqual(context.failedSettings, {});
  assert.doesNotThrow(context.assertSaved);
  assert.equal((await call("snapshot.read")).result.document.settings.fileFontSize, 19);
});

test("explicit reload is serialized with saves and cannot publish an old snapshot afterwards", async (t) => {
  const call = await client(t);
  const dom = new JSDOM("", { url: "http://localhost/" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: dom.window.localStorage,
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
  });
  t.after(async () => {
    clearMocks();
    await server.close();
    dom.window.close();
  });
  let hold = false;
  let arrived;
  let release;
  const started = new Promise((done) => {
    arrived = done;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  let written = false;
  mockIPC(async (command, args) => {
    assert.equal(command, "shared_core_request");
    const request = JSON.parse(args.request);
    const response = await call(request.method, request.params, request.id);
    if (hold && request.method === "snapshot.read") {
      arrived();
      await gate;
    }
    if (request.method === "snapshot.replace") written = true;
    return JSON.stringify(response);
  });
  const state = await server.ssrLoadModule("/src/lib/shared-state.ts");
  await state.initializeSharedState();
  hold = true;
  const reload = state.initializeSharedState();
  await started;
  const saving = state.persistSettings((s) => ({ ...s, fileFontSize: 20 }));
  try {
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(written, false, "A save cannot overtake a captured reload response");
  } finally {
    release();
    await Promise.allSettled([reload, saving]);
  }
  assert.equal(state.sharedSettings().fileFontSize, 20);
  await state.persistSettings((s) => ({ ...s, opacity: 0.7 }));
  assert.equal((await call("snapshot.read")).result.document.settings.fileFontSize, 20);
});

test("quit flushing waits for saves enqueued while the first save is still running", async (t) => {
  const call = await client(t);
  const dom = new JSDOM("", { url: "http://localhost/" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: dom.window.localStorage,
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
  });
  t.after(async () => {
    clearMocks();
    await server.close();
    dom.window.close();
  });
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const gates = [deferred(), deferred()],
    started = [deferred(), deferred()];
  let writes = 0;
  mockIPC(async (command, args) => {
    assert.equal(command, "shared_core_request");
    const request = JSON.parse(args.request);
    if (request.method === "snapshot.replace") {
      const index = writes++;
      started[index].resolve();
      await gates[index].promise;
    }
    return JSON.stringify(await call(request.method, request.params, request.id));
  });
  const state = await server.ssrLoadModule("/src/lib/shared-state.ts");
  await state.initializeSharedState();
  const first = state.persistSettings((settings) => ({ ...settings, fontSize: 18 }));
  await started[0].promise;
  let flushed = false;
  const flushing = state.flushSharedState().then(() => {
    flushed = true;
  });
  const second = state.persistSettings((settings) => ({ ...settings, opacity: 0.8 }));
  try {
    gates[0].resolve();
    await started[1].promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(flushed, false, "Quit must wait for the later queued durable write");
  } finally {
    gates.forEach((gate) => gate.resolve());
    await Promise.allSettled([first, second, flushing]);
  }
  const stored = (await call("snapshot.read")).result.document.settings;
  assert.equal(stored.fontSize, 18);
  assert.equal(stored.opacity, 0.8);
});
