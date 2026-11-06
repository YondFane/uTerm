import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  renameSync,
  existsSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import {
  binding,
  commands,
  defaults,
  readSettings,
  validateShortcuts,
} from "../src/lib/settings.ts";
import { importTheme } from "../src/lib/themes.ts";
import {
  emptyWorkspace,
  createWorkspaceGroup,
  readWorkspace,
  switchWorkspace,
  removeWorkspace,
  removeProject,
  moveProject,
  selectProject,
  reconcileWorktrees,
} from "../src/lib/workspace.ts";
import { draftKey, readDraft } from "../src/lib/file-document.ts";
import { EditorDraftQueue } from "../src/lib/editor-drafts.ts";
import { EditorDraftHandoff, editorDraftReceiptKey } from "../src/lib/editor-draft-handoff.ts";
import { ContentFailure, ContentScope, editorDraftMethods } from "../src/lib/content-transport.ts";
import { tauriContentPort } from "../src/lib/tauri-content.ts";
import { webKitContentPort } from "../src/lib/webkit-content.ts";
import { SharedGitFavorites } from "../src/lib/git-favorites.ts";
import { gitFavoriteMethods } from "../src/lib/content-transport.ts";

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

test("native settings catalog preserves defaults and matches both platform shortcut validators without writes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "uterm-settings-readonly-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const call = await client(t, root);
  const before = readdirSync(root);
  const response = await call("settings.catalog");
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result.defaults, defaults);
  assert.deepEqual(
    response.result.commands.map((command) => command.id),
    commands.map(([id]) => id),
  );
  assert.deepEqual(
    new Set(response.result.settingsKeys),
    new Set([...Object.keys(defaults), "agentNotifications"]),
  );
  for (const command of response.result.commands) {
    assert.ok(command.labels.en && command.labels["zh-Hans"]);
  }
  for (const [platform, mac] of [
    ["macos", true],
    ["windows", false],
  ]) {
    for (const [id] of commands) {
      for (const shortcut of [
        "",
        "Mod+KeyC",
        "Mod+Alt+KeyF",
        "Mod+Minus",
        "Mod+Shift+KeyF",
        "Mod+Shift+KeyQ",
      ]) {
        const settings = { ...defaults, shortcuts: { [id]: shortcut } };
        let expected = true;
        try {
          validateShortcuts(settings, mac);
        } catch {
          expected = false;
        }
        const actual = await call("settings.validate", { settings, platform });
        assert.equal(!actual.error, expected, `${platform}/${id}/${shortcut}`);
        const resolved = await call("settings.commands", { settings, platform });
        assert.equal(resolved.error, undefined);
        for (const command of resolved.result) {
          assert.equal(command.shortcut, binding(settings, command.id, mac));
        }
      }
    }
  }
  const rejected = await call("settings.validate", {
    settings: defaults,
    platform: "unsupported",
    credential: "private-must-not-appear",
  });
  assert.equal(rejected.error.code, "SETTINGS_INVALID_PARAMS");
  assert.equal(JSON.stringify(rejected).includes("private-must-not-appear"), false);
  let themeCases = 0;
  for (const name of [
    "  My Theme!  ",
    "中文 / É",
    "ΟΣ",
    "ΟΣΑ",
    "\uFEFFTheme\uFEFF",
    "",
    "x".repeat(81),
    "😀".repeat(41),
  ]) {
    for (const source of [
      "background = #ABCDEF",
      "palette = 15 = aabbcc\ncursor-color=123456",
      "foreground=111111\nforeground=222222",
      "unknown=ignored\nbackground=012345",
      "palette=16=123456",
      "background=#12345g",
      "palette=0=123456 \n",
      `palette=${"0".repeat(200)}1=123456`,
      "background=ignored\u2028line\nforeground=123456",
      "background\u2028=\u2029#123456",
      "",
      "#".repeat(32001),
    ]) {
      let expected;
      try {
        expected = importTheme(source, name);
      } catch {}
      const response = await call("settings.theme.import", { source, name });
      assert.equal(
        !response.error,
        !!expected,
        `theme/${JSON.stringify(name)}/${source.slice(0, 50)}`,
      );
      if (expected) assert.deepEqual(response.result, expected);
      else assert.equal(response.error.code, "THEME_INVALID");
      themeCases++;
    }
  }
  const themePrivate = await call("settings.theme.import", {
    source: "private-must-not-appear",
    name: "QA",
    credential: "private-must-not-appear",
  });
  assert.equal(themePrivate.error.code, "THEME_INVALID");
  assert.equal(JSON.stringify(themePrivate).includes("private-must-not-appear"), false);
  assert.deepEqual(
    readdirSync(root),
    before,
    "Opening and validating settings must not persist defaults",
  );
  if (process.env.UTERM_SETTINGS_REPORT) {
    const tested = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    let dirty = false;
    try {
      execFileSync("git", ["diff", "--quiet", "HEAD"]);
    } catch {
      dirty = true;
    }
    writeFileSync(
      process.env.UTERM_SETTINGS_REPORT,
      JSON.stringify(
        {
          passed: true,
          sourceHeadSHA: process.env.PR_HEAD_SHA ?? tested,
          testedMergeSHA: tested,
          sourceTreeDirty: dirty,
          platform: process.platform,
          architecture: process.arch,
          commands: commands.length,
          differentialCases: commands.length * 12,
          resolvedBindingComparisons: commands.length * 12 * commands.length,
          themeDifferentialCases: themeCases,
          actualRustProcessAndTypeScript: true,
          defaultsUnchanged: true,
          storeUnchanged: true,
          invalidPlatformRejectedWithoutPrivateParameters: true,
          nativeUiAcceptance: false,
        },
        null,
        2,
      ) + "\n",
    );
  }
});

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

test("shared SSH resolution uses OpenSSH and rejects secrets without echoing their values", async (t) => {
  const call = await client(t);
  const info = await call("ssh.info");
  assert.equal(info.error, undefined);
  assert.equal(info.result.available, true);
  assert.ok(info.result.aliases.every((alias) => typeof alias === "string"));
  const connection = {
    connection_id: "qa",
    workspace_id: "local",
    name: "QA",
    host: "127.0.0.1",
    os: "posix",
    root: "",
    mode: "direct",
    port: 2222,
    username: "qa-user",
  };
  const resolved = await call("ssh.resolve", { connection });
  assert.equal(resolved.error, undefined);
  assert.deepEqual(Object.keys(resolved.result).sort(), ["hostname", "port", "proxy", "username"]);
  assert.equal(resolved.result.hostname, "127.0.0.1");
  assert.equal(resolved.result.username, "qa-user");
  assert.equal(resolved.result.port, "2222");
  assert.equal(typeof resolved.result.proxy, "boolean");
  for (const params of [
    { connection: { ...connection, password: "DONT_EXPORT_SECRET" } },
    { connection, password: "DONT_EXPORT_SECRET" },
  ]) {
    const failure = await call("ssh.resolve", params);
    assert.equal(failure.error.code, "INVALID_JSON");
    assert.equal(JSON.stringify(failure).includes("DONT_EXPORT_SECRET"), false);
  }
  assert.equal(
    (await call("ssh.info", { password: "DONT_EXPORT_SECRET" })).error.code,
    "INVALID_PARAMS",
  );
  assert.equal(
    (await call("ssh.resolve", { connection: { ...connection, host: "-bad" } })).error.code,
    "SSH_INVALID_HOST",
  );
});

test("shared Python path validation preserves literal selections and refuses project escape", async (t) => {
  const call = await client(t),
    { directory } = gitFixture(t);
  const script = join(directory, "literal 中文 & %.py");
  writeFileSync(script, "print('fixture')\n");
  const selected = await call("python.path.validate", { directory, path: script, kind: "script" });
  assert.equal(selected.error, undefined);
  assert.equal(selected.result, "literal 中文 & %.py");
  const outside = resolve(directory, "..");
  assert.equal(
    (await call("python.path.validate", { directory, path: outside, kind: "directory" })).error
      .code,
    "PYTHON_PROJECT_INVALID",
  );
  assert.equal(
    (await call("python.path.validate", { directory, path: script, kind: "unknown" })).error.code,
    "PYTHON_CONFIG_INVALID",
  );
  assert.equal(
    (await call("python.path.validate", { directory, path: script, kind: "interpreter" })).result,
    script,
  );
});

