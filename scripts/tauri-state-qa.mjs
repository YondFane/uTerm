import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  copyFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  chmodSync,
  statSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir, homedir, platform, arch, release, version } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { startResourceSampler } from "./client-resource-sampler.mjs";
import { assertParityOperations, assertParityScenes } from "./ui-parity-scenes.mjs";

const editorFixture = JSON.parse(
  readFileSync(resolve("shared/fixtures/editor-draft-qa.json"), "utf8"),
);
const gitQA = JSON.parse(readFileSync(resolve("shared/fixtures/git-qa.json"), "utf8"));
const previewQA = JSON.parse(
  readFileSync(resolve("shared/fixtures/content-preview-qa.json"), "utf8"),
);
const identifier = "sh.uterm.desktop.qa.sharedstate";
const performanceOnly = process.env.UTERM_QA_PERFORMANCE_ONLY === "1";
const parityOnly = process.env.UTERM_QA_UI_PARITY_ONLY === "1";
const parityFixture = JSON.parse(
  readFileSync(resolve("shared/fixtures/client-ui-parity.json"), "utf8"),
);
const output = resolve(parityOnly ? "ci-evidence/ui-parity-tauri" : "ci-evidence/tauri-state-qa");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "uterm-tauri-qa-"));
if (process.env.UTERM_QA_SSH_FIXTURE) {
  const { alias, remote, port } = JSON.parse(
    readFileSync(process.env.UTERM_QA_SSH_FIXTURE, "utf8"),
  );
  writeFileSync(join(root, "ssh-fixture.json"), JSON.stringify({ alias, remote, port }));
}
if (process.env.UTERM_QA_REDIS_FIXTURE) {
  copyFileSync(process.env.UTERM_QA_REDIS_FIXTURE, join(root, "redis-fixture.json"));
  chmodSync(join(root, "redis-fixture.json"), 0o600);
}
if (process.env.UTERM_QA_DATABASE_FIXTURE) {
  copyFileSync(process.env.UTERM_QA_DATABASE_FIXTURE, join(root, "database-fixture.json"));
  chmodSync(join(root, "database-fixture.json"), 0o600);
}
mkdirSync(join(root, "project"));
writeFileSync(join(root, "project", editorFixture.fileName), "\ufeff" + editorFixture.originalText);
const evidence = join(root, "evidence");
mkdirSync(evidence);
const agentHome = join(root, "agent-home/.claude");
mkdirSync(join(agentHome, "projects/qa"), { recursive: true });
writeFileSync(
  join(agentHome, "settings.json"),
  JSON.stringify({
    keep: "private QA setting",
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool --start" }] }] },
  }),
);
writeFileSync(
  join(agentHome, "projects/qa/usage.jsonl"),
  JSON.stringify({
    timestamp: new Date().toISOString(),
    message: { id: "private-qa-usage", usage: { input_tokens: 17, output_tokens: 8 } },
  }) + "\n",
);
const tested = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const head = process.env.PR_HEAD_SHA || tested;
const sourceTreeDirty = spawnSync("git", ["diff", "--quiet", "HEAD"]).status !== 0;
const env = {
  ...process.env,
  VITE_UTERM_STATE_QA: "1",
  UTERM_QA_HEAD: head,
  UTERM_QA_TESTED: tested,
  UTERM_QA_DIRTY: String(sourceTreeDirty),
};
const metadata = {
  identifier,
  head,
  tested,
  platform: platform(),
  architecture: arch(),
  system: release(),
  version: version(),
  input: "DOM events inside the real isolated Tauri app",
  capture:
    process.platform === "darwin"
      ? "WindowServer screencapture -l"
      : process.platform === "win32"
        ? "owned native HWND PrintWindow, or unobstructed CopyFromScreen; per-image capture metadata"
        : "isolated X11 desktop",
  productionDataAccess: false,
  sourceTreeDirty,
  performanceOnly,
  parityOnly,
  uiParityFixtureSHA256: createHash("sha256")
    .update(readFileSync(resolve("shared/fixtures/client-ui-parity.json")))
    .digest("hex"),
  productVersion:
    process.platform === "darwin"
      ? execute("/usr/bin/sw_vers", ["-productVersion"]).trim()
      : release(),
};
writeFileSync(join(output, "source.json"), JSON.stringify(metadata, null, 2));
function execute(file, args, options = {}) {
  const result = spawnSync(file, args, {
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0)
    throw Error(`${file} failed (${result.status}): ${result.error ?? ""}\n${result.stderr ?? ""}`);
  return result.stdout;
}
function gitFixture(args) {
  return execute("git", [
    "-c",
    `core.hooksPath=${join(root, "no-hooks")}`,
    "-C",
    join(root, "project"),
    ...args,
  ]);
}
function coreFixture(method, params = null) {
  const target = resolve(process.env.CARGO_TARGET_DIR ?? "crates/uterm-core/target");
  const result = JSON.parse(
    execute(
      join(target, "debug", `uterm-core-contract${process.platform === "win32" ? ".exe" : ""}`),
      ["--serve", join(root, "data/shared-state-v1")],
      {
        input: JSON.stringify({ version: 1, id: "qa-external-operation", method, params }) + "\n",
      },
    ),
  );
  assert.equal(result.id, "qa-external-operation");
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  return result.result;
}
gitFixture(["init", "--initial-branch=main"]);
writeFileSync(join(root, "project", gitQA.fileName), gitQA.originalText);
gitFixture(["add", "--all"]);
gitFixture([
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "--no-gpg-sign",
  "-m",
  gitQA.commitSubject,
]);
writeFileSync(join(root, "project", gitQA.fileName), gitQA.changedText);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const scenes = [];
const profileLinks = [];
let child;
const inputControlChildren = [];
const sshApplications = [];
let binary;
let successful = false;
let previewServer;
let previewObserverStarted = false;
const previewRequests = [];
try {
  previewServer = createServer((request, response) => {
    previewRequests.push(request.url);
    response.writeHead(200, { "Content-Type": "text/plain" }).end("forbidden preview fixture");
  });
  await new Promise((done, reject) => {
    previewServer.once("error", reject);
    previewServer.listen(0, "127.0.0.1", done);
  });
  previewObserverStarted = true;
  const previewURL = `http://127.0.0.1:${previewServer.address().port}/forbidden`;
  for (const value of [previewQA.htmlText, previewQA.pdfText, previewQA.escapeMessage])
    assert.match(value, /^[A-Z_]+$/);
  writeFileSync(
    join(root, "project", previewQA.htmlFile),
    `<!doctype html><html><head>
<style>body { background: #eef7ee; color: #172b17; padding: 24px; } .external { background-image: url(${previewURL}); }</style>
<link rel="stylesheet" href="${previewURL}"></head><body><h1>${previewQA.htmlText}</h1>
<p>Static preview in the actual isolated application.</p><div class="external">External resources must stay blocked.</div>
<script>parent.postMessage('${previewQA.escapeMessage}', '*')</script>
<iframe src="${previewURL}"></iframe><img src="${previewURL}" onerror="parent.postMessage('${previewQA.escapeMessage}', '*')">
</body></html>`,
  );
  const stream = `BT /F1 24 Tf 32 140 Td (${previewQA.pdfText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(join(root, "project", previewQA.pdfFile), pdf);
  function isolate(path, target) {
    try {
      lstatSync(path);
      throw Error(`QA refuses to replace an existing profile: ${path}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(target, { recursive: true });
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    profileLinks.push(path);
  }
  if (process.platform === "darwin") {
    for (const area of [
      "Application Support",
      "Caches",
      "Logs",
      "WebKit",
      "HTTPStorages",
      "Saved Application State",
    ])
      isolate(
        join(
          homedir(),
          "Library",
          area,
          area === "Saved Application State" ? `${identifier}.savedState` : identifier,
        ),
        join(root, area === "Application Support" ? "data" : area),
      );
  } else if (process.platform === "win32") {
    for (const area of new Set([process.env.APPDATA, process.env.LOCALAPPDATA])) {
      assert(area, "Windows application data directory is unavailable");
      isolate(join(area, identifier), join(root, "data"));
    }
  } else {
    env.XDG_DATA_HOME = join(root, "profile-data");
    env.XDG_CONFIG_HOME = join(root, "profile-config");
    env.XDG_CACHE_HOME = join(root, "profile-cache");
    isolate(join(env.XDG_DATA_HOME, identifier), join(root, "data"));
  }
  const mainWindow = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app.windows.find(
    (window) => window.label === "main",
  );
  assert(mainWindow, "Missing production main-window configuration");
  const overlay = JSON.stringify({
    identifier,
    productName: "uTerm Shared State QA",
    plugins: { "deep-link": { desktop: { schemes: [] } } },
    app: {
      windows: [
        {
          ...mainWindow,
          label: "main",
          title: "uTerm Shared State QA",
          width: performanceOnly ? 1200 : 960,
          height: performanceOnly ? 720 : 620,
          minWidth: 640,
          minHeight: 420,
          visible: true,
          focus: true,
          dragDropEnabled: false,
        },
      ],
    },
  });
  if (!process.argv.includes("--skip-build")) {
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/@tauri-apps/cli/tauri.js",
        "build",
        "--debug",
        "--no-bundle",
        "--features",
        "qa",
        "--config",
        overlay,
        "--",
        "--locked",
      ],
      { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    writeFileSync(join(output, "qa-build.log"), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    assert.equal(result.status, 0, `QA build failed: ${result.error ?? "see qa-build.log"}`);
  }
  binary = resolve(
    process.env.CARGO_TARGET_DIR ?? "src-tauri/target",
    "debug",
    `uterm${process.platform === "win32" ? ".exe" : ""}`,
  );
  if (process.platform === "darwin") {
    const bundle = join(root, "uTerm Shared State QA.app");
    mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
    copyFileSync(binary, join(bundle, "Contents/MacOS/uterm"));
    binary = join(bundle, "Contents/MacOS/uterm");
    writeFileSync(
      join(bundle, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleName</key><string>uTerm Shared State QA</string><key>CFBundleExecutable</key><string>uterm</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>`,
    );
    execute("codesign", ["--force", "--deep", "--sign", "-", bundle]);
    const swift = join(root, "window.swift");
    writeFileSync(
      swift,
      `import Cocoa
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
NSRunningApplication(processIdentifier: pid)?.activate(options: [])
Thread.sleep(forTimeInterval: 0.3)
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
func area(_ window: [String: Any]) -> Double {
    let bounds = window[kCGWindowBounds as String] as? [String: NSNumber] ?? [:]
    let width = bounds["Width"]?.doubleValue ?? 0
    let height = bounds["Height"]?.doubleValue ?? 0
    return width * height
}
let owned: [[String: Any]] = windows.filter { window in
    let owner = window[kCGWindowOwnerPID as String] as? NSNumber
    let layer = window[kCGWindowLayer as String] as? NSNumber
    return owner?.int32Value == pid && layer?.intValue == 0
}
let ordered: [[String: Any]] = owned.sorted { area($0) > area($1) }
guard let window = ordered.first,
      let number = window[kCGWindowNumber as String] as? NSNumber else { exit(2) }
print(number.uint32Value)
`,
    );
    execute("swiftc", [swift, "-o", join(root, "window-id")]);
  }
  if (process.platform === "win32") {
    copyFileSync(resolve("scripts/windows-window-capture.ps1"), join(root, "capture.ps1"));
  }
  function capture(path, target = child) {
    if (process.platform === "darwin") {
      const id = execute(join(root, "window-id"), [String(target.pid)]).trim();
      execute("/usr/sbin/screencapture", ["-x", "-o", "-l", id, path]);
    } else if (process.platform === "win32") {
      execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(root, "capture.ps1"),
          "-TargetProcessId",
          String(target.pid),
          "-Destination",
          path,
        ],
        { timeout: 60000 },
      );
    } else execute("import", ["-window", "root", path]);
    assert(readFileSync(path).length > 5000, "Screenshot was not captured");
  }
  async function runInputControl() {
    const applications = [];
    function start(phase) {
      const process = spawn(binary, ["--qa-data-root", root, "--qa-phase", phase], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      inputControlChildren.push(process);
      const state = { phase, process, log: "", closed: false, code: null, observed: new Set() };
      process.stdout.on("data", (text) => (state.log += text));
      process.stderr.on("data", (text) => (state.log += text));
      process.once("error", (error) => {
        state.log += String(error);
        state.closed = true;
      });
      process.once("close", (code) => {
        state.code = code;
        state.closed = true;
      });
      applications.push(state);
      return state;
    }
    const owner = start("input-owner");
    let viewer;
    let ownerReadonlyAck;
    const deadline = Date.now() + 180000;
    try {
      while (Date.now() < deadline) {
        for (const state of [...applications]) {
          for (const file of readdirSync(evidence).filter(
            (name) => name.startsWith(state.phase + "-") && name.endsWith(".json"),
          )) {
            if (state.observed.has(file)) continue;
            state.observed.add(file);
            const value = JSON.parse(readFileSync(join(evidence, file), "utf8"));
            assert.equal(value.context.head, head);
            assert.equal(value.context.tested, tested);
            const screenshot = file.replace(/\.json$/, ".png");
            capture(join(output, screenshot), state.process);
            copyFileSync(join(evidence, file), join(output, file));
            scenes.push({
              file,
              screenshot,
              scenario: value.scene,
              checks: value.checks,
              ...metadata,
            });
            assert.notEqual(value.scene, "failure", JSON.stringify(value.checks));
            const ack = join(evidence, file.replace(/\.json$/, ".ack"));
            if (value.scene === "input-owner-readonly") ownerReadonlyAck = ack;
            else writeFileSync(ack, "captured");
            if (value.scene === "input-owner-ready") viewer = start("input-viewer");
          }
        }
        if (viewer?.closed) {
          assert.equal(viewer.code, 0, viewer.log);
          if (ownerReadonlyAck) {
            writeFileSync(ownerReadonlyAck, "viewer ordinary exit verified");
            ownerReadonlyAck = undefined;
          }
        }
        if (owner.closed) {
          assert.equal(owner.code, 0, owner.log);
          assert(viewer?.closed, "Original owner exited before the viewer completed");
          assert.equal(owner.observed.size, 5, owner.log);
          assert.equal(viewer.observed.size, 3, viewer.log);
          const ready = scenes.find((s) => s.scenario === "input-owner-ready").checks;
          assert.equal(ready.initialInput.writable, true);
          assert.match(ready.initialInput.prompt, /[$#>%]$/);
          const passive = scenes.find((s) => s.scenario === "input-viewer-readonly").checks;
          assert.equal(ready.sessionID, passive.sessionID);
          assert.equal(ready.generation, passive.generation);
          assert.equal(ready.hostPID, passive.hostPID);
          for (const value of [ready, passive]) {
            assert.equal(value.rendererRecovery.recoveredRenderer, "dom");
            assert(value.rendererRecovery.domText.includes("OWNER_READY"));
            if (value.rendererRecovery.initialRenderer === "webgl2")
              assert(value.rendererRecovery.injectedContextLoss);
          }
          for (const name of ["stale-owner.txt", "passive-viewer.txt"])
            assert(!existsSync(join(root, "project", name)), name);
          return;
        }
        await delay(100);
      }
      throw Error("Concurrent actual Tauri input-control acceptance timed out");
    } finally {
      for (const state of applications) {
        writeFileSync(join(output, state.phase + ".log"), state.log);
        writeFileSync(
          join(output, state.phase + "-process.json"),
          JSON.stringify(
            { ...metadata, phase: state.phase, exitCode: state.code, closed: state.closed },
            null,
            2,
          ),
        );
      }
    }
  }
  async function run(phase, backup) {
    let writer;
    let writerExited;
    const writerEvents = [];
    let favoriteOriginal;
    let favoriteSource;
    const favoriteFile = join(root, "data/shared-state-v1/git-favorites-v1.json");
    const favoriteDamage = Buffer.from("{damaged isolated Tauri favorite recovery");
    const favoriteChanged = Buffer.from("{newer external Tauri favorite bytes must survive");
    const worktreeDirectory = join(root, gitQA.worktreeName);
    const worktreeSentinel = join(worktreeDirectory, "qa-retained-untracked.txt");
    const worktreeBytes = Buffer.from("RETAIN_DELETE_QA 中文 e\u0301\r\n");
    let originalProjectName;
    let reviewedWorkspaceRevision;
    const args = ["--qa-data-root", root, "--qa-phase", phase];
    if (phase === "performance" && process.env.UTERM_QA_PERFORMANCE_LONG === "1")
      args.push("--qa-performance-long");
    if (backup) args.push("--qa-backup", backup);
    child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const sampler =
      phase === "performance"
        ? startResourceSampler(
            child.pid,
            join(root, "performance-phase.json"),
            join(output, "resources-tauri.json"),
          )
        : null;
    let log = "";
    let closed = false;
    let mainExited = false;
    let code;
    let exitSignal;
    child.stdout.on("data", (s) => {
      log += s;
    });
    child.stderr.on("data", (s) => {
      log += s;
    });
    child.on("error", (error) => {
      log += String(error);
      closed = true;
    });
    child.on("exit", (status, signal) => {
      mainExited = true;
      code = status;
      exitSignal = signal;
    });
    child.on("close", (status, signal) => {
      code = status;
      exitSignal = signal;
      closed = true;
    });
    const sshPhase = phase === "ssh" || phase === "ssh-reopen";
    let closedAtPhaseEnd;
    const processState = () => ({
      ...metadata,
      phase,
      mainExited,
      exitCode: code,
      closed,
      closedAtPhaseEnd,
      signal: exitSignal,
    });
    if (sshPhase) sshApplications.push({ phase, application: child, state: processState });
    const observed = new Set();
    try {
      const deadline = Date.now() + (phase === "performance" ? 1200000 : 180000);
      while (Date.now() < deadline) {
        for (const file of readdirSync(evidence).filter(
          (p) => p.startsWith(`${phase}-`) && p.endsWith(".json"),
        )) {
          if (observed.has(file)) continue;
          observed.add(file);
          const value = JSON.parse(readFileSync(join(evidence, file), "utf8"));
          assert.equal(value.context.head, head);
          assert.equal(value.context.tested, tested);
          if (phase === "agents" && value.scene !== "failure") {
            const checks = {
              "agent-live-command": [
                "customCommandSaved",
                "canonicalEnable",
                "canonicalNotificationOptOut",
                "settingWritesCompletedBeforeObserverRead",
              ],
              "agent-live-hooks": ["actualHooksCommand", "privateLocalUsageRead"],
              "agent-live-errors": ["invalidArgumentErrorVisible", "invalidDraftRetained"],
            }[value.scene];
            assert(checks, `Unexpected Agent acceptance scene: ${value.scene}`);
            for (const key of checks) assert.equal(value.checks[key], true, key);
          }
          if (phase === "database" && value.scene !== "failure") {
            const checks = {
              "database-live-profiles": [
                "profileSavedInCore",
                "temporaryPasswordNotPersisted",
                "defaultReadonly",
                "verifiedDriverInstalled",
              ],
              "database-live-exact": ["actualSQLExecuted", "unicodeRetained"],
              "database-live-draft": [
                "hiddenWorkbenchRetainedEditor",
                "cancelledApplicationQuitRetainedDraftAndConnection",
              ],
              "database-live-transactions": [
                "readonlyWriteRefused",
                "cancelledWriteDidNotOpenTransaction",
                "cancelledPendingDisconnectRetainedConnection",
                "rollbackAndCommitCompleted",
              ],
              "database-live-recovery": [
                "serverObservedSlowQueryCancelled",
                "temporaryPasswordReconnect",
                "reconnectDefaultsReadonly",
                "committedDataReread",
              ],
            }[value.scene];
            assert(checks, `Unexpected database acceptance scene: ${value.scene}`);
            for (const key of checks) assert.equal(value.checks[key], true, key);
            if (value.scene === "database-live-exact") {
              assert.equal(value.checks.exactInteger, "9223372036854775807");
              assert.equal(value.checks.exactDecimal, "12345678901234567890.1234567890");
            }
            if (value.scene === "database-live-profiles")
              assert.deepEqual(value.checks.supportedKinds, [
                "mysql",
                "postgresql",
                "oracle",
                "elasticsearch",
                "mongodb",
              ]);
          }
          if (phase === "redis" && value.scene !== "failure") {
            const checks = {
              "redis-live-profile": [
                "profileSavedInCore",
                "temporaryPasswordNotPersisted",
                "realAuthenticatedConnection",
                "defaultReadonly",
                "osCredentialAuthenticatedBoundAndRemoved",
              ],
              "redis-live-binary": ["binaryReadonlyPreview"],
              "redis-live-draft": [
                "hiddenWorkbenchRetainedEditor",
                "hiddenWorkbenchRetainedDraftAndConnection",
                "cancelledDisconnectRetainedDraftAndConnection",
                "cancelledApplicationQuitRetainedDraftAndConnection",
              ],
              "redis-live-saved": [
                "protectedWriteAndServerReread",
                "temporaryPasswordReconnect",
                "reconnectDefaultsReadonly",
              ],
              "redis-live-pages": ["boundedServerPage", "readonlyAboveSnapshotLimit"],
              "redis-live-mutations": [
                "cancelledMemberDeletionPreservedData",
                "reviewedIndex400Deleted",
                "cancelledKeyDeletionPreservedData",
                "reviewedKeyDeleted",
                "binarySiblingPreserved",
              ],
            }[value.scene];
            assert(checks, `Unexpected Redis acceptance scene: ${value.scene}`);
            for (const key of checks) assert.equal(value.checks[key], true, key);
            if (value.scene === "redis-live-binary") {
              assert.equal(value.checks.exactBinaryKey, "00ff6b6579");
              assert.equal(value.checks.exactBinaryValue, "ff007f");
            }
            if (value.scene === "redis-live-pages") {
              assert.equal(value.checks.rowsRendered, 200);
              assert.equal(value.checks.firstIndex, 200);
              assert.equal(value.checks.totalMembers, 20001);
            }
            if (value.scene === "redis-live-mutations") {
              assert.equal(value.checks.guiTTLSeconds, 1800);
              assert.equal(value.checks.remainingMembers, 400);
            }
          }
          if (["ssh-terminal", "ssh-reopened"].includes(value.scene)) {
            const renderer = value.checks.rendererRecovery;
            assert.equal(renderer.recoveredRenderer, "dom");
            assert(renderer.domText.includes("UTERM_SSH_TAURI_QA"));
            assert(renderer.width > 0 && renderer.height > 0);
          }
          if (value.scene.startsWith("preview-")) {
            assert.deepEqual(
              previewRequests,
              [],
              "Preview requested a forbidden loopback resource",
            );
            if (value.scene === "preview-html") {
              const actualRoot = statSync(value.checks.projectRoot, { bigint: true });
              const expectedRoot = statSync(join(root, "project"), { bigint: true });
              assert(actualRoot.isDirectory() && expectedRoot.isDirectory());
              assert.notEqual(expectedRoot.ino, 0n);
              assert.equal(actualRoot.dev, expectedRoot.dev);
              assert.equal(actualRoot.ino, expectedRoot.ino);
              assert.equal(value.checks.activeContentRemoved, true);
              assert.equal(value.checks.opaqueDocumentAccessRejected, true);
              assert.equal(value.checks.escapedMessages, 0);
              assert.equal(value.checks.sandbox, "");
            } else if (value.scene === "preview-pdf") {
              assert.equal(value.checks.actualPDFCanvas, true);
              assert.equal(value.checks.readonly, true);
              assert(value.checks.darkPixels > 8);
            }
          }
          const screenshot = file.replace(/\.json$/, ".png");
          capture(join(output, screenshot));
          copyFileSync(join(evidence, file), join(output, file));
          const argumentsForCLI = ["--control", "--data-dir", join(root, "data")];
          if (value.scene === "control-ready") {
            const status = JSON.parse(execute(binary, [...argumentsForCLI, "status"]));
            const projects = JSON.parse(execute(binary, [...argumentsForCLI, "projects", "list"]));
            assert.equal(status.sessions, 0);
            assert(projects.some((project) => project.id === "shared-state-qa"));
            writeFileSync(
              join(output, "control-cli.json"),
              JSON.stringify({ ...metadata, status, projects }, null, 2),
            );
          } else if (value.scene === "control-disabled") {
            const disabled = spawnSync(binary, [...argumentsForCLI, "status"], {
              env,
              encoding: "utf8",
            });
            assert.notEqual(disabled.status, 0);
            assert.match(disabled.stderr, /endpoint not found/i);
            writeFileSync(
              join(output, "control-disabled.json"),
              JSON.stringify({ ...metadata, endpointUnavailable: true }, null, 2),
            );
          } else if (value.scene === "git-write-prepared") {
            const hooks = join(root, "project/.git/qa-hooks");
            mkdirSync(hooks);
            const hook = join(hooks, "post-checkout");
            writeFileSync(
              hook,
              "#!/bin/sh\n: > .git/qa-git-entered\ni=0\n" +
                'while [ ! -e .git/qa-git-release ] && [ "$i" -lt 1200 ]; do\n' +
                "i=$((i+1))\nsleep 0.05\ndone\n" +
                "test -e .git/qa-git-release || exit 1\n" +
                "printf 'GIT_WRITE_FINISHED\\n' > qa-cancel-finished.txt\n",
            );
            chmodSync(hook, 0o755);
            gitFixture(["config", "core.hooksPath", hooks.replaceAll("\\", "/")]);
          } else if (value.scene === "git-write-started") {
            const deadline = Date.now() + 10000;
            while (!existsSync(join(root, "project/.git/qa-git-entered")) && Date.now() < deadline)
              await delay(20);
            assert(
              existsSync(join(root, "project/.git/qa-git-entered")),
              "Actual Git hook did not start",
            );
            assert(!existsSync(join(root, "project/qa-cancel-finished.txt")));
          } else if (value.scene === "git-write-quit-blocked") {
            assert(!closed, "Normal quit terminated the running Git write");
            assert(!existsSync(join(root, "project/qa-cancel-finished.txt")));
            writeFileSync(join(root, "project/.git/qa-git-release"), "release\n");
          } else if (value.scene === "git-write-completed") {
            assert.equal(
              readFileSync(join(root, "project/qa-cancel-finished.txt"), "utf8"),
              "GIT_WRITE_FINISHED\n",
            );
            assert.equal(gitFixture(["branch", "--show-current"]).trim(), "qa-tauri-created");
            writeFileSync(
              join(output, "git-cancel-exit.json"),
              JSON.stringify(
                {
                  ...metadata,
                  actualHookPaused: true,
                  cancelledCallerRetained: true,
                  normalQuitRefused: true,
                  finalBranch: "qa-tauri-created",
                  finalBytes: "GIT_WRITE_FINISHED\n",
                },
                null,
                2,
              ),
            );
          } else if (value.scene === "git-worktree") {
            writeFileSync(worktreeSentinel, worktreeBytes);
          } else if (value.scene === "git-worktree-delete-review") {
            assert.deepEqual(readFileSync(worktreeSentinel), worktreeBytes);
            reviewedWorkspaceRevision = coreFixture("snapshot.read").revision;
          } else if (value.scene === "git-worktree-delete-dirty") {
            assert.deepEqual(
              readFileSync(worktreeSentinel),
              worktreeBytes,
              "Cancel or dirty refusal changed file bytes",
            );
            const snapshot = coreFixture("snapshot.read");
            assert.equal(
              snapshot.revision,
              reviewedWorkspaceRevision,
              "Cancel or dirty refusal changed workspace metadata",
            );
            assert(
              snapshot.document.workspace.projects
                .find((item) => item.id === "shared-state-qa")
                .worktrees.some((item) => item.id === value.checks.worktreeId),
            );
            unlinkSync(worktreeSentinel);
          } else if (value.scene === "git-worktree-delete-stale") {
            const before = coreFixture("snapshot.read");
            originalProjectName = before.document.workspace.projects.find(
              (item) => item.id === value.checks.projectId,
            ).name;
            const after = coreFixture("project.rename", {
              id: value.checks.projectId,
              name: "External QA project",
              expectedRevision: before.revision,
            });
            assert.notEqual(after.revision, before.revision);
            writeFileSync(
              join(output, "worktree-external-revision.json"),
              JSON.stringify(
                {
                  ...metadata,
                  before: before.revision,
                  after: after.revision,
                  projectId: value.checks.projectId,
                },
                null,
                2,
              ),
            );
          } else if (value.scene === "git-worktree-delete-conflict") {
            assert(existsSync(worktreeDirectory), "Stale confirmation deleted the Worktree");
            assert(
              coreFixture("snapshot.read")
                .document.workspace.projects.find((item) => item.id === "shared-state-qa")
                .worktrees.some((item) => item.id === value.checks.worktreeId),
            );
          } else if (value.scene === "git-worktree-deleted") {
            assert(!existsSync(worktreeDirectory));
            const snapshot = coreFixture("snapshot.read");
            assert(
              !snapshot.document.workspace.projects
                .find((item) => item.id === "shared-state-qa")
                .worktrees.some((item) => item.id === value.checks.worktreeId),
            );
            assert(!gitFixture(["worktree", "list", "--porcelain"]).includes(gitQA.worktreeName));
            assert.equal(
              gitFixture(["rev-parse", "refs/heads/qa-tauri-worktree"]).trim(),
              gitFixture(["rev-parse", "HEAD"]).trim(),
            );
            assert.equal(
              readFileSync(join(root, "project", gitQA.fileName), "utf8"),
              gitQA.changedText,
            );
            assert(originalProjectName);
            coreFixture("project.rename", {
              id: "shared-state-qa",
              name: originalProjectName,
              expectedRevision: snapshot.revision,
            });
          } else if (value.scene === "git-favorite-recovery-ready") {
            for (const phase of ["checkpoint", "restore-fixture"]) {
              const attempts = value.checks.favoriteFixtureAttempts.filter(
                (item) => item.phase === phase,
              );
              assert(attempts.length > 0 && attempts.length <= 3);
              assert(attempts.at(-1).saved);
              assert(attempts.every((item) => item.unchangedOnBusy));
            }
            favoriteOriginal = readFileSync(favoriteFile);
            assert.equal(
              createHash("sha256").update(favoriteOriginal).digest("hex"),
              value.checks.revision,
            );
            assert.match(value.checks.sourceDigest, /^[a-f0-9]{64}$/);
            favoriteSource = readFileSync(
              join(
                root,
                "data/shared-state-v1",
                `git-favorite-source-${value.checks.sourceDigest}.json`,
              ),
              "utf8",
            );
            writeFileSync(favoriteFile, favoriteDamage);
          } else if (value.scene === "git-favorite-recovery-preview") {
            assert(
              value.checks.favoritePreviewReloads > 0,
              "Missing actual explicit preview reload",
            );
            assert(value.checks.recoveredAfterOwnedWriterReleased);
            assert.deepEqual(
              readFileSync(favoriteFile),
              favoriteDamage,
              "Preview changed damaged favorites",
            );
          } else if (value.scene === "git-favorite-recovery-source") {
            let copied;
            if (process.platform === "darwin") copied = execute("/usr/bin/pbpaste", []);
            else if (process.platform === "win32")
              copied = JSON.parse(
                execute("powershell.exe", [
                  "-NoProfile",
                  "-Command",
                  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ConvertTo-Json -Compress -InputObject (Get-Clipboard -Raw)",
                ])
                  .trim()
                  .replace(/^\uFEFF/, ""),
              );
            else
              copied = JSON.parse(
                execute("/usr/bin/python3", [
                  "-c",
                  "import gi,json;gi.require_version('Gtk','3.0');from gi.repository import Gtk,Gdk;Gtk.init([]);print(json.dumps(Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_text()))",
                ]),
              );
            assert.equal(
              copied,
              favoriteSource,
              "Actual OS clipboard differs from complete original favorite source",
            );
            assert.deepEqual(
              readFileSync(favoriteFile),
              favoriteDamage,
              "Cancel/copy modified favorite data",
            );
            writeFileSync(
              join(output, "git-favorite-recovery-clipboard.json"),
              JSON.stringify(
                {
                  ...metadata,
                  exactSource: true,
                  sourceDigest: value.checks.sourceDigest,
                  sourceBytes: Buffer.byteLength(favoriteSource),
                },
                null,
                2,
              ),
            );
          } else if (value.scene === "git-favorite-recovery-stale") {
            writeFileSync(favoriteFile, favoriteChanged);
          } else if (value.scene === "git-favorite-recovery-conflict") {
            assert.deepEqual(
              readFileSync(favoriteFile),
              favoriteChanged,
              "Stale restore overwrote newer bytes",
            );
          } else if (value.scene === "git-favorite-recovery-restored") {
            assert.deepEqual(readFileSync(favoriteFile), favoriteOriginal);
            const digest = createHash("sha256").update(favoriteChanged).digest("hex");
            assert.deepEqual(
              readFileSync(join(root, "data/shared-state-v1", `git-favorites-${digest}.damaged`)),
              favoriteChanged,
            );
            unlinkSync(favoriteFile);
          } else if (value.scene === "git-favorite-recovery-missing") {
            assert(!existsSync(favoriteFile), "Preview recreated absent snapshot");
          } else if (value.scene === "git-favorite-recovery-complete") {
            assert.deepEqual(readFileSync(favoriteFile), favoriteOriginal);
          } else if (
            value.scene === "editor-imported" ||
            value.scene === "git-favorite-recovery-lock-ready"
          ) {
            const target = resolve(process.env.CARGO_TARGET_DIR ?? "crates/uterm-core/target");
            writer = spawn(
              join(
                target,
                "debug",
                `uterm-core-contract${process.platform === "win32" ? ".exe" : ""}`,
              ),
              ["--hold-store-lock", join(root, "data/shared-state-v1")],
              { env, stdio: ["pipe", "pipe", "pipe"] },
            );
            writerExited = new Promise((done, reject) => {
              writer.once("error", reject);
              writer.once("close", (status) => done(status));
            });
            writer.stderr.on("data", (text) => {
              log += text;
            });
            const lines = createInterface({ input: writer.stdout });
            const deadline = setTimeout(() => writer.kill(), 15000);
            try {
              assert.equal((await lines[Symbol.asyncIterator]().next()).value, "locked");
            } finally {
              clearTimeout(deadline);
              lines.close();
            }
            writerEvents.push({ state: "locked", pid: writer.pid });
          } else if (
            value.scene === "editor-write-rejected" ||
            value.scene === "git-favorite-recovery-busy"
          ) {
            assert(writer, "Missing owned writer fixture");
            writer.stdin.end("release\n");
            assert.equal(await writerExited, 0);
            const favoritePreview = value.scene === "git-favorite-recovery-busy";
            if (favoritePreview) {
              assert(value.checks.canonicalWriterBusy && value.checks.restoreDisabled);
              assert.deepEqual(readFileSync(favoriteFile), favoriteDamage);
            }
            writerEvents.push({
              state: favoritePreview ? "released-after-busy-preview" : "released-after-rejection",
              pid: writer.pid,
            });
            writer = undefined;
            writeFileSync(
              join(
                output,
                favoritePreview ? "favorite-writer-lock.json" : "editor-writer-lock.json",
              ),
              JSON.stringify({ ...metadata, events: writerEvents }, null, 2),
            );
          }
          scenes.push({
            file,
            screenshot,
            scenario: value.scene,
            checks: value.checks,
            ...metadata,
          });
          writeFileSync(join(evidence, file.replace(/\.json$/, ".ack")), "captured");
          assert.notEqual(value.scene, "failure", JSON.stringify(value.checks));
          if (value.scene === "editor-durable") {
            assert(child.kill("SIGKILL"), "Checkpoint process could not be forcibly terminated");
          }
        }
        // A retained SSH host can inherit logging pipes after the app exits.
        // 保留的 SSH 宿主可在应用退出后继续持有日志管道。
        if (sshPhase ? mainExited : closed) {
          writeFileSync(
            join(output, `${phase}-process.json`),
            JSON.stringify(
              {
                ...metadata,
                phase,
                exitCode: code,
                signal: exitSignal ?? null,
                forcedExitRequested: phase === "editor-checkpoint",
              },
              null,
              2,
            ),
          );
          if (phase === "editor-checkpoint")
            assert.equal(exitSignal, "SIGKILL", `${phase} exit: ${log}`);
          else assert.equal(code, 0, `${phase} exit: ${log}`);
          break;
        }
        await delay(100);
      }
      assert(
        sshPhase ? mainExited : closed,
        `${phase} did not finish ordinary exit: mainExited=${mainExited}, code=${code}, log=${log.slice(-1000)}`,
      );
      const expected =
        phase === "performance"
          ? 2
          : phase === "agents"
            ? 3
            : phase === "database"
              ? 5
              : phase === "redis"
                ? 6
                : phase === "ssh"
                  ? 3
                  : phase === "ssh-reopen"
                    ? 1
                    : phase === "git"
                      ? 25
                      : phase === "editor-checkpoint"
                        ? 3
                        : phase.startsWith("editor-")
                          ? 5
                          : phase === "initial"
                            ? 10
                            : phase === "reopen"
                              ? 1
                              : 3;
      if (phase === "ui-parity") {
        assertParityScenes(
          [...observed].map((file) => file.slice(`${phase}-`.length, -".json".length)),
          parityFixture,
        );
        assertParityOperations(scenes, parityFixture);
      } else assert.equal(observed.size, expected, `${phase} omitted required scenes`);
    } finally {
      if (phase === "git") writeFileSync(join(root, "project/.git/qa-git-release"), "release\n");
      if (writer) {
        writer.stdin.end("release\n");
        writer.kill();
        await writerExited;
      }
      writeFileSync(join(output, `${phase}.log`), log);
      closedAtPhaseEnd = closed;
      writeFileSync(join(output, `${phase}-process.json`), JSON.stringify(processState(), null, 2));
      if (sampler) {
        try {
          await sampler.stop();
        } catch (error) {
          cleanupErrors.push(String(error));
        }
      }
    }
  }
  if (parityOnly) {
    const directory = join(root, "parity/project");
    mkdirSync(directory, { recursive: true });
    const githubFixtureRoot = join(root, "parity/uterm-native-qa-github-parity");
    Object.assign(
      env,
      JSON.parse(
        execute("python3", [
          resolve("scripts/ui-parity-github-fixture.py"),
          "--root",
          githubFixtureRoot,
          "--project",
          directory,
        ]),
      ),
    );
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ])
      delete env[key];
    for (const [name, value] of Object.entries(parityFixture.files)) {
      assert(!name.includes("/") && name !== "." && name !== "..");
      writeFileSync(join(directory, name), value);
    }
    assert.equal(parityFixture.pdf.path, ".ui-parity-pdf/fixture.pdf");
    const pdf = Buffer.from(parityFixture.pdf.base64, "base64");
    assert.equal(createHash("sha256").update(pdf).digest("hex"), parityFixture.pdf.sha256);
    mkdirSync(dirname(join(directory, parityFixture.pdf.path)), { recursive: true });
    writeFileSync(join(directory, parityFixture.pdf.path), pdf);
    await run("ui-parity");
    assertParityScenes(
      scenes.map((scene) => scene.scenario),
      parityFixture,
    );
    assertParityOperations(scenes, parityFixture);
    const cliLog = readFileSync(join(githubFixtureRoot, "github-cli.jsonl"), "utf8");
    const cliCalls = cliLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(
      cliCalls.length > 0 && cliCalls.every((call) => call.arguments[0] !== "api"),
      "PR comparison dispatched a GitHub write",
    );
    writeFileSync(join(output, "github-parity-cli-simulated.jsonl"), cliLog);
  } else if (performanceOnly) {
    await run("performance");
  } else {
    await run("editor-checkpoint");
    await run("editor-reopen");
    assert.equal(readFileSync(join(root, "project", previewQA.pdfFile), "utf8"), pdf);
    assert.deepEqual(previewRequests, []);
    assert.equal(
      readFileSync(join(root, "project", editorFixture.fileName), "utf8"),
      "\ufeff" + editorFixture.savedText,
    );
    await run("git");
    assert.equal(
      gitFixture(["rev-parse", "refs/heads/qa-tauri-created"]).trim(),
      gitFixture(["rev-parse", "HEAD"]).trim(),
    );
    assert.equal(readFileSync(join(root, "project", gitQA.fileName), "utf8"), gitQA.changedText);
    await run("initial");
    const store = join(root, "data/shared-state-v1");
    const original = readFileSync(join(store, "legacy-original.json"));
    await run("reopen");
    assert.deepEqual(readFileSync(join(store, "legacy-original.json")), original);
    await runInputControl();
    const backup = readdirSync(store).find((p) => {
      if (!/^snapshot-[a-f0-9]{64}\.backup$/.test(p)) return false;
      const s = JSON.parse(readFileSync(join(store, p), "utf8")).settings;
      return s.fileFontSize === 17 && s.fontSize === 21;
    });
    assert(backup, "No recovery copy of external settings");
    const damaged = Buffer.from('{"deliberatelyInterruptedQA":');
    writeFileSync(join(store, "snapshot-v1.json"), damaged);
    await run("recover", backup.slice(9, -7));
    const digest = createHash("sha256").update(damaged).digest("hex");
    assert.deepEqual(readFileSync(join(store, `snapshot-${digest}.damaged`)), damaged);
    assert.deepEqual(readFileSync(join(store, "legacy-original.json")), original);
    if (process.env.UTERM_QA_REDIS_FIXTURE) await run("redis");
    if (process.env.UTERM_QA_DATABASE_FIXTURE) await run("database");
    const agentSnapshot = coreFixture("snapshot.read");
    coreFixture("settings.patch", {
      expectedRevision: agentSnapshot.revision,
      patch: { agentNotifications: true },
    });
    await run("agents");
    const retainedAgentConfig = JSON.parse(readFileSync(join(agentHome, "settings.json"), "utf8"));
    assert.equal(retainedAgentConfig.keep, "private QA setting");
    assert.equal(
      retainedAgentConfig.hooks.UserPromptSubmit[0].hooks[0].command,
      "other-tool --start",
    );
    assert(
      !JSON.stringify(retainedAgentConfig).includes("--agent-report"),
      "Removing Hooks retained a managed reporter",
    );
    writeFileSync(
      join(output, "agent-live.json"),
      JSON.stringify(
        {
          ...metadata,
          passed: true,
          privateHomeOnly: true,
          unrelatedHooksPreserved: true,
          managedHooksRemoved: true,
          providerAuthenticationExecuted: false,
          notificationPermissionEnablePath:
            "mocked frontend regressions; real window exercises opt-out only",
        },
        null,
        2,
      ),
    );
    if (process.env.UTERM_QA_SSH_FIXTURE) {
      await run("ssh");
      await run("ssh-reopen");
    }
    writeFileSync(
      join(output, "storage.json"),
      JSON.stringify(
        {
          originalRetained: true,
          damagedBytesRetained: true,
          recoveryBackup: backup,
          scenes: scenes.length,
        },
        null,
        2,
      ),
    );
  }
  successful = true;
} finally {
  const cleanupErrors = [];
  if (previewServer?.listening) {
    previewServer.closeAllConnections();
    await new Promise((done) =>
      previewServer.close((error) => {
        if (error) cleanupErrors.push(String(error));
        done();
      }),
    );
  }
  for (const application of inputControlChildren) {
    if (application.exitCode === null && application.signalCode === null) {
      application.kill();
      await Promise.race([new Promise((done) => application.once("close", done)), delay(3000)]);
      if (application.exitCode === null && application.signalCode === null) {
        application.kill("SIGKILL");
        await new Promise((done) => application.once("close", done));
      }
    }
  }
  if (child?.exitCode === null) {
    child.kill();
    await Promise.race([new Promise((done) => child.once("close", done)), delay(3000)]);
  }
  const endpoint = join(root, "data/local-daemon-v1/endpoint.json");
  if (binary && existsSync(endpoint)) {
    const cleanup = spawnSync(binary, ["--qa-cleanup", "--qa-data-root", root], {
      env,
      encoding: "utf8",
    });
    writeFileSync(join(output, "cleanup.log"), `${cleanup.stdout ?? ""}\n${cleanup.stderr ?? ""}`);
    if (cleanup.status !== 0)
      cleanupErrors.push("Private idle host cleanup failed; see cleanup.log");
  }
  // Require natural pipe closure after the owned host is stopped; do not hide orphaned writers.
  // 所属宿主停止后必须自然关闭管道，不能掩盖遗留写入进程。
  for (const item of sshApplications) {
    const deadline = Date.now() + 10000;
    while (!item.state().closed && Date.now() < deadline) await delay(100);
    const state = item.state();
    writeFileSync(
      join(output, `${item.phase}-process.json`),
      JSON.stringify({ ...state, stdioClosedAfterHostCleanup: state.closed }, null, 2),
    );
    if (!state.closed) {
      cleanupErrors.push(`${item.phase} logging pipes remained open after owned-host cleanup`);
      if (process.platform === "win32") {
        const roots = [
          ...sshApplications.map((value) => value.application.pid),
          ...scenes
            .filter((value) => value.scenario === "ssh-terminal")
            .map((value) => value.checks.hostPID),
        ].filter(Number.isSafeInteger);
        const diagnostics = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `$records=@(Get-CimInstance Win32_Process); $owned=@(${roots.join(",")}); do { $previous=$owned.Count; $found=@($records | Where-Object { $_.ProcessId -in $owned -or $_.ParentProcessId -in $owned }); $owned=@($owned + $found.ProcessId | Select-Object -Unique) } while ($owned.Count -gt $previous); $found | Select-Object ProcessId,ParentProcessId,Name,SessionId | ConvertTo-Json`,
          ],
          { encoding: "utf8", timeout: 10000 },
        );
        writeFileSync(
          join(output, `${item.phase}-process-tree.json`),
          JSON.stringify(
            { roots, stdout: diagnostics.stdout, stderr: diagnostics.stderr },
            null,
            2,
          ),
        );
      }
      item.application.stdout.destroy();
      item.application.stderr.destroy();
    }
  }
  for (const link of profileLinks.reverse()) {
    try {
      assert(lstatSync(link).isSymbolicLink(), "QA refuses to remove a replaced profile link");
      unlinkSync(link);
    } catch (error) {
      if (error.code !== "ENOENT") cleanupErrors.push(String(error));
    }
  }
  if (parityOnly) {
    const githubLog = join(root, "parity/uterm-native-qa-github-parity/github-cli.jsonl");
    if (existsSync(githubLog))
      copyFileSync(githubLog, join(output, "github-parity-cli-simulated.jsonl"));
  }
  // Keep failure fixtures only in the isolated temporary profile for diagnosis.
  // 失败测试数据仅保留在隔离临时配置中供诊断。
  if (successful && !cleanupErrors.length) {
    const started = Date.now();
    try {
      // Let process and filesystem callbacks drain while Windows releases owned profile handles.
      // 等待 Windows 释放测试配置句柄时，继续处理进程和文件系统回调。
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      assert(!existsSync(root), "The isolated temporary profile still exists after removal");
    } catch (error) {
      cleanupErrors.push(String(error));
    } finally {
      writeFileSync(
        join(output, "temporary-profile-cleanup.json"),
        JSON.stringify(
          { removed: !existsSync(root), elapsedMs: Date.now() - started, errors: cleanupErrors },
          null,
          2,
        ),
      );
    }
  }
  successful &&= cleanupErrors.length === 0;
  writeFileSync(
    join(output, "preview-resource-isolation.json"),
    JSON.stringify(
      {
        ...metadata,
        passed: successful && previewRequests.length === 0,
        actualLoopbackHTTPObserver: previewObserverStarted,
        forbiddenRequests: previewRequests,
        resourceServerClosed: !previewServer?.listening,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(output, "report.json"),
    JSON.stringify({ passed: successful, ...metadata, scenes, cleanupErrors }, null, 2),
  );
  if (!successful) process.exitCode = 1;
}
