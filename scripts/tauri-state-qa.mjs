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
} from "node:fs";
import { tmpdir, homedir, platform, arch, release, version } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const editorFixture = JSON.parse(
  readFileSync(resolve("shared/fixtures/editor-draft-qa.json"), "utf8"),
);
const gitQA = JSON.parse(readFileSync(resolve("shared/fixtures/git-qa.json"), "utf8"));
const identifier = "sh.uterm.desktop.qa.sharedstate";
const output = resolve("ci-evidence/tauri-state-qa");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "uterm-tauri-qa-"));
mkdirSync(join(root, "project"));
writeFileSync(join(root, "project", editorFixture.fileName), "\ufeff" + editorFixture.originalText);
const evidence = join(root, "evidence");
mkdirSync(evidence);
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
        ? "foreground native window CopyFromScreen"
        : "isolated X11 desktop",
  productionDataAccess: false,
  sourceTreeDirty,
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
let binary;
let successful = false;
try {
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
  const overlay = JSON.stringify({
    identifier,
    productName: "uTerm Shared State QA",
    plugins: { "deep-link": { desktop: { schemes: [] } } },
    app: {
      windows: [
        {
          label: "main",
          title: "uTerm Shared State QA",
          width: 960,
          height: 620,
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
      `import Cocoa\nimport CoreGraphics\nlet pid = Int32(CommandLine.arguments[1])!\nif let app = NSRunningApplication(processIdentifier: pid) { app.activate(options: [.activateIgnoringOtherApps]) }\nThread.sleep(forTimeInterval: 0.3)\nlet windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] ?? []\nlet found = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }.sorted { a,b in\nlet x = a[kCGWindowBounds as String] as? [String:CGFloat] ?? [:]; let y = b[kCGWindowBounds as String] as? [String:CGFloat] ?? [:]\nreturn (x["Width"] ?? 0) * (x["Height"] ?? 0) > (y["Width"] ?? 0) * (y["Height"] ?? 0)\n}\nguard let id = found.first?[kCGWindowNumber as String] as? UInt32 else { exit(2) }\nprint(id)\n`,
    );
    execute("swiftc", [swift, "-o", join(root, "window-id")]);
  }
  if (process.platform === "win32") {
    writeFileSync(
      join(root, "capture.ps1"),
      `param([int]$TargetProcessId,[string]$Destination)\nAdd-Type -AssemblyName System.Drawing\nAdd-Type @'\nusing System; using System.Runtime.InteropServices;\npublic class WindowCapture {\n [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }\n [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);\n [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\n [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);\n}\n'@\n$p = Get-Process -Id $TargetProcessId\n$p.Refresh()\n$handle = $p.MainWindowHandle\nif ($handle -eq [IntPtr]::Zero) { throw 'No native window' }\n[void][WindowCapture]::ShowWindow($handle, 9)\n[void][WindowCapture]::SetForegroundWindow($handle)\nStart-Sleep -Milliseconds 300\n$rect = New-Object WindowCapture+Rect\nif (![WindowCapture]::GetWindowRect($handle,[ref]$rect)) { throw 'GetWindowRect failed' }\n$w=$rect.Right-$rect.Left; $h=$rect.Bottom-$rect.Top\nif ($w -lt 600 -or $h -lt 400) { throw 'Invalid native window dimensions' }\n$image=New-Object System.Drawing.Bitmap($w,$h)\n$g=[System.Drawing.Graphics]::FromImage($image)\ntry { $g.CopyFromScreen($rect.Left,$rect.Top,0,0,$image.Size); $image.Save($Destination,[System.Drawing.Imaging.ImageFormat]::Png) } finally { $g.Dispose(); $image.Dispose() }\n`,
    );
  }
  function capture(path) {
    if (process.platform === "darwin") {
      const id = execute(join(root, "window-id"), [String(child.pid)]).trim();
      execute("/usr/sbin/screencapture", ["-x", "-o", "-l", id, path]);
    } else if (process.platform === "win32") {
      execute("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(root, "capture.ps1"),
        "-TargetProcessId",
        String(child.pid),
        "-Destination",
        path,
      ]);
    } else execute("import", ["-window", "root", path]);
    assert(readFileSync(path).length > 5000, "Screenshot was not captured");
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
    const args = ["--qa-data-root", root, "--qa-phase", phase];
    if (backup) args.push("--qa-backup", backup);
    child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    let closed = false;
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
    child.on("close", (status, signal) => {
      code = status;
      exitSignal = signal;
      closed = true;
    });
    const observed = new Set();
    try {
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        for (const file of readdirSync(evidence).filter(
          (p) => p.startsWith(`${phase}-`) && p.endsWith(".json"),
        )) {
          if (observed.has(file)) continue;
          observed.add(file);
          const value = JSON.parse(readFileSync(join(evidence, file), "utf8"));
          assert.equal(value.context.head, head);
          assert.equal(value.context.tested, tested);
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
          } else if (value.scene === "git-favorite-recovery-ready") {
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
          } else if (value.scene === "editor-imported") {
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
          } else if (value.scene === "editor-write-rejected") {
            assert(writer, "Missing owned writer fixture");
            writer.stdin.end("release\n");
            assert.equal(await writerExited, 0);
            writerEvents.push({ state: "released-after-rejection", pid: writer.pid });
            writer = undefined;
            writeFileSync(
              join(output, "editor-writer-lock.json"),
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
        if (closed) {
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
      assert(closed, `${phase} did not quit through the ordinary exit guard`);
      const expected =
        phase === "git"
          ? 13
          : phase === "editor-checkpoint"
            ? 3
            : phase.startsWith("editor-")
              ? 2
              : phase === "initial"
                ? 8
                : phase === "reopen"
                  ? 1
                  : 3;
      assert.equal(observed.size, expected, `${phase} omitted required scenes`);
    } finally {
      if (writer) {
        writer.stdin.end("release\n");
        writer.kill();
        await writerExited;
      }
      writeFileSync(join(output, `${phase}.log`), log);
    }
  }
  await run("editor-checkpoint");
  await run("editor-reopen");
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
  successful = true;
} finally {
  const cleanupErrors = [];
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
  for (const link of profileLinks.reverse()) {
    try {
      assert(lstatSync(link).isSymbolicLink(), "QA refuses to remove a replaced profile link");
      unlinkSync(link);
    } catch (error) {
      if (error.code !== "ENOENT") cleanupErrors.push(String(error));
    }
  }
  // Keep failure fixtures only in the isolated temporary profile for diagnosis.
  // 失败测试数据仅保留在隔离临时配置中供诊断。
  if (successful && !cleanupErrors.length) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  }
  successful &&= cleanupErrors.length === 0;
  writeFileSync(
    join(output, "report.json"),
    JSON.stringify({ passed: successful, ...metadata, scenes, cleanupErrors }, null, 2),
  );
  if (!successful) process.exitCode = 1;
}