test("shared Java configuration retains defaults, global/project CAS, busy retries and damaged bytes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "uterm-java-config-")),
    store = join(root, "shared-state-v1"),
    a = await client(t, store),
    b = await client(t, store),
    directory = gitFixture(t).directory,
    folder = join(root, "java-build-v1"),
    path = join(folder, "configuration.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initial = await a("java.configuration", { directory });
  assert.equal(initial.error, undefined);
  assert.equal(initial.result.revision, "missing");
  assert.equal(initial.result.configured, false);
  assert.equal(initial.result.project.java_version, 21);
  assert.equal(initial.result.project.mode, "development");
  assert.equal(initial.result.project.maven_scope, "global");
  assert.equal(existsSync(folder), false, "Reading defaults must not create configuration");
  assert.deepEqual((await a("java.tasks", { directory })).result, []);
  assert.equal(existsSync(join(root, "local-daemon-v1")), false);
  const project = {
    ...initial.result.project,
    mode: "jar",
    jar: "target/literal 中文 & %.jar",
    arguments: ["", "&", "e\u0301\r\n"],
  };
  const global = { ...initial.result.global, home: "literal & %PATH%" };
  const params = { directory, revision: "missing", project, global };
  const saved = await a("java.saveConfiguration", params);
  assert.equal(saved.error, undefined);
  assert.deepEqual(saved.result.project, project);
  assert.deepEqual(saved.result.global, global);
  const bytes = readFileSync(path);
  assert.equal((await b("java.saveConfiguration", params)).error.code, "JAVA_CONFIG_CONFLICT");
  assert.deepEqual(readFileSync(path), bytes);
  const release = await holdWriter(t, folder);
  const retry = {
    ...params,
    revision: saved.result.revision,
    project: { ...project, offline: true },
  };
  assert.equal((await b("java.saveConfiguration", retry)).error.code, "JAVA_CONFIG_BUSY");
  assert.deepEqual(readFileSync(path), bytes);
  const home = process.env.JAVA_HOME;
  assert.ok(home, "Set JAVA_HOME to a real JDK 21 for the shared-service checks");
  assert.equal(
    (await b("java.jdks.register", { home, remove: false })).error.code,
    "JAVA_CONFIG_BUSY",
  );
  assert.equal(existsSync(join(folder, "jdks.json")), false);
  await release();
  const retried = await b("java.saveConfiguration", retry);
  assert.equal(retried.error, undefined);
  assert.equal((await a("java.configuration", { directory })).result.project.offline, true);
  const registered = await b("java.jdks.register", { home, remove: false });
  assert.equal(registered.error, undefined);
  assert.ok(registered.result.some((jdk) => jdk.registered && jdk.available && jdk.version === 21));
  const afterSave = readFileSync(path);
  assert.equal((await a("java.jdks.register", { home, remove: true })).error, undefined);
  assert.deepEqual(readFileSync(path), afterSave, "Registry updates preserve configuration bytes");
  assert.equal(existsSync(home), true, "Removing a registry entry must not delete the JDK");
  const damaged = Buffer.from("{damaged Java configuration 中文");
  writeFileSync(path, damaged);
  assert.equal((await a("java.configuration", { directory })).error.code, "JAVA_CONFIG_INVALID");
  assert.equal(
    (await b("java.saveConfiguration", { ...retry, revision: retried.result.revision })).error.code,
    "JAVA_CONFIG_INVALID",
  );
  assert.deepEqual(readFileSync(path), damaged);
});

test("shared Python configuration preserves defaults, cross-process CAS, busy errors and damaged bytes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "uterm-python-config-")),
    store = join(root, "shared-state-v1"),
    a = await client(t, store),
    b = await client(t, store),
    directory = gitFixture(t).directory,
    path = join(root, "python-run-v1/configuration.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initial = await a("python.configuration", { directory });
  assert.equal(initial.error, undefined);
  assert.equal(initial.result.revision, "missing");
  assert.equal(initial.result.configured, false);
  assert.equal(
    existsSync(join(root, "python-run-v1")),
    false,
    "Reading defaults must not persist them",
  );
  assert.deepEqual((await a("python.tasks", { directory })).result, []);
  assert.equal(
    existsSync(join(root, "local-daemon-v1")),
    false,
    "Reading tasks must not start a host",
  );
  const config = {
    ...initial.result.project,
    target: "literal 中文 & %.py",
    arguments: ["", "&", "e\u0301\r\n"],
  };
  const saved = await a("python.saveConfiguration", { directory, revision: "missing", config });
  assert.equal(saved.error, undefined);
  assert.deepEqual(saved.result.project, config);
  const bytes = readFileSync(path);
  assert.equal(
    (await b("python.saveConfiguration", { directory, revision: "missing", config })).error.code,
    "PYTHON_CONFIG_CONFLICT",
  );
  assert.deepEqual(readFileSync(path), bytes);
  const release = await holdWriter(t, join(root, "python-run-v1"));
  const params = {
    directory,
    revision: saved.result.revision,
    config: { ...config, target: "explicit retry.py" },
  };
  assert.equal((await b("python.saveConfiguration", params)).error.code, "PYTHON_CONFIG_BUSY");
  assert.deepEqual(readFileSync(path), bytes);
  await release();
  const retried = await b("python.saveConfiguration", params);
  assert.equal(retried.error, undefined);
  assert.equal(
    (await a("python.configuration", { directory })).result.project.target,
    "explicit retry.py",
  );
  const damaged = Buffer.from("{damaged Python configuration 中文");
  writeFileSync(path, damaged);
  assert.equal(
    (await a("python.configuration", { directory })).error.code,
    "PYTHON_CONFIG_INVALID",
  );
  assert.equal(
    (await a("python.saveConfiguration", { ...params, revision: retried.result.revision })).error
      .code,
    "PYTHON_CONFIG_INVALID",
  );
  assert.deepEqual(readFileSync(path), damaged);
});

test("shared Python runs a real task with literal arguments, exit status and generation-safe stop", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "uterm-python-task-")),
    directory = join(root, "project"),
    call = await client(t, join(root, "shared-state-v1"));
  mkdirSync(directory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const interpreter = execFileSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-c", "import sys; print(sys.executable)"],
    { encoding: "utf8" },
  ).trim();
  const hostTarget = resolve(process.env.CARGO_TARGET_DIR ?? "crates/utermd-local/target");
  execFileSync(
    "cargo",
    [
      "build",
      "--quiet",
      "--locked",
      "--manifest-path",
      "crates/utermd-local/Cargo.toml",
      "--bin",
      "utermd-local",
    ],
    { stdio: "inherit" },
  );
  assert.equal(
    (
      await call("host.configure", {
        helper: join(
          hostTarget,
          "debug",
          `utermd-local${process.platform === "win32" ? ".exe" : ""}`,
        ),
      })
    ).error,
    undefined,
  );
  const started = [];
  try {
    writeFileSync(
      join(directory, "task 中文 & %.py"),
      "import sys,os,time\nprint('READY:'+sys.argv[1]+':'+os.environ['VALUE'],flush=True)\ntime.sleep(0.1)\nprint('LAST:中文 e\\u0301',flush=True)\nsys.exit(7)\n",
    );
    const config = {
      ...(await call("python.configuration", { directory })).result.project,
      interpreter,
      target: "task 中文 & %.py",
      arguments: ["literal & %PATH%"],
    };
    const launched = await call("python.start", {
      directory,
      config,
      environment: { VALUE: "环境 & %PATH%" },
    });
    assert.equal(launched.error, undefined);
    const task = launched.result;
    started.push(task);
    assert.match(task.task.action, /^python:/);
    assert.equal(
      (await call("python.stop", { id: task.spec.id, generation: "stale", force: true })).error
        .code,
      "PYTHON_TASK_REPLACED",
    );
    const deadline = Date.now() + 10000;
    let finished;
    while (Date.now() < deadline) {
      finished = (await call("python.tasks", { directory })).result.find(
        (item) => item.spec.id === task.spec.id,
      );
      if (finished && !finished.running) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(finished.running, false);
    assert.equal(finished.code, 7);
    const read = await call("host.status");
    assert.equal(read.error, undefined);
    t.diagnostic(
      `real Python ${interpreter}: literal argv/environment, generation ${task.generation}, final exit code 7`,
    );
    writeFileSync(
      join(directory, "long.py"),
      "import time\nprint('LONG_READY',flush=True)\ntime.sleep(60)\n",
    );
    const running = await call("python.start", {
      directory,
      config: { ...config, target: "long.py" },
      environment: {},
    });
    assert.equal(running.error, undefined);
    started.push(running.result);
    assert.equal(
      (
        await call("python.stop", {
          id: running.result.spec.id,
          generation: running.result.generation,
          force: true,
        })
      ).error,
      undefined,
    );
    assert.equal(
      (await call("python.stop", { id: "another-task", generation: task.generation, force: true }))
        .error.code,
      "PYTHON_TASK_MISSING",
    );
  } finally {
    if (existsSync(join(root, "local-daemon-v1/endpoint.json"))) {
      for (const task of started)
        await call("python.stop", { id: task.spec.id, generation: task.generation, force: true });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const tasks = (await call("python.tasks", { directory })).result;
        if (tasks.every((task) => !task.running)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal((await call("host.shutdownIdle")).error, undefined);
      while (existsSync(join(root, "local-daemon-v1/endpoint.json")) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(existsSync(join(root, "local-daemon-v1/endpoint.json")), false);
    }
  }
});
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

async function holdWriter(t, root) {
  const target = resolve(process.env.CARGO_TARGET_DIR ?? "crates/uterm-core/target");
  const child = spawn(
    join(target, "debug", `uterm-core-contract${process.platform === "win32" ? ".exe" : ""}`),
    ["--hold-store-lock", root],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = new Promise((resolve) => child.once("close", resolve));
  t.after(() => child.kill());
  assert.equal((await lines.next()).value, "locked");
  return async () => {
    child.stdin.end("release\n");
    assert.equal(await exited, 0);
  };
}

test("draft reads retry a busy Rust store but writes require explicit recovery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "uterm-real-writer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const call = await client(t, root),
    raw = draftCall(call);
  await raw("editor_drafts_import", { legacy: null });
  const releaseRead = await holdWriter(t, root);
  assert.equal((await call("editor.drafts.list")).error.code, "WRITER_BUSY");
  let reads = 0,
    writes = 0;
  const queue = new EditorDraftQueue(async (method, params) => {
    if (method === "editor_drafts_put") writes++;
    try {
      return await raw(method, params);
    } catch (reason) {
      if (method === "editor_drafts_list" && reason.code === "WRITER_BUSY" && ++reads === 2)
        await releaseRead();
      throw reason;
    }
  });
  t.after(() => queue.close());
  await queue.initialize();
  assert.equal(reads, 2);
  const value = queueDraft("busy.txt", "retain exact 中文 e\u0301\r\n");
  const releaseWrite = await holdWriter(t, root);
  await assert.rejects(queue.put(value), { code: "WRITER_BUSY" });
  await assert.rejects(queue.flush(), { code: "WRITER_BUSY" });
  assert.equal(writes, 1, "A write cannot retry automatically after an uncertain reply");
  await releaseWrite();
  assert.equal(
    (await call("editor.drafts.document", { directory: value.directory, path: value.path })).result,
    null,
  );
  await queue.retry();
  assert.equal(writes, 2);
  assert.deepEqual((await queue.load(value.directory, value.path)).draft, value);
  t.diagnostic(
    `actual WRITER_BUSY reads=${reads}, write attempts=${writes}, explicit retry retained exact draft bytes`,
  );
});

test("closing a draft queue cancels busy-read backoff before any import or delayed delivery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "uterm-real-writer-close-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const call = await client(t, root),
    raw = draftCall(call);
  const release = await holdWriter(t, root);
  const entered = signal();
  let reads = 0;
  const queue = new EditorDraftQueue(async (method, params) => {
    assert.equal(method, "editor_drafts_list");
    reads++;
    try {
      return await raw(method, params);
    } catch (reason) {
      assert.equal(reason.code, "WRITER_BUSY");
      entered.resolve();
      throw reason;
    }
  });
  const pending = assert.rejects(queue.initialize(null), { code: "CLOSED" });
  await entered.promise;
  await Promise.resolve();
  queue.close();
  await pending;
  await release();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(reads, 1);
});

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
  await b.discard("/qa/editor", "a.txt");
  await b.flush();
  const current = (
    await callA("editor.drafts.document", { directory: "/qa/editor", path: "a.txt" })
  ).result;
  assert.equal(current.draft.text, "A new");
  await b.remove("/qa/editor", "b.txt");
  assert.equal((await callA("editor.drafts.list")).result.drafts.length, 1);
  await a.discard("/qa/editor", "a.txt");
  assert.equal((await callA("editor.drafts.list")).result.drafts.length, 0);
});

