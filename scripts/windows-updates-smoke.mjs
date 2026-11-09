import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir, arch, version } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

assert.equal(process.platform, "win32", "Actual Windows updater QA requires Windows");
const root = mkdtempSync(join(tmpdir(), "uterm-tauri-qa-updates-"));
const output = resolve("ci-evidence/updates-windows");
mkdirSync(output, { recursive: true });
mkdirSync(join(root, "project"));
mkdirSync(join(root, "data"));
assert(process.env.UTERM_QA_DATABASE_FIXTURE, "Use the owned database wrapper for updater QA");
copyFileSync(process.env.UTERM_QA_DATABASE_FIXTURE, join(root, "database-fixture.json"));
const identity = "sh.uterm.desktop.qa.sharedstate";
const product = "uTerm Shared State QA";
const target = resolve(process.env.CARGO_TARGET_DIR ?? "src-tauri/target");
const install = join(root, "Private Applications");
const links = [];
const requests = [];
const scenes = [];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const command = (
  file,
  args,
  { secret = false, timeout = 120000, env = process.env, verbatim = false } = {},
) => {
  const result = spawnSync(file, args, {
    env,
    timeout,
    windowsVerbatimArguments: verbatim,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw Error(
      `${file} failed (${result.status}): ${secret ? "private signer output withheld" : (result.stderr ?? result.error ?? "")}`,
    );
  return secret ? "" : result.stdout;
};
const tested = command("git", ["rev-parse", "HEAD"]).trim();
const head = process.env.PR_HEAD_SHA || tested;
assert.equal(command("git", ["status", "--porcelain"]).trim(), "", "Use a clean source tree");
const env = {
  ...process.env,
  VITE_UTERM_STATE_QA: "1",
  UTERM_QA_HEAD: head,
  UTERM_QA_TESTED: tested,
  UTERM_QA_DIRTY: "false",
  UTERM_QA_UPDATES_ROOT: root,
};
delete env.TAURI_SIGNING_PRIVATE_KEY;
delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
const report = {
  passed: false,
  sourceHeadSHA: head,
  testedMergeSHA: tested,
  sourceTreeDirty: false,
  platform: "Windows",
  architecture: arch(),
  system: version(),
  sdk: "tauri-plugin-updater 2.12.0",
  productionFeedChanged: false,
  productionDataAccess: false,
  actualInstallOrRelaunchExecuted: false,
  unsignedAuthenticode: true,
  scenarios: scenes,
};
report.toolchain = {
  node: process.version,
  rust: command("rustc", ["--version"]).trim(),
  cargo: command("cargo", ["--version"]).trim(),
  pnpm: command("powershell.exe", ["-NoProfile", "-Command", "pnpm --version"]).trim(),
};
let payload;
let signature;
let badSignature;
let publicKey;
let child;
let installed = false;
let stdout = "";
let stderr = "";
const counters = new Map();
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const mode = existsSync(join(root, "updates-mode"))
    ? readFileSync(join(root, "updates-mode"), "utf8")
    : "unselected";
  const event = {
    path: url.pathname,
    query: url.search,
    mode,
    range: request.headers.range ?? null,
    beforeDriver: mode === "unselected",
    at: new Date().toISOString(),
  };
  if (mode === "automatic") {
    try {
      event.beforeOptIn = !JSON.parse(
        readFileSync(join(root, "data/shared-state-v1/snapshot-v1.json"), "utf8"),
      ).settings.automaticUpdates;
    } catch {
      event.beforeOptIn = true;
    }
  }
  requests.push(event);
  writeFileSync(join(output, "http-requests.json"), JSON.stringify(requests, null, 2));
  if (event.beforeDriver || event.beforeOptIn) {
    response.writeHead(403);
    response.end();
    return;
  }
  if (mode === "offline") {
    response.destroy();
    return;
  }
  if (url.pathname === "/manifest.json") {
    const platform = mode === "wrong-arch" ? "windows-aarch64" : "windows-x86_64";
    const body = JSON.stringify({
      version: mode === "old-version" ? "0.0.1" : "0.2.5",
      notes: "Isolated signed Windows QA update",
      platforms: {
        [platform]: {
          signature: mode === "bad-signature" ? badSignature : signature,
          url: `http://127.0.0.1:${server.address().port}/update.exe?case=${mode}`,
        },
      },
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(body);
    return;
  }
  if (url.pathname !== "/update.exe" || !payload) {
    response.writeHead(404);
    response.end();
    return;
  }
  const key = url.searchParams.get("case");
  const count = (counters.get(key) ?? 0) + 1;
  counters.set(key, count);
  const start = Number(/^bytes=(\d+)-$/u.exec(request.headers.range ?? "")?.[1] ?? 0);
  if (start >= payload.length) {
    response.writeHead(416);
    response.end();
    return;
  }
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Length": payload.length - start,
    "Accept-Ranges": "bytes",
    ETag: '"owned-signed-test-update"',
  };
  if (start) headers["Content-Range"] = `bytes ${start}-${payload.length - 1}/${payload.length}`;
  response.writeHead(start ? 206 : 200, headers);
  if (key === "interrupted" && count === 1) {
    response.write(payload.subarray(start, Math.floor(payload.length / 2)));
    setTimeout(() => response.destroy(), 100);
  } else response.end(payload.subarray(start));
});

try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  for (const area of new Set([process.env.APPDATA, process.env.LOCALAPPDATA])) {
    assert(area);
    const link = join(area, identity);
    assert(!existsSync(link), "Refuse an existing QA profile");
    symlinkSync(join(root, "data"), link, "junction");
    links.push(link);
  }
  const cli = "node_modules/@tauri-apps/cli/tauri.js";
  const key = join(root, "test.key");
  const other = join(root, "other.key");
  for (const file of [key, other])
    command(process.execPath, [cli, "signer", "generate", "--ci", "-w", file, "-p", ""], {
      secret: true,
      env,
    });
  publicKey = readFileSync(key + ".pub", "utf8").trim();
  const packages = [];
  for (const appVersion of ["0.2.4", "0.2.5"]) {
    const overlay = {
      identifier: identity,
      productName: product,
      version: appVersion,
      plugins: {
        "deep-link": { desktop: { schemes: [] } },
        updater: {
          endpoints: [`http://127.0.0.1:${server.address().port}/manifest.json`],
          pubkey: publicKey,
          requireSignedVersion: true,
          dangerousInsecureTransportProtocol: true,
          windows: { installMode: "passive" },
        },
      },
      bundle: {
        createUpdaterArtifacts: false,
        windows: {
          webviewInstallMode: { type: "skip" },
          nsis: { installMode: "currentUser", installerHooks: "qa-candidate-installer.nsh" },
        },
      },
      app: {
        windows: [
          {
            label: "main",
            title: product,
            width: 1100,
            height: 720,
            minWidth: 640,
            minHeight: 420,
            visible: true,
            focus: true,
            dragDropEnabled: false,
          },
        ],
      },
    };
    const config = join(root, `overlay-${appVersion}.json`);
    writeFileSync(config, JSON.stringify(overlay));
    const result = spawnSync(
      process.execPath,
      [
        "scripts/tauri-build.mjs",
        "--debug",
        "--features",
        "qa",
        "--bundles",
        "nsis",
        "--config",
        config,
        "--",
        "--locked",
      ],
      { env, encoding: "utf8", timeout: 25 * 60000, maxBuffer: 128 * 1024 * 1024 },
    );
    writeFileSync(
      join(output, `build-${appVersion}.log`),
      (result.stdout ?? "") + (result.stderr ?? ""),
    );
    assert.equal(result.status, 0, "QA NSIS build failed");
    const directory = join(target, "debug/bundle/nsis");
    const names = readdirSync(directory).filter(
      (name) => name.startsWith(`${product}_${appVersion}_`) && name.endsWith("-setup.exe"),
    );
    assert.equal(names.length, 1);
    const file = join(output, `uTerm-QA-${appVersion}-windows-x64-setup.exe`);
    copyFileSync(join(directory, names[0]), file);
    packages.push(file);
    if (appVersion === "0.2.5")
      copyFileSync(join(target, "debug/uterm.exe"), join(root, "new-built.exe"));
    copyFileSync(config, join(output, `overlay-${appVersion}.json`));
  }
  command(
    process.execPath,
    [cli, "signer", "sign", "-f", key, "-p", "", "--app-version", "0.2.5", packages[1]],
    { secret: true, env },
  );
  signature = readFileSync(packages[1] + ".sig", "utf8").trim();
  command(
    process.execPath,
    [cli, "signer", "sign", "-f", other, "-p", "", "--app-version", "0.2.5", packages[1]],
    { secret: true, env },
  );
  badSignature = readFileSync(packages[1] + ".sig", "utf8").trim();
  writeFileSync(packages[1] + ".sig", signature);
  payload = readFileSync(packages[1]);
  report.publicTestKey = publicKey;
  report.updateSignature = signature;
  report.packages = packages.map((file) => ({
    file: file.split(/[\\/]/u).at(-1),
    sha256: hash(file),
  }));
  command(packages[0], ["/S", `/D=${install}`], { verbatim: true });
  installed = true;
  const binary = join(install, "uterm.exe");
  assert(existsSync(binary));
  child = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (v) => {
    stdout += v;
  });
  child.stderr.on("data", (v) => {
    stderr += v;
  });
  const deadline = Date.now() + 12 * 60000;
  const seen = new Set();
  while (Date.now() < deadline && !seen.has("updates-complete.json")) {
    const directory = join(root, "evidence");
    for (const name of existsSync(directory)
      ? readdirSync(directory).filter((name) => name.endsWith(".json") && !seen.has(name))
      : []) {
      const value = JSON.parse(readFileSync(join(directory, name), "utf8"));
      seen.add(name);
      assert.equal(value.context.head, head);
      assert.equal(value.context.tested, tested);
      assert.equal(value.context.identifier, identity);
      assert.equal(value.context.sourceTreeDirty, "false");
      copyFileSync(join(directory, name), join(output, name));
      assert(!name.includes("failure"), JSON.stringify(value.checks));
      if (name === "updates-installed-relaunched.json")
        report.actualInstallOrRelaunchExecuted = true;
      const pid =
        name === "updates-installed-relaunched.json" || name === "updates-complete.json"
          ? JSON.parse(readFileSync(join(root, "updates-current-pid"), "utf8"))
          : child.pid;
      const png = join(output, name.replace(/\.json$/u, ".png"));
      command(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          "scripts/windows-window-capture.ps1",
          "-TargetProcessId",
          String(pid),
          "-Destination",
          png,
        ],
        { timeout: 60000 },
      );
      assert(readFileSync(png).length > 1000);
      scenes.push({
        name,
        report: name,
        screenshot: png.split(/[\\/]/u).at(-1),
        checks: value.checks,
      });
      writeFileSync(join(directory, name.replace(/\.json$/u, ".ack")), "");
    }
    await pause(100);
  }
  assert(
    seen.has("updates-complete.json"),
    "Updater suite did not complete signed install/relaunch",
  );
  for (const required of [
    "transfer-protected",
    "database-query-protected",
    "database-transaction-protected",
  ])
    assert(seen.has(`updates-${required}.json`), `Missing actual updater guard scene: ${required}`);
  const relaunchedPID = Number(readFileSync(join(root, "updates-current-pid"), "utf8"));
  let running = true;
  for (let attempt = 0; attempt < 200 && running; attempt++) {
    try {
      process.kill(relaunchedPID, 0);
      await pause(100);
    } catch {
      running = false;
    }
  }
  assert(!running, "Updated application did not complete ordinary exit");
  report.actualInstallOrRelaunchExecuted = true;
  report.installedBinary = JSON.parse(
    command("python", [
      "-B",
      "scripts/windows-candidate-identity.py",
      join(root, "new-built.exe"),
      binary,
    ]),
  );
  assert(report.installedBinary.binaryMatchesExpectedNSIS);
  assert(!requests.some((v) => v.beforeDriver || v.beforeOptIn));
  assert(
    requests.some((v) => v.query.includes("interrupted") && v.range),
    "Interrupted download did not exercise actual Range resume",
  );
  report.passed = true;
  writeFileSync(join(output, "stdout.log"), stdout);
  writeFileSync(join(output, "stderr.log"), stderr);
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  await new Promise((done) => server.close(done));
  const cleanup = [];
  try {
    if (existsSync(join(root, "updates-current-pid"))) {
      const pid = Number(readFileSync(join(root, "updates-current-pid"), "utf8"));
      assert(Number.isSafeInteger(pid) && pid > 0);
      try {
        process.kill(pid);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    if (child && child.exitCode === null) child.kill();
    const binary = join(install, "uterm.exe");
    if (existsSync(binary)) command(binary, ["--qa-cleanup"], { env });
    if (installed) {
      const uninstallers = readdirSync(install).filter((v) => /uninstall.*\.exe$/iu.test(v));
      assert.equal(uninstallers.length, 1);
      command(join(install, uninstallers[0]), ["/S"]);
      for (let attempt = 0; attempt < 600 && existsSync(install); attempt++) await pause(100);
      assert(!existsSync(install), "QA installer survived uninstall");
      assert(
        existsSync(join(root, "data/shared-state-v1/snapshot-v1.json")),
        "Uninstall removed private data",
      );
    }
  } catch (error) {
    cleanup.push(String(error));
  }
  for (const link of links) {
    try {
      unlinkSync(link);
    } catch (error) {
      cleanup.push(String(error));
    }
  }
  if (!cleanup.length) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (error) {
      cleanup.push(String(error));
    }
  }
  writeFileSync(join(output, "stdout.log"), stdout);
  writeFileSync(join(output, "stderr.log"), stderr);
  report.cleanupErrors = cleanup;
  if (cleanup.length) report.passed = false;
  writeFileSync(join(output, "http-requests.json"), JSON.stringify(requests, null, 2));
  writeFileSync(join(output, "sdk-summary.json"), JSON.stringify(report, null, 2));
  if (cleanup.length) throw Error(cleanup.join("; "));
}
