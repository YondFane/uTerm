import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  collect,
  manifest,
  feedFilename,
  releaseBase,
  releaseConfig,
  releaseVersion,
} from "./release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const platforms = {
  darwin: {
    bundles: ["app", "dmg"],
    targets: ["aarch64-apple-darwin", "x86_64-apple-darwin", "universal-apple-darwin"],
  },
  win32: {
    bundles: ["nsis", "msi"],
    targets: ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc", "i686-pc-windows-msvc"],
  },
};
const help = `Usage: pnpm package [options]

Build installers on the current OS (macOS: app + dmg; Windows: nsis + msi).
Install dependencies first: pnpm install --frozen-lockfile

  --release TAG       Enable online updates (uTerm-vMAJOR.MINOR.PATCH)
  --repository REPO   Public GitHub owner/repository for updates
  --key-path PATH     Updater private key (default: ~/.tauri/uterm.key; .pub alongside)
  --debug             Build a debug package instead of release
  --bundles LIST      Comma-separated formats for the current OS
  --target TRIPLE     Same-OS Rust target, or universal-apple-darwin
  --no-sign           Skip signing (local testing only)
  --dry-run           Print the build plan without running tools
  --help              Show this help

Requires Rust and platform build tools. Windows packages must be built on Windows.
Linux packaging is not configured. Signing uses Tauri's existing configuration
and environment variables. No certificates are installed by this script.
`;

export function packagingPlan(arguments_, platform = process.platform, arch = process.arch) {
  const configuration = platforms[platform];
  if (!configuration)
    throw new Error(`Packaging is not configured for ${platform}. Use macOS or Windows.`);
  let bundles = configuration.bundles;
  let explicitBundles = false;
  let release;
  let repository = process.env.GITHUB_REPOSITORY;
  let keyPath;
  let target;
  let debug = false;
  let noSign = false;
  let dryRun = false;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--debug") debug = true;
    else if (argument === "--no-sign") noSign = true;
    else if (argument === "--dry-run") dryRun = true;
    else if (
      ["--bundles", "--target", "--release", "--repository", "--key-path"].includes(argument)
    ) {
      const value = arguments_[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      if (argument === "--bundles") {
        bundles = [...new Set(value.split(","))];
        explicitBundles = true;
      } else if (argument === "--target") target = value;
      else if (argument === "--release") release = value;
      else if (argument === "--repository") repository = value;
      else keyPath = value;
    } else throw new Error(`Unknown option: ${argument}. Use --help.`);
  }
  if (bundles.some((bundle) => !configuration.bundles.includes(bundle))) {
    throw new Error(`Supported bundles on ${platform}: ${configuration.bundles.join(",")}.`);
  }
  if (target && !configuration.targets.includes(target)) {
    throw new Error(`Supported targets on ${platform}: ${configuration.targets.join(",")}.`);
  }
  let releasePlan;
  if (release) {
    releaseVersion(release);
    releaseBase(repository);
    if (debug || noSign || explicitBundles)
      throw new Error("--release cannot be combined with --debug, --no-sign, or --bundles.");
    target ??=
      platform === "win32"
        ? arch === "x64"
          ? "x86_64-pc-windows-msvc"
          : undefined
        : arch === "arm64"
          ? "aarch64-apple-darwin"
          : arch === "x64"
            ? "x86_64-apple-darwin"
            : undefined;
    const updateTargets = {
      "x86_64-pc-windows-msvc": "windows-x86_64",
      "aarch64-apple-darwin": "darwin-aarch64",
      "x86_64-apple-darwin": "darwin-x86_64",
    };
    if (!updateTargets[target])
      throw new Error("Online updates support Windows x64 and macOS arm64/x64 only.");
    bundles = platform === "win32" ? ["nsis"] : ["app", "dmg"];
    releasePlan = {
      tag: release,
      repository,
      keyPath,
      target,
      updateTarget: updateTargets[target],
    };
  } else if (keyPath || arguments_.includes("--repository")) {
    throw new Error("--key-path and --repository require --release.");
  }
  const args = ["build", "--ci", "--bundles", bundles.join(",")];
  if (debug) args.push("--debug");
  if (target) args.push("--target", target);
  if (noSign) args.push("--no-sign");
  args.push("--", "--locked");
  return { args, dryRun, ...(releasePlan ? { release: releasePlan } : {}) };
}

function run(command, args, env = process.env) {
  // Invoke executables directly so Windows paths never pass through cmd quoting.
  // 直接调用程序，避免 Windows 路径经过 cmd 字符串转义。
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false, env });
  if (result.error) throw new Error(`Couldn't run ${command}: ${result.error.message}`);
  if (result.signal) throw new Error(`${command} stopped by ${result.signal}.`);
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}.`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(help);
    return;
  }
  const plan = packagingPlan(args);
  console.log(`Working directory: ${root}`);
  console.log(`Tauri arguments: ${JSON.stringify(plan.args)}`);
  if (plan.release)
    console.log(
      `Online updates: ${plan.release.repository}, ${plan.release.tag}, ${plan.release.updateTarget}`,
    );
  if (plan.dryRun) return;
  const require = createRequire(import.meta.url);
  let cli;
  try {
    cli = resolve(dirname(require.resolve("@tauri-apps/cli/package.json")), "tauri.js");
  } catch {
    throw new Error(
      "Tauri CLI is missing. Run pnpm install --frozen-lockfile in the uTerm repository root first.",
    );
  }
  run("cargo", ["--version"]);
  run(process.execPath, [fileURLToPath(new URL("./docs-index.mjs", import.meta.url)), "--check"]);
  if (plan.release) {
    const { tag, repository, keyPath, target, updateTarget } = plan.release;
    const output = join(root, "releases", tag, updateTarget);
    if (existsSync(output))
      throw new Error(
        `Release output already exists: ${output}. Use a new version or move the old output aside.`,
      );
    const key = resolve(keyPath ?? join(homedir(), ".tauri", "uterm.key"));
    const privateKey = readFileSync(key, "utf8").trim();
    if (!privateKey) throw new Error("Updater private key is empty.");
    const publicKey = readFileSync(`${key}.pub`, "utf8");
    process.env.GITHUB_REPOSITORY = repository;
    const config = releaseConfig(
      tag,
      publicKey,
      process.platform,
      process.env.WINDOWS_CERTIFICATE_THUMBPRINT,
    );
    const temporary = mkdtempSync(join(tmpdir(), "uterm-release-"));
    try {
      const path = join(temporary, "release.json");
      writeFileSync(path, JSON.stringify(config));
      const separator = plan.args.indexOf("--");
      const buildArgs = [
        ...plan.args.slice(0, separator),
        "--config",
        path,
        ...plan.args.slice(separator),
      ];
      run(process.execPath, [cli, ...buildArgs], {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY: privateKey,
      });
      collect(
        tag,
        updateTarget,
        join(root, "src-tauri", "target", target, "release", "bundle"),
        output,
      );
      writeFileSync(
        join(output, feedFilename(updateTarget)),
        JSON.stringify(manifest(tag, output, undefined, [updateTarget]), null, 2),
      );
      console.log(`Release artifacts and update manifest: ${output}`);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } else run(process.execPath, [cli, ...plan.args]);
  console.log("Packaging complete. Bundle paths are listed in the Tauri output above.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