test("explicit draft discard waits for dispatched commits and rejects a racing external replacement", async (t) => {
  const call = await client(t),
    invoke = draftCall(call),
    started = signal(),
    release = signal();
  let hold = true,
    replace = false;
  const queue = new EditorDraftQueue(async (method, params) => {
    if (hold && method === "editor_drafts_put") {
      started.resolve();
      await release.promise;
    }
    if (replace && method === "editor_drafts_remove") {
      replace = false;
      assert.ok(
        (
          await call("editor.drafts.putDocument", {
            expectedDraftRevision: params.expectedDraftRevision,
            draft: queueDraft("racing.txt", "external replacement"),
          })
        ).result,
      );
    }
    return invoke(method, params);
  });
  t.after(() => queue.close());
  await queue.initialize(null);
  const write = queue.put(queueDraft("pending.txt", "dispatched before discard"));
  await started.promise;
  const discarded = queue.discard("/qa/editor", "pending.txt");
  await assert.rejects(queue.put(queueDraft("pending.txt", "blocked while discarding")), {
    code: "DRAFT_BUSY",
  });
  release.resolve();
  await write;
  await discarded;
  assert.equal(
    (await call("editor.drafts.document", { directory: "/qa/editor", path: "pending.txt" })).result,
    null,
  );
  hold = false;
  await queue.put(queueDraft("racing.txt", "my original"));
  replace = true;
  await assert.rejects(queue.discard("/qa/editor", "racing.txt"), { code: "CONFLICT" });
  await queue.discard("/qa/editor", "racing.txt");
  assert.equal(
    (await call("editor.drafts.document", { directory: "/qa/editor", path: "racing.txt" })).result
      .draft.text,
    "external replacement",
  );
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
  const second = new EditorDraftQueue(invoke);
  t.after(() => second.close());
  const repeated = new EditorDraftQueue(invoke);
  t.after(() => repeated.close());
  assert.equal((await repeated.initialize(raw)).drafts[0].draft.text, "newer text");
  const changedSource = JSON.stringify(queueDraft("legacy.txt", "newer legacy source"));
  await assert.rejects(second.initialize(changedSource), { code: "MIGRATION_CONFLICT" });
  await assert.rejects(second.flush(), { code: "MIGRATION_CONFLICT" });
  await assert.rejects(second.retry(), { code: "MIGRATION_CONFLICT" });
  assert.equal((await call("editor.drafts.read")).result.document.drafts[0].text, "newer text");
  const sources = (await call("editor.drafts.recovery.list")).result.sources;
  assert.equal(sources.length, 2);
  assert.ok(
    sources.some(
      (digest) =>
        readFileSync(join(root, `editor-draft-source-${digest}.original`), "utf8") ===
        changedSource,
    ),
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

test("draft recovery previews never reset a missing store and absent restore requires an explicit acknowledgement", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "uterm-missing-drafts-")),
    call = await client(t, root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const raw = JSON.stringify(queueDraft("recover.txt", "original bytes 中文 é\r\n"));
  const first = (await call("editor.drafts.import", { legacy: raw })).result;
  assert.ok(
    (
      await call("editor.drafts.put", {
        expectedRevision: first.revision,
        draft: queueDraft("recover.txt", "newer data"),
      })
    ).result,
  );
  const file = join(root, "editor-drafts-v1.json");
  rmSync(file);
  assert.equal((await call("editor.drafts.read")).error.code, "MISSING_DRAFTS");
  assert.equal((await call("editor.drafts.import", { legacy: null })).error.code, "MISSING_DRAFTS");
  assert.deepEqual(
    (await call("editor.drafts.recovery.preview", { revision: first.revision })).result,
    first,
  );
  for (const acknowledgement of [{}, { expectedMissing: false }, { expectedMissing: null }])
    assert.equal(
      (
        await call("editor.drafts.recovery.restoreMissing", {
          ...acknowledgement,
          revision: first.revision,
        })
      ).error.code,
      "INVALID_ARGUMENT",
    );
  assert.equal(
    (await call("editor.drafts.recovery.preview", { revision: "../snapshot-v1.json" })).error.code,
    "INVALID_ARGUMENT",
  );
  assert.equal(
    (
      await call("editor.drafts.recovery.restore", {
        expectedRevision: null,
        revision: first.revision,
      })
    ).error.code,
    "INVALID_ARGUMENT",
  );
  assert.deepEqual(
    (
      await call("editor.drafts.recovery.restoreMissing", {
        expectedMissing: true,
        revision: first.revision,
      })
    ).result,
    first,
  );
  const before = readFileSync(file);
  assert.equal(
    (
      await call("editor.drafts.recovery.restoreMissing", {
        expectedMissing: true,
        revision: first.revision,
      })
    ).error.code,
    "CONFLICT",
  );
  assert.deepEqual(readFileSync(file), before);
  assert.equal(
    readFileSync(join(root, `editor-draft-source-${first.document.sourceDigest}.original`), "utf8"),
    raw,
  );
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

test("session discovery reconciles the latest queued Core state without deleting a newly created session", async (t) => {
  const call = await client(t);
  const workspace = {
    ...emptyWorkspace(),
    projects: [
      {
        id: "p",
        name: "Fixture",
        directory: "/temporary/project",
        workspaceId: "local",
        sessions: [{ id: "retired", name: "Old", shell: "default" }],
      },
    ],
    selectedProject: "p",
    selectedSession: "retired",
  };
  assert.equal(
    (await call("migration.import", { workspace, settings: defaults, legacy: {} })).error,
    undefined,
  );
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
  const started = Promise.withResolvers(),
    gate = Promise.withResolvers();
  let writes = 0;
  mockIPC(async (command, args) => {
    assert.equal(command, "shared_core_request");
    const request = JSON.parse(args.request);
    if (request.method === "snapshot.replace" && ++writes === 1) {
      started.resolve();
      await gate.promise;
    }
    return JSON.stringify(await call(request.method, request.params, request.id));
  });
  const state = await server.ssrLoadModule("/src/lib/shared-state.ts");
  const { syncDiscoveredSessions } = await server.ssrLoadModule("/src/lib/workspace.ts");
  await state.initializeSharedState();
  const observed = state.sharedWorkspace();
  const creation = state.persistWorkspace((latest) => ({
    ...latest,
    selectedSession: "created-during-poll",
    projects: latest.projects.map((project) => ({
      ...project,
      sessions: [...project.sessions, { id: "created-during-poll", name: "New", shell: "default" }],
    })),
  }));
  await started.promise;
  const local = { closed: ["retired"], sessions: [] },
    ssh = { closed: [], sessions: [] };
  const discovery = syncDiscoveredSessions(observed, local, ssh, state.persistWorkspace);
  gate.resolve();
  await Promise.all([creation, discovery]);
  const actual = (await call("snapshot.read")).result.document.workspace;
  assert.deepEqual(
    actual.projects[0].sessions.map((session) => session.id),
    ["created-during-poll"],
  );
  assert.equal(actual.selectedSession, "created-during-poll");
  const written = writes;
  await syncDiscoveredSessions(state.sharedWorkspace(), local, ssh, state.persistWorkspace);
  assert.equal(writes, written, "Unchanged discovery must not write a snapshot");
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

test("rollback archives retain latest multi-document drafts without populating an ambiguous old-client slot", async (t) => {
  const call = await client(t);
  const original = JSON.stringify(queueDraft("a.txt", "original"));
  const snapshot = (
    await call("migration.import", {
      workspace: emptyWorkspace(),
      settings: defaults,
      legacy: { [draftKey]: original },
    })
  ).result;
  const first = (await call("editor.drafts.import", {})).result;
  const latest = (
    await call("editor.drafts.put", {
      expectedRevision: first.revision,
      draft: queueDraft("a.txt", "latest 中文 é\r\n"),
    })
  ).result;
  let archive = (
    await call("rollback.export", {
      expectedRevision: snapshot.revision,
      expectedDraftRevision: latest.revision,
    })
  ).result;
  assert.equal(readDraft(archive.legacyValues[draftKey]).text, "latest 中文 é\r\n");
  assert.deepEqual(
    readWorkspace(archive.legacyValues["uterm.desktop.workspace.v1"]),
    readWorkspace(JSON.stringify(snapshot.document.workspace)),
  );
  assert.deepEqual(
    readSettings(archive.legacyValues["uterm.desktop.settings.v1"]),
    snapshot.document.settings,
  );
  assert.equal(archive.snapshot.document.legacy[draftKey], original);
  const multiple = (
    await call("editor.drafts.put", {
      expectedRevision: latest.revision,
      draft: queueDraft("b.txt", "second 🧪\r\n"),
    })
  ).result;
  archive = (
    await call("rollback.export", {
      expectedRevision: snapshot.revision,
      expectedDraftRevision: multiple.revision,
    })
  ).result;
  assert.equal(archive.legacyRequiresDraftChoice, true);
  assert.equal(archive.automaticRestoreAllowed, false);
  assert.equal(archive.legacyValues[draftKey], undefined);
  assert.deepEqual(
    archive.legacyDraftCandidates.map((value) => readDraft(value.value).text),
    ["latest 中文 é\r\n", "second 🧪\r\n"],
  );
  assert.equal((await call("legacy.export")).result.values[draftKey], original);
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

test("WebKit editor quit waits for a real Rust file save and refuses external conflicts", async (t) => {
  const call = await client(t),
    directory = mkdtempSync(join(tmpdir(), "uterm-quit-file-")),
    path = "quit.txt";
  writeFileSync(join(directory, path), "\ufefforiginal 中文\r\n");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
  });
  const React = await import("react"),
    { createRoot } = await import("react-dom/client"),
    { useFileDocument } = await server.ssrLoadModule("/src/lib/useFileDocument.ts");
  const root = createRoot(document.getElementById("root"));
  let editor, heldWrite, writeStarted, replied;
  const replies = [];
  window.utermContentDocument = "real-file-quit";
  window.webkit = {
    messageHandlers: {
      utermContent: {
        async postMessage(request) {
          if (request.kind === "cancel") return {};
          let result = null,
            error;
          if (request.method === "editor_prepare_result") {
            replies.push(request.params);
            replied?.resolve();
          } else if (request.method !== "editor_guard") {
            assert.ok(["file_read", "file_save"].includes(request.method), request.method);
            if (request.method === "file_save" && heldWrite) {
              writeStarted.resolve();
              await heldWrite.promise;
            }
            const reply = await call(
              request.method === "file_read" ? "files.read" : "files.save",
              request.params,
            );
            result = reply.result;
            if (reply.error)
              error = {
                code: reply.error.code,
                message: `${reply.error.code}: ${reply.error.message}`,
              };
          }
          return { version: 1, id: request.id, document: request.document, result, error };
        },
      },
    },
  };
  function Harness() {
    editor = useFileDocument();
    return null;
  }
  function event(kind, payload) {
    window.dispatchEvent(
      new dom.window.CustomEvent("uterm-content-event", {
        detail: { version: 1, document: window.utermContentDocument, kind, payload },
      }),
    );
  }
  t.after(async () => {
    heldWrite?.resolve();
    await React.act(async () => root.unmount());
    await server.close();
    dom.window.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => editor.open(directory, path));
  await React.act(async () => editor.change("saved during quit 中文\r\n"));
  heldWrite = signal();
  writeStarted = signal();
  replied = signal();
  await React.act(async () => {
    event("editor-prepare-quit", "prepare-one");
    await writeStarted.promise;
  });
  assert.equal(editor.transitioning, true);
  await React.act(async () => editor.change("must not replace the frozen snapshot"));
  assert.equal(editor.document.text, "saved during quit 中文\r\n");
  assert.equal(replies.length, 0);
  await React.act(async () => {
    heldWrite.resolve();
    await replied.promise;
  });
  assert.deepEqual(replies, [{ token: "prepare-one", ready: true }]);
  assert.equal(readFileSync(join(directory, path), "utf8"), "\ufeffsaved during quit 中文\r\n");
  assert.equal(editor.transitioning, true);
  await React.act(async () => event("editor-resume", "old-token"));
  assert.equal(editor.transitioning, true);
  await React.act(async () => event("editor-resume", "prepare-one"));
  assert.equal(editor.transitioning, false);
  await React.act(async () => editor.change("retain my unsaved text"));
  writeFileSync(join(directory, path), "external writer");
  heldWrite = null;
  replied = signal();
  await React.act(async () => {
    event("editor-prepare-quit", "conflict-two");
    await replied.promise;
  });
  assert.deepEqual(replies.at(-1), { token: "conflict-two", ready: false });
  assert.equal(editor.conflict, true);
  assert.ok(editor.error);
  assert.equal(editor.transitioning, false);
  assert.equal(editor.document.text, "retain my unsaved text");
  assert.equal(readFileSync(join(directory, path), "utf8"), "external writer");
});

test("shared editor recovery restores durable text after unload and retains file conflict guards", async (t) => {
  const call = await client(t),
    directory = mkdtempSync(join(tmpdir(), "uterm-editor-reopen-")),
    path = "reopen.txt";
  writeFileSync(join(directory, path), "\ufeffdisk 中文\r\n");
  const file = (await call("files.read", { directory, path })).result;
  const legacy = JSON.stringify({
    ...queueDraft(path, "recovered 中文\r\n"),
    directory,
    saved: file.text,
    version: file.version,
    bom: file.bom,
    line_ending: file.line_ending,
  });
  assert.ok((await call("editor.drafts.import", { legacy })).result);
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem(draftKey, "old WebView bytes must stay unchanged");
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
  });
  const React = await import("react"),
    { createRoot } = await import("react-dom/client"),
    { useFileDocument } = await server.ssrLoadModule("/src/lib/useFileDocument.ts");
  let root = createRoot(document.getElementById("root")),
    editor,
    busyReads = true,
    rejectedReads = 0;
  window.utermContentDocument = "shared-editor-recovery";
  window.webkit = {
    messageHandlers: {
      utermContent: {
        async postMessage(request) {
          if (request.kind === "cancel") return {};
          let result = null,
            error;
          if (request.method !== "editor_guard") {
            const method =
              editorDraftMethods[request.method] ??
              { file_read: "files.read", file_save: "files.save" }[request.method];
            assert.ok(method, request.method);
            const reply =
              busyReads && ["editor.drafts.list", "editor.drafts.document"].includes(method)
                ? (rejectedReads++,
                  {
                    error: {
                      code: "WRITER_BUSY",
                      message: "Another writer owns the canonical store",
                    },
                  })
                : await call(method, request.params);
            result = reply.result;
            if (reply.error)
              error = {
                code: reply.error.code,
                message: `${reply.error.code}: ${reply.error.message}`,
              };
          }
          return { version: 1, id: request.id, document: request.document, result, error };
        },
      },
    },
  };
  function Harness() {
    editor = useFileDocument(10, false, directory);
    return null;
  }
  t.after(async () => {
    await React.act(async () => root.unmount());
    await server.close();
    dom.window.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => editor.open(directory, path));
  assert.equal(editor.document, null);
  assert.equal(
    editor.pending,
    false,
    "A failed initial open cannot strand an invisible discard dialog",
  );
  assert.match(editor.error, /Another writer owns/);
  assert.ok(rejectedReads >= 7);
  busyReads = false;
  await React.act(async () => editor.open(directory, path));
  assert.equal(editor.document.text, "recovered 中文\r\n");
  assert.ok(editor.document.notice);
  assert.equal(readFileSync(join(directory, path), "utf8"), "\ufeffdisk 中文\r\n");
  await React.act(async () => editor.change("durable before unload 中文\r\n"));
  await React.act(async () => assert.rejects(editor.prepareUpdate()));
  assert.equal(
    (await call("editor.drafts.document", { directory, path })).result.draft.text,
    "durable before unload 中文\r\n",
  );
  await React.act(async () => root.unmount());
  root = createRoot(document.getElementById("root"));
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => editor.open(directory, path));
  assert.equal(editor.document.text, "durable before unload 中文\r\n");
  assert.equal(localStorage.getItem(draftKey), "old WebView bytes must stay unchanged");
  writeFileSync(join(directory, path), "external change");
  await React.act(async () =>
    window.dispatchEvent(
      new dom.window.CustomEvent("uterm-content-event", {
        detail: {
          version: 1,
          document: window.utermContentDocument,
          kind: "editor-repository-refresh",
          payload: "git-refresh",
        },
      }),
    ),
  );
  assert.equal(editor.document.text, "durable before unload 中文\r\n");
  assert.equal(editor.pending, false);
  await React.act(async () => assert.equal(await editor.save(), false));
  assert.equal(editor.conflict, true);
  assert.equal(editor.document.text, "durable before unload 中文\r\n");
  assert.equal(readFileSync(join(directory, path), "utf8"), "external change");
  await React.act(async () => editor.reload());
  assert.equal(editor.pending, true);
  await React.act(async () => editor.discard());
  assert.equal(editor.document.text, "external change");
  assert.equal((await call("editor.drafts.document", { directory, path })).result, null);
  await React.act(async () => editor.change("explicitly saved"));
  await React.act(async () => assert.equal(await editor.save(), true));
  assert.equal(readFileSync(join(directory, path), "utf8"), "explicitly saved");
  assert.equal((await call("editor.drafts.document", { directory, path })).result, null);
  writeFileSync(join(directory, path), "clean file changed by Git 中文\r\n");
  await React.act(async () =>
    window.dispatchEvent(
      new dom.window.CustomEvent("uterm-content-event", {
        detail: {
          version: 1,
          document: window.utermContentDocument,
          kind: "editor-repository-refresh",
          payload: "git-refresh-clean",
        },
      }),
    ),
  );
  const refreshed = Date.now() + 5000;
  while (editor.document.text !== "clean file changed by Git 中文\r\n") {
    assert.ok(Date.now() < refreshed, "Clean editor did not reload repository changes");
    await React.act(async () => new Promise((done) => setTimeout(done, 25)));
  }
  await React.act(async () => editor.change("retain text when the disk file disappears 中文"));
  await React.act(async () => assert.rejects(editor.prepareUpdate()));
  rmSync(join(directory, path));
  await React.act(async () => root.unmount());
  root = createRoot(document.getElementById("root"));
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => editor.open(directory, path));
  assert.equal(editor.document?.text, "retain text when the disk file disappears 中文");
  assert.equal(editor.document.readonly, true);
  assert.ok(editor.document.notice);
  await React.act(async () => editor.close());
  assert.equal(
    (await call("editor.drafts.document", { directory, path })).result.draft.text,
    "retain text when the disk file disappears 中文",
  );
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

test("old editor draft handoff freezes old keys and keeps newer shared data across restarts and explicit source conflicts", async (t) => {
  const storeRoot = mkdtempSync(join(tmpdir(), "uterm-draft-handoff-")),
    call = await client(t, storeRoot),
    values = new Map();
  t.after(() => rmSync(storeRoot, { recursive: true, force: true }));
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const request = async (method, params) => {
    const reply = await call(method, params);
    if (reply.error) throw Object.assign(Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  };
  const raw = " \n" + JSON.stringify(queueDraft("handoff.txt", "source A 中文 é\r\n")) + "\n";
  storage.setItem(draftKey, raw);
  const first = await new EditorDraftHandoff(request, storage).initialize();
  assert.equal(storage.getItem(draftKey), raw);
  assert.equal(storage.getItem(`${draftKey}.shared-v1-backup.${first.document.sourceDigest}`), raw);
  await request("editor.drafts.put", {
    expectedRevision: first.revision,
    draft: queueDraft("handoff.txt", "new native text"),
  });
  const newer = await new EditorDraftHandoff(request, storage).initialize();
  assert.equal(newer.document.drafts[0].text, "new native text");
  const other = JSON.stringify(queueDraft("different.txt", "source B must stay recoverable"));
  storage.setItem(draftKey, other);
  const conflict = new EditorDraftHandoff(request, storage);
  await assert.rejects(conflict.acceptShared(), { code: "MIGRATION_CHOICE" });
  await assert.rejects(conflict.initialize(), { code: "MIGRATION_CONFLICT" });
  const sources = await request("editor.drafts.recovery.list");
  assert.equal(sources.sources.length, 2);
  const accepted = await conflict.acceptShared();
  assert.deepEqual(accepted, newer);
  assert.equal(storage.getItem(draftKey), other);
  assert.deepEqual(await new EditorDraftHandoff(request, storage).initialize(), newer);
  assert.equal(
    JSON.parse(storage.getItem(editorDraftReceiptKey)).sharedSourceDigest,
    first.document.sourceDigest,
  );
  const archivedSource = join(
    storeRoot,
    `editor-draft-source-${JSON.parse(storage.getItem(editorDraftReceiptKey)).legacyDigest}.original`,
  );
  rmSync(archivedSource);
  const missingSource = new EditorDraftHandoff(request, storage);
  await assert.rejects(missingSource.initialize(), { code: "MIGRATION_CONFLICT" });
  assert.equal(readFileSync(archivedSource, "utf8"), other);
  assert.deepEqual(await missingSource.acceptShared(), newer);
  const changed = new EditorDraftHandoff(request, storage);
  storage.setItem(draftKey, "changed while recovery is open");
  await assert.rejects(changed.initialize(), { code: "MIGRATION_CHANGED" });
  assert.deepEqual(await request("editor.drafts.read"), newer);
});

test("old draft backup and receipt failures retain source bytes and never reset shared drafts", async (t) => {
  const call = await client(t),
    values = new Map([[draftKey, JSON.stringify(queueDraft("quota.txt", "unsaved exact text"))]]);
  let fail = true;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (fail) throw Error("simulated WebView quota");
      values.set(key, value);
    },
  };
  const request = async (method, params) => {
    const reply = await call(method, params);
    if (reply.error) throw Object.assign(Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  };
  const source = storage.getItem(draftKey);
  await assert.rejects(new EditorDraftHandoff(request, storage).initialize(), /WebView quota/);
  assert.equal((await call("editor.drafts.read")).error.code, "DRAFTS_NOT_IMPORTED");
  assert.equal(storage.getItem(draftKey), source);
  fail = false;
  const original = await new EditorDraftHandoff(request, storage).initialize();
  values.delete(editorDraftReceiptKey);
  fail = true;
  await assert.rejects(new EditorDraftHandoff(request, storage).initialize(), /WebView quota/);
  assert.deepEqual(await request("editor.drafts.read"), original);
  assert.equal(storage.getItem(draftKey), source);
  fail = false;
  const backup = [...values.keys()].find((key) => key.includes(".shared-v1-backup."));
  values.set(backup, "occupied backup with unrelated bytes");
  await assert.rejects(new EditorDraftHandoff(request, storage).initialize(), {
    code: "DRAFT_BACKUP_CONFLICT",
  });
  assert.equal(storage.getItem(backup), "occupied backup with unrelated bytes");
  assert.deepEqual(await request("editor.drafts.read"), original);
});

test("editor boot recovery previews real backups and rejects a selection after external bytes change", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "uterm-editor-boot-")),
    call = await client(t, directory);
  const raw = JSON.stringify(queueDraft("recover.txt", "retained backup 中文 é\r\n"));
  const first = (await call("editor.drafts.import", { legacy: raw })).result;
  await call("editor.drafts.put", {
    expectedRevision: first.revision,
    draft: queueDraft("recover.txt", "newer draft"),
  });
  const store = join(directory, "editor-drafts-v1.json");
  writeFileSync(store, "{damaged first bytes");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem(draftKey, raw);
  const request = async (method, params) => {
    const reply = await call(method, params);
    if (reply.error) throw Object.assign(Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  };
  const handoff = new EditorDraftHandoff(request, localStorage);
  await assert.rejects(handoff.initialize(), { code: "CORRUPT_DRAFTS" });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
  });
  const React = await import("react"),
    { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await React.act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    rmSync(directory, { recursive: true, force: true });
  });
  mockIPC(async (command, args) => {
    assert.equal(command, "shared_core_request");
    const value = JSON.parse(args.request);
    return JSON.stringify(await call(value.method, value.params, value.id));
  });
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const { EditorDraftRecovery } = await server.ssrLoadModule(
    "/src/components/EditorDraftRecovery.tsx",
  );
  let activated = false;
  await React.act(async () =>
    root.render(
      React.createElement(EditorDraftRecovery, {
        reason: Error("corrupt drafts"),
        handoff,
        ready: () => {
          activated = true;
        },
      }),
    ),
  );
  const button = (label) =>
    [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === label);
  async function waitFor(read) {
    const deadline = Date.now() + 5000;
    while (!read()) {
      assert.ok(Date.now() < deadline, "Boot recovery UI did not settle");
      await React.act(async () => new Promise((done) => setTimeout(done, 25)));
    }
  }
  assert.equal(button("Continue with shared drafts"), undefined);
  await React.act(async () => button("View recovery copies").click());
  await waitFor(() => button(`Preview copy ${first.revision.slice(0, 12)}`));
  await React.act(async () => button(`Preview copy ${first.revision.slice(0, 12)}`).click());
  await waitFor(
    () => document.querySelector("article pre")?.textContent === "retained backup 中文 é\r\n",
  );
  const external = "{newer external data must survive stale recovery";
  writeFileSync(store, external);
  await React.act(async () => button("Restore selected draft copy").click());
  await waitFor(() =>
    document.querySelector('[role="alert"]').textContent.includes("changed during recovery"),
  );
  assert.equal(readFileSync(store, "utf8"), external);
  assert.equal(localStorage.getItem(draftKey), raw);
  assert.equal(activated, false);
});

function gitFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "uterm-shared-git-")),
    directory = join(root, "repository");
  mkdirSync(directory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=" + join(root, "no-hooks"), "-C", directory, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  git("init", "--initial-branch=main");
  mkdirSync(join(directory, "src"));
  writeFileSync(join(directory, "src", "中文 [literal].txt"), "before 中文\n");
  writeFileSync(join(directory, "outside.txt"), "outside\n");
  git("add", "--all");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    "isolated shared Git fixture",
  );
  return { root, directory, git, head: git("rev-parse", "HEAD").trim() };
}

test("content transports keep cancelled Git callers protected until the actual checkout finishes", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(global, "window");
  Object.defineProperty(global, "window", { configurable: true, writable: true, value: {} });
  t.after(() => {
    clearMocks();
    if (previous === undefined) delete global.window;
    else Object.defineProperty(global, "window", previous);
  });
  for (const transport of ["Tauri", "WebKit"])
    for (const kind of ["abort", "timeout", "close"]) {
      await t.test(`${transport} ${kind}`, async (t) => {
        const call = await client(t),
          { directory, git } = gitFixture(t),
          hooks = join(directory, ".git", "qa-hooks"),
          entered = join(directory, ".git", "qa-git-entered"),
          release = join(directory, ".git", "qa-git-release"),
          completed = signal();
        git("branch", "topic");
        mkdirSync(hooks);
        const hook = join(hooks, "post-checkout");
        writeFileSync(
          hook,
          "#!/bin/sh\n: > .git/qa-git-entered\ni=0\n" +
            'while [ ! -e .git/qa-git-release ] && [ "$i" -lt 400 ]; do\n' +
            "i=$((i+1))\nsleep 0.05\ndone\n" +
            "test -e .git/qa-git-release || exit 1\n" +
            "printf 'GIT_WRITE_FINISHED\\n' > outside.txt\n",
        );
        chmodSync(hook, 0o755);
        git("config", "core.hooksPath", hooks.replaceAll("\\", "/"));
        let backendFinished = false,
          protectedByCaller = true;
        const checkout = async (command, args) => {
          assert.equal(command, "git_switch_branch");
          try {
            const reply = await call("git.switchBranch", args);
            assert.equal(reply.error, undefined);
            return reply.result;
          } finally {
            backendFinished = true;
            completed.resolve();
          }
        };
        mockIPC(checkout);
        const port =
          transport === "Tauri"
            ? tauriContentPort
            : webKitContentPort(
                {
                  async postMessage(request) {
                    const result =
                      request.kind === "cancel"
                        ? null
                        : await checkout(request.method, request.params);
                    return { version: 1, id: request.id, document: request.document, result };
                  },
                },
                new EventTarget(),
              );
        const scope = new ContentScope(
            port,
            `actual-git-${transport}-${kind}`,
            kind === "timeout" ? 50 : 10000,
          ),
          controller = new AbortController(),
          pending = scope
            .call(
              "git_switch_branch",
              { directory, branch: "topic", expected: "main" },
              controller.signal,
            )
            .finally(() => {
              protectedByCaller = false;
            });
        const rejected = assert.rejects(pending, {
          code: { abort: "CANCELLED", timeout: "TIMEOUT", close: "CLOSED" }[kind],
        });
        try {
          const deadline = Date.now() + 10000;
          while (!existsSync(entered) && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
          assert.ok(existsSync(entered), "actual Git post-checkout hook must be running");
          if (kind === "abort") controller.abort();
          if (kind === "close") scope.close();
          await new Promise((resolve) => setTimeout(resolve, 90));
          assert.equal(backendFinished, false);
          assert.equal(readFileSync(join(directory, "outside.txt"), "utf8"), "outside\n");
          assert.equal(
            protectedByCaller,
            true,
            "cancellation must not release the editor/quit caller while Git can still write",
          );
        } finally {
          writeFileSync(release, "release\n");
          await completed.promise;
          await rejected;
          scope.close();
        }
        assert.equal(protectedByCaller, false);
        assert.equal(git("branch", "--show-current").trim(), "topic");
        assert.equal(readFileSync(join(directory, "outside.txt"), "utf8"), "GIT_WRITE_FINISHED\n");
        t.diagnostic(
          `actual Git hook: ${kind} suppressed success and retained the caller until completion`,
        );
      });
    }
});

