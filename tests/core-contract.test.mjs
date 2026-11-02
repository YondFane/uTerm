import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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
async function client(t) {
  const root = mkdtempSync(join(tmpdir(), "uterm-contract-"));
  const target = resolve(process.env.CARGO_TARGET_DIR ?? "crates/uterm-core/target");
  const child = spawn(
    join(target, "debug", `uterm-core-contract${process.platform === "win32" ? ".exe" : ""}`),
    ["--serve", root],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  t.after(() => {
    child.kill();
    rmSync(root, { recursive: true, force: true });
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