test("shared Git contracts preserve selected-directory status, literal paths, history and stale branch protection", async (t) => {
  const call = await client(t),
    fixture = gitFixture(t),
    { directory, head, git } = fixture;
  const relative = "src/中文 [literal].txt";
  writeFileSync(join(directory, relative), "modified 中文 é\n");
  writeFileSync(join(directory, "outside.txt"), "unrelated change retained\n");
  const index = readFileSync(join(directory, ".git", "index"));
  const selected = await call("git.fileStatus", { directory: join(directory, "src") });
  assert.equal(selected.error, undefined);
  assert.equal(selected.result.changes.length, 1);
  assert.equal(selected.result.changes[0].path, relative);
  assert.deepEqual(readFileSync(join(directory, ".git", "index")), index);
  const snapshot = (await call("git.snapshot", { directory })).result;
  assert.equal(snapshot.head, head);
  assert.equal(snapshot.branch, "main");
  const diff = await call("git.diff", {
    directory,
    path: relative,
    mode: "working",
    reference: null,
  });
  assert.match(diff.result.text, /modified 中文 é/);
  assert.equal(diff.result.truncated, false);
  const history = await call("git.history", { directory, skip: 0, reference: null });
  assert.equal(history.result[0].id, head);
  assert.equal(typeof history.result[0].timestamp, "string");
  const files = await call("git.files", { directory, reference: head, compare: false });
  assert.ok(files.result.some((entry) => entry.path === relative));
  assert.equal(
    (
      await call("git.referenceAction", {
        directory,
        target: { action: "create", reference: "HEAD", oid: head, name: "qa/branch" },
      })
    ).error,
    undefined,
  );
  assert.equal(
    (await call("git.switchBranch", { directory, branch: "qa/branch", expected: "stale" })).error
      .code,
    "GIT_ERROR",
  );
  assert.equal(git("branch", "--show-current").trim(), "main");
  assert.equal(
    (await call("git.switchBranch", { directory, branch: "qa/branch", expected: "main" })).error,
    undefined,
  );
  assert.equal((await call("git.branch", { directory })).result, "qa/branch");
  assert.equal(readFileSync(join(directory, relative), "utf8"), "modified 中文 é\n");
  assert.equal(readFileSync(join(directory, "outside.txt"), "utf8"), "unrelated change retained\n");
});

test("shared Worktree contracts protect dirty work, repository identity, stale bases and occupied branches", async (t) => {
  const call = await client(t),
    fixture = gitFixture(t),
    other = gitFixture(t);
  const { directory, head, git } = fixture,
    path = join(fixture.root, "worktree-中文");
  assert.deepEqual((await call("git.worktrees.list", { directory })).result, []);
  const invalid = await call("git.worktrees.create", {
    directory,
    reference: "HEAD",
    branch: "stale",
    path,
    oid: "stale",
  });
  assert.equal(invalid.error.code, "GIT_ERROR");
  assert.equal((await call("git.worktrees.list", { directory })).result.length, 0);
  const created = await call("git.worktrees.create", {
    directory,
    reference: "HEAD",
    branch: "qa/worktree",
    path,
    oid: head,
  });
  assert.equal(created.error, undefined);
  assert.equal(created.result.length, 1);
  assert.equal(created.result[0].branch, "qa/worktree");
  assert.equal(
    (await call("git.switchBranch", { directory, branch: "qa/worktree", expected: "main" })).error
      .code,
    "GIT_ERROR",
  );
  assert.equal(git("branch", "--show-current").trim(), "main");
  writeFileSync(join(path, "retained.txt"), "unsaved work must survive\n");
  assert.equal((await call("git.worktrees.delete", { directory, path })).error.code, "GIT_ERROR");
  assert.equal(
    (await call("git.worktrees.delete", { directory: other.directory, path })).error.code,
    "GIT_ERROR",
  );
  assert.equal(readFileSync(join(path, "retained.txt"), "utf8"), "unsaved work must survive\n");
  rmSync(join(path, "retained.txt"));
  assert.deepEqual((await call("git.worktrees.delete", { directory, path })).result, []);
  assert.equal(git("branch", "--show-current").trim(), "main");
});

test("shared Worktree refresh retains identities, custom names, missing sessions and selections with real Git and CAS", async (t) => {
  const store = mkdtempSync(join(tmpdir(), "uterm-worktree-state-"));
  t.after(() => rmSync(store, { recursive: true, force: true }));
  const call = await client(t, store),
    fixture = gitFixture(t);
  const create = async (branch, path) => {
    const reply = await call("git.worktrees.create", {
      directory: fixture.directory,
      reference: "HEAD",
      oid: fixture.head,
      branch,
      path,
    });
    assert.equal(reply.error, undefined);
    return reply.result;
  };
  const discovered = await create("qa/tree", join(fixture.root, "tree-中文"));
  const workspace = emptyWorkspace();
  workspace.projects.push({
    id: "shared-tree-project",
    name: "Subdirectory project",
    directory: join(fixture.directory, "src"),
    workspaceId: "local",
    sessions: [
      {
        id: "retained-session",
        name: "Keep my session",
        shell: "default",
        pinned: false,
        worktreeId: "missing-with-session",
      },
    ],
    worktrees: [
      {
        ...discovered[0],
        id: "existing-tree",
        name: "My custom name",
        branch: "old-label",
        missing: true,
      },
      {
        id: "missing-with-session",
        name: "Retain missing",
        branch: "removed",
        path: join(fixture.root, "missing"),
        missing: false,
      },
      {
        id: "unused-missing",
        name: "Unused",
        branch: "unused",
        path: join(fixture.root, "unused"),
        missing: false,
      },
    ],
  });
  workspace.selectedProject = "shared-tree-project";
  workspace.selectedWorktree = "missing-with-session";
  workspace.selectedSession = "retained-session";
  const imported = (await call("migration.import", { workspace, settings: defaults, legacy: {} }))
    .result;
  assert.ok(imported);
  assert.deepEqual(
    (await call("git.worktrees.list", { directory: workspace.projects[0].directory })).result,
    discovered,
    "Subdirectory projects cannot list their own main root as a child Worktree",
  );
  const params = { id: "shared-tree-project", expectedRevision: imported.revision };
  assert.equal(
    (await call("project.worktrees.refresh", { ...params, directory: "/unselected" })).error.code,
    "INVALID_ARGUMENT",
  );
  const first = await call("project.worktrees.refresh", params);
  assert.equal(first.error, undefined);
  let state = first.result;
  assert.deepEqual(
    state.document.workspace,
    reconcileWorktrees(imported.document.workspace, params.id, discovered),
  );
  assert.deepEqual(
    state.document.workspace.projects[0].worktrees.map((tree) => ({
      id: tree.id,
      name: tree.name,
      missing: tree.missing,
      branch: tree.branch,
    })),
    [
      { id: "existing-tree", name: "My custom name", missing: false, branch: "qa/tree" },
      { id: "missing-with-session", name: "Retain missing", missing: true, branch: "removed" },
    ],
  );
  assert.equal(state.document.workspace.selectedSession, "retained-session");
  assert.equal((await call("project.worktrees.refresh", params)).error.code, "CONFLICT");
  assert.deepEqual((await call("snapshot.read")).result, state);
  fixture.git("-C", discovered[0].path, "branch", "-m", "qa/renamed");
  const renamed = await call("project.worktrees.refresh", {
    ...params,
    expectedRevision: state.revision,
  });
  assert.equal(renamed.error, undefined);
  assert.equal(renamed.result.document.workspace.projects[0].worktrees[0].name, "My custom name");
  const autoNamed = structuredClone(renamed.result.document.workspace);
  autoNamed.projects[0].worktrees[0].name = "qa/renamed";
  state = (
    await call("snapshot.replace", {
      expectedRevision: renamed.result.revision,
      workspace: autoNamed,
      settings: defaults,
    })
  ).result;
  fixture.git("-C", discovered[0].path, "branch", "-m", "qa/auto-next");
  const autoRefreshed = await call("project.worktrees.refresh", {
    ...params,
    expectedRevision: state.revision,
  });
  assert.equal(autoRefreshed.error, undefined);
  state = autoRefreshed.result;
  assert.equal(state.document.workspace.projects[0].worktrees[0].name, "qa/auto-next");
  assert.equal(
    (await call("git.worktrees.delete", { directory: fixture.directory, path: discovered[0].path }))
      .error,
    undefined,
  );
  await create("qa/new", join(fixture.root, "new-tree"));
  const refreshed = await call("project.worktrees.refresh", {
    ...params,
    expectedRevision: state.revision,
  });
  assert.equal(refreshed.error, undefined);
  const project = refreshed.result.document.workspace.projects[0];
  assert.deepEqual(
    project.worktrees.map((tree) => tree.branch),
    ["removed", "qa/new"],
  );
  assert.match(project.worktrees[1].id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(project.sessions, state.document.workspace.projects[0].sessions);
  const reopened = await client(t, store);
  assert.deepEqual((await reopened("snapshot.read")).result, refreshed.result);
  const stable = await reopened("project.worktrees.refresh", {
    ...params,
    expectedRevision: refreshed.result.revision,
  });
  assert.equal(stable.error, undefined);
  assert.deepEqual(
    stable.result,
    refreshed.result,
    "A repeat discovery must retain new Worktree identities and revision",
  );
  renameSync(fixture.directory, fixture.directory + "-unavailable");
  assert.equal(
    (
      await call("project.worktrees.refresh", {
        ...params,
        expectedRevision: stable.result.revision,
      })
    ).error.code,
    "GIT_ERROR",
  );
  assert.deepEqual(
    (await call("snapshot.read")).result,
    stable.result,
    "A failed Git discovery cannot replace stored Worktrees",
  );
});

test("Tauri Worktree deletion pins reviewed metadata across queued and external changes and keeps dirty failures retryable", async (t) => {
  const app = mkdtempSync(join(tmpdir(), "uterm-worktree-sdk-"));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  const call = await client(t, join(app, "shared-state-v1")),
    fixture = gitFixture(t);
  const imported = (
    await call("migration.import", { workspace: emptyWorkspace(), settings: defaults, legacy: {} })
  ).result;
  const project = (
    await call("project.open", {
      id: "sdk-project",
      name: "SDK project",
      directory: fixture.directory,
      workspaceId: "local",
      expectedRevision: imported.revision,
    })
  ).result;
  const path = join(fixture.root, "sdk-tree");
  assert.equal(
    (
      await call("git.worktrees.create", {
        directory: fixture.directory,
        reference: "HEAD",
        oid: fixture.head,
        branch: "sdk/tree",
        path,
      })
    ).error,
    undefined,
  );
  const refreshed = (
    await call("project.worktrees.refresh", {
      id: "sdk-project",
      expectedRevision: project.revision,
    })
  ).result;
  const id = refreshed.document.workspace.projects[0].worktrees[0].id;
  const dom = new JSDOM("", { url: "http://localhost/" });
  for (const key of ["window", "document", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
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
  const methods = [];
  const held = signal(),
    release = signal();
  t.after(() => release.resolve());
  let holdSettings = true;
  mockIPC(async (command, args) => {
    assert.equal(command, "shared_core_request");
    const request = JSON.parse(args.request);
    methods.push(request.method);
    const reply = await call(request.method, request.params, request.id);
    if (request.method === "snapshot.replace" && holdSettings) {
      holdSettings = false;
      held.resolve();
      await release.promise;
    }
    return JSON.stringify(reply);
  });
  const state = await server.ssrLoadModule("/src/lib/shared-state.ts");
  await state.initializeSharedState();
  const savedProject = state.sharedWorkspace().projects[0],
    savedTree = savedProject.worktrees[0];
  const writing = state.persistSettings((settings) => ({ ...settings, fontSize: 17 }));
  await held.promise;
  const reviewed = state.worktreeDeletionRevision(savedProject, savedTree);
  const queuedDelete = state.deleteSharedWorktree("sdk-project", id, reviewed);
  release.resolve();
  await writing;
  await assert.rejects(queuedDelete, { code: "CONFLICT" });
  assert.equal(methods.includes("project.worktrees.delete"), false);
  assert(existsSync(path));
  await state.initializeSharedState();
  const currentReview = state.worktreeDeletionRevision(savedProject, savedTree);
  const external = await call("settings.patch", {
    expectedRevision: currentReview,
    patch: { fontSize: 18 },
  });
  assert.equal(external.error, undefined);
  await assert.rejects(state.deleteSharedWorktree("sdk-project", id, currentReview), {
    code: "CONFLICT",
  });
  assert(existsSync(path));
  await state.initializeSharedState();
  assert.throws(
    () => state.worktreeDeletionRevision(savedProject, { ...savedTree, path: path + "/different" }),
    { code: "CONFLICT" },
  );
  assert.throws(
    () => state.worktreeDeletionRevision(savedProject, { ...savedTree, name: "different" }),
    { code: "CONFLICT" },
  );
  const latestReview = state.worktreeDeletionRevision(savedProject, savedTree);
  const dirty = join(path, "retain.txt");
  writeFileSync(dirty, "preserve explicit edits 中文 e\u0301\n");
  await assert.rejects(state.deleteSharedWorktree("sdk-project", id, latestReview), {
    code: "GIT_ERROR",
  });
  assert.deepEqual(state.sharedWorkspace(), refreshed.document.workspace);
  assert.equal(readFileSync(dirty, "utf8"), "preserve explicit edits 中文 e\u0301\n");
  rmSync(dirty);
  const removed = await state.deleteSharedWorktree("sdk-project", id, latestReview);
  assert.equal(removed.projects[0].worktrees.length, 0);
  assert.deepEqual(state.sharedWorkspace(), removed);
  assert.deepEqual((await call("snapshot.read")).result.document.workspace, removed);
  assert.deepEqual(methods, [
    "snapshot.read",
    "snapshot.replace",
    "snapshot.read",
    "project.worktrees.delete",
    "snapshot.read",
    "project.worktrees.delete",
    "project.worktrees.delete",
  ]);
});

test("shared Git requests reject malformed cross-language fields before invoking Git", async (t) => {
  const call = await client(t);
  for (const params of [null, {}, { directory: null }, { directory: "/unused", ignored: true }])
    assert.equal((await call("git.snapshot", params)).error.code, "INVALID_ARGUMENT");
  for (const skip of [-1, 1.5, "0", null, 4294967296])
    assert.equal(
      (await call("git.history", { directory: "/unused", skip })).error.code,
      "INVALID_ARGUMENT",
    );
  assert.equal(
    (await call("git.files", { directory: "/unused", reference: "HEAD", compare: "false" })).error
      .code,
    "INVALID_ARGUMENT",
  );
  assert.equal(
    (
      await call("git.referenceAction", {
        directory: "/unused",
        target: { action: false, reference: "HEAD" },
      })
    ).error.code,
    "INVALID_ARGUMENT",
  );
  assert.equal((await call("git.notPermitted", {})).error.code, "UNKNOWN_METHOD");
});

test("project contexts use the selected Worktree directory and reject stale selection revisions", async (t) => {
  const call = await client(t),
    workspace = emptyWorkspace();
  workspace.projects.push({
    id: "p-context",
    name: "Context",
    directory: "/qa/parent",
    workspaceId: "local",
    sessions: [],
    splitGroups: [],
    worktrees: [
      {
        id: "tree-context",
        name: "Selected tree",
        path: "/qa/worktree ",
        branch: "qa/branch",
        missing: false,
      },
    ],
    pinned: false,
    collapsed: false,
  });
  workspace.selectedProject = "p-context";
  workspace.selectedWorktree = "tree-context";
  const initial = (await call("migration.import", { workspace, settings: defaults, legacy: {} }))
    .result;
  const context = await call("project.context", { expectedRevision: initial.revision });
  assert.equal(context.error, undefined);
  assert.deepEqual(context.result, {
    revision: initial.revision,
    projectId: "p-context",
    worktreeId: "tree-context",
    directory: "/qa/worktree ",
  });
  const selected = (
    await call("project.select", { id: "p-context", expectedRevision: initial.revision })
  ).result;
  assert.equal(
    (await call("project.context", { expectedRevision: initial.revision })).error.code,
    "CONFLICT",
  );
  assert.equal(
    (await call("project.context", { expectedRevision: selected.revision })).result.directory,
    "/qa/parent",
  );
  const empty = await call("project.context", { expectedRevision: 1 });
  assert.equal(empty.error.code, "INVALID_ARGUMENT");
  assert.equal((await call("snapshot.read")).result.revision, selected.revision);
});

test("shared Git favorite handoff retains exact sources, detects stale writes and reopens without replaying old choices", async (t) => {
  const fixture = gitFixture(t),
    call = await client(t);
  const repository = (await call("git.references", { directory: fixture.directory })).result
    .repository;
  const storage = new JSDOM("", { url: "http://localhost" }).window.localStorage;
  const key = `uterm.git.favorites:${repository}`;
  const legacy = '[\r\n  "refs/heads/main"\r\n]';
  storage.setItem(key, legacy);
  const raw = async (method, params) => {
    const reply = await call(gitFavoriteMethods[method], params);
    if (reply.error) throw Object.assign(Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  };
  const first = new SharedGitFavorites(fixture.directory, repository, raw, storage);
  assert.deepEqual((await first.initialize()).references, ["refs/heads/main"]);
  const observer = new SharedGitFavorites(fixture.directory, repository, raw);
  await observer.initialize();
  const updated = await first.write(["refs/heads/中文-e\u0301"]);
  await assert.rejects(observer.write([]), { code: "CONFLICT" });
  assert.deepEqual((await observer.refresh()).references, updated.references);
  first.close();
  const reopened = new SharedGitFavorites(fixture.directory, repository, raw, storage);
  assert.deepEqual((await reopened.initialize()).references, updated.references);
  assert.equal(storage.getItem(key), legacy);
  const backup = Object.keys(storage).find((name) => name.startsWith(`${key}.shared-v1-backup.`));
  assert.equal(storage.getItem(backup), legacy);
  const otherStorage = new JSDOM("", { url: "http://localhost" }).window.localStorage;
  const other = '["refs/heads/other-old-中文"]';
  otherStorage.setItem(key, other);
  const conflict = new SharedGitFavorites(fixture.directory, repository, raw, otherStorage);
  await assert.rejects(conflict.initialize(), { code: "FAVORITES_SOURCE_CONFLICT" });
  assert.equal(conflict.canAcceptShared, true);
  assert.equal(conflict.oldSource, other);
  assert.deepEqual((await conflict.acceptShared()).references, updated.references);
  conflict.close();
  const accepted = new SharedGitFavorites(fixture.directory, repository, raw, otherStorage);
  assert.deepEqual((await accepted.initialize()).references, updated.references);
  otherStorage.setItem(key, '["refs/heads/concurrent-old-writer"]');
  await assert.rejects(accepted.write([]), { code: "MIGRATION_CHANGED" });
  assert.deepEqual((await reopened.refresh()).references, updated.references);
});

test("Git favorite late reads cannot replace acknowledged writes and closing cancels real writer-lock backoff", async (t) => {
  const fixture = gitFixture(t),
    root = mkdtempSync(join(tmpdir(), "uterm-favorites-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const call = await client(t, root),
    raw = async (method, params) => {
      const reply = await call(gitFavoriteMethods[method], params);
      if (reply.error) throw Object.assign(Error(reply.error.message), { code: reply.error.code });
      return reply.result;
    };
  const defaults = (await call("state.defaults")).result;
  assert.equal(
    (
      await call("migration.import", {
        workspace: defaults.workspace,
        settings: defaults.settings,
        legacy: {},
      })
    ).error,
    undefined,
  );
  const pending = signal(),
    release = signal();
  let delayed = false;
  const clientA = new SharedGitFavorites(
    fixture.directory,
    "unused-without-WebView",
    async (method, params) => {
      const result = await raw(method, params);
      if (method === "git_favorites_read" && !delayed) {
        delayed = true;
        pending.resolve();
        await release.promise;
      }
      return result;
    },
  );
  await clientA.initialize();
  const reading = clientA.refresh();
  await pending.promise;
  const saved = await clientA.write(["refs/heads/main"]);
  release.resolve();
  assert.deepEqual(await reading, saved);
  const releaseLock = await holdWriter(t, root);
  let reads = 0;
  const blocked = new SharedGitFavorites(fixture.directory, "unused", async (method, params) => {
    if (method === "git_favorites_read") reads++;
    return raw(method, params);
  });
  await assert.rejects(blocked.initialize(), { code: "WRITER_BUSY" });
  assert.equal(reads, 0);
  await releaseLock();
  await blocked.initialize();
  const unlock = await holdWriter(t, root);
  const retrying = blocked.refresh();
  await new Promise((resolve) => setTimeout(resolve, 5));
  blocked.close();
  await assert.rejects(retrying, { code: "CLOSED" });
  assert.equal(reads, 1);
  await unlock();
});

test("Git favorite backup and receipt failures retain old WebView bytes and durable shared changes", async (t) => {
  const fixture = gitFixture(t),
    call = await client(t),
    repository = (await call("git.references", { directory: fixture.directory })).result.repository;
  const raw = async (method, params) => {
    const reply = await call(gitFavoriteMethods[method], params);
    if (reply.error) throw Object.assign(Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  };
  const key = `uterm.git.favorites:${repository}`,
    legacy = '["refs/heads/main"]',
    map = new Map([[key, legacy]]);
  let writes = 0;
  const denied = {
    getItem: (key) => map.get(key) ?? null,
    setItem: () => {
      writes++;
      throw Error("quota denied");
    },
  };
  await assert.rejects(
    new SharedGitFavorites(fixture.directory, repository, raw, denied).initialize(),
    /quota denied/,
  );
  assert.equal(writes, 1);
  assert.equal(map.get(key), legacy);
  assert.equal((await raw("git_favorites_read", { directory: fixture.directory })).revision, null);
  const receiptDenied = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (name, value) => {
      if (name === `${key}.shared-v1`) throw Error("receipt denied");
      map.set(name, value);
    },
  };
  await assert.rejects(
    new SharedGitFavorites(fixture.directory, repository, raw, receiptDenied).initialize(),
    /receipt denied/,
  );
  assert.deepEqual((await raw("git_favorites_read", { directory: fixture.directory })).references, [
    "refs/heads/main",
  ]);
  assert.equal(map.get(key), legacy);
  const retried = new SharedGitFavorites(fixture.directory, repository, raw, {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
  });
  await retried.initialize();
  await retried.write([]);
  assert.deepEqual(
    (
      await new SharedGitFavorites(fixture.directory, repository, raw, {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => map.set(key, value),
      }).initialize()
    ).references,
    [],
  );
  const invalidFixture = gitFixture(t);
  const invalidRepository = (await call("git.references", { directory: invalidFixture.directory }))
    .result.repository;
  const invalidKey = `uterm.git.favorites:${invalidRepository}`;
  const invalidStorage = new JSDOM("", { url: "http://localhost" }).window.localStorage;
  const invalidRaw = "{INVALID OLD SOURCE 中文\r\n";
  invalidStorage.setItem(invalidKey, invalidRaw);
  const invalidClient = new SharedGitFavorites(
    invalidFixture.directory,
    invalidRepository,
    raw,
    invalidStorage,
  );
  await assert.rejects(invalidClient.initialize(), { code: "INVALID_FAVORITES" });
  assert.equal(invalidClient.canAcceptShared, true);
  assert.equal(invalidClient.hasSharedData, false);
  assert.equal(
    (await raw("git_favorites_read", { directory: invalidFixture.directory })).revision,
    null,
  );
  assert.deepEqual((await invalidClient.acceptShared()).references, []);
  assert.equal(invalidClient.hasSharedData, true);
  await invalidClient.write(["refs/heads/main"]);
  assert.equal(invalidStorage.getItem(invalidKey), invalidRaw);
  const invalidReopened = new SharedGitFavorites(
    invalidFixture.directory,
    invalidRepository,
    raw,
    invalidStorage,
  );
  assert.deepEqual((await invalidReopened.initialize()).references, ["refs/heads/main"]);
});

test("Git favorite recovery RPC preserves exact source bytes, global revisions and explicit absent-store restoration", async (t) => {
  let privilegedCalls = 0;
  const scoped = new ContentScope(
    {
      request: async () => {
        privilegedCalls++;
        throw Error("Unexpected global recovery request");
      },
      cancel() {},
      subscribe() {
        return () => {};
      },
    },
    "favorite-content-document",
  );
  await assert.rejects(scoped.call("git.favorites.recovery.list"), { code: "METHOD_DENIED" });
  await assert.rejects(scoped.call("git_favorites_recovery_list"), { code: "METHOD_DENIED" });
  assert.equal(privilegedCalls, 0);
  scoped.close();
  const fixture = gitFixture(t),
    root = mkdtempSync(join(tmpdir(), "uterm-favorite-recovery-rpc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const call = await client(t, root);
  const legacy = '[\r\n "refs/heads/中文-e\u0301-𝄞"\r\n]';
  const imported = (await call("git.favorites.import", { directory: fixture.directory, legacy }))
    .result;
  assert.ok(imported?.revision);
  const catalog = (await call("git.favorites.recovery.list")).result;
  const revision = catalog.backups[0];
  const preview = (await call("git.favorites.recovery.preview", { revision })).result;
  assert.equal(preview.revision, revision);
  assert.equal(preview.document.schemaVersion, 1);
  assert.deepEqual(
    preview.document.repositories[imported.repository].references,
    JSON.parse(legacy),
  );
  assert.deepEqual(
    Buffer.from(
      (await call("git.favorites.recovery.source", { revision: imported.sourceDigest })).result,
    ),
    Buffer.from(legacy),
  );
  const path = join(root, "git-favorites-v1.json"),
    before = readFileSync(path);
  assert.equal(createHash("sha256").update(before).digest("hex"), revision);
  assert.deepEqual(readFileSync(path), before);
  const updated = await call("git.favorites.write", {
    directory: fixture.directory,
    expectedRevision: imported.revision,
    references: [],
  });
  assert.equal(updated.error, undefined);
  const after = readFileSync(path);
  assert.equal(
    (
      await call("git.favorites.recovery.restore", {
        revision,
        expectedRevision: catalog.currentRevision,
        expectedMissing: false,
      })
    ).error.code,
    "CONFLICT",
  );
  assert.deepEqual(readFileSync(path), after);
  const damaged = Buffer.from("{DAMAGED FAVORITES 中文\r\n");
  writeFileSync(path, damaged);
  const damagedRevision = createHash("sha256").update(damaged).digest("hex");
  assert.equal((await call("git.favorites.recovery.list")).result.currentRevision, damagedRevision);
  const restored = await call("git.favorites.recovery.restore", {
    revision,
    expectedRevision: damagedRevision,
    expectedMissing: false,
  });
  assert.equal(restored.error, undefined);
  assert.deepEqual(restored.result, preview);
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readFileSync(join(root, `git-favorites-${damagedRevision}.damaged`)), damaged);
  rmSync(path);
  assert.equal((await call("git.favorites.recovery.list")).result.currentRevision, null);
  assert.equal(
    (await call("git.favorites.import", { directory: fixture.directory })).error.code,
    "MISSING_FAVORITES",
  );
  const absent = await call("git.favorites.recovery.restore", {
    revision,
    expectedRevision: null,
    expectedMissing: true,
  });
  assert.equal(absent.error, undefined);
  assert.deepEqual(absent.result, preview);
  assert.deepEqual(readFileSync(path), before);
  assert.equal(
    (
      await call("git.favorites.recovery.restore", {
        revision,
        expectedRevision: null,
        expectedMissing: true,
      })
    ).error.code,
    "CONFLICT",
  );
  assert.equal(
    (await call("git.favorites.recovery.preview", { revision, directory: fixture.directory })).error
      .code,
    "INVALID_ARGUMENT",
  );
});
