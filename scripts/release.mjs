import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  personalAppcast,
  personalFeed,
  publicKeyBytes,
  signPersonalArchive,
} from "./personal-updates.mjs";

export function releaseBase(repository = process.env.GITHUB_REPOSITORY) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ""))
    throw new Error("GITHUB_REPOSITORY must name the public owner/repository hosting releases.");
  return `https://github.com/${repository}/releases/download`;
}
export const targets = ["windows-x86_64"];
export const supportedTargets = ["windows-x86_64", "darwin-aarch64", "darwin-x86_64"];
export function feedFilename(target) {
  if (!supportedTargets.includes(target)) throw new Error(`Unsupported release target: ${target}`);
  return target === "windows-x86_64" ? "latest.json" : `latest-${target}.json`;
}
export function releaseVersion(tag) {
  const match = /^uTerm-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag);
  if (!match || match[1].split(".").some((part) => Number(part) > 65535))
    throw new Error("Expected a stable uTerm-vMAJOR.MINOR.PATCH tag (components <= 65535).");
  return match[1];
}
export function releaseNotes(tag, directory = new URL("../release-notes/", import.meta.url)) {
  const version = releaseVersion(tag);
  const file = new URL(`${tag}.md`, directory);
  const notes = existsSync(file)
    ? readFileSync(file, "utf8").trim()
    : `## 中文\n\nuTerm ${version} 发布。\n\n## English\n\nuTerm ${version} release.`;
  // Release pages must be useful to both supported uTerm languages.
  // 发版页面必须同时服务 uTerm 支持的两种语言。
  if (!notes.includes("## 中文") || !notes.includes("## English"))
    throw new Error(`Release notes for ${tag} must include ## 中文 and ## English.`);
  return notes;
}
export function releaseConfig(tag, publicKey, platform, thumbprint) {
  const decoded = Buffer.from(publicKey ?? "", "base64")
    .toString("utf8")
    .trim()
    .split(/\r?\n/);
  if (
    !decoded[0]?.startsWith("untrusted comment:") ||
    Buffer.from(decoded[1] ?? "", "base64").length !== 42
  )
    throw new Error("DESKTOP_UPDATER_PUBLIC_KEY must contain a Tauri public key, not a path.");
  if (platform === "win32" && thumbprint && !/^[A-Fa-f0-9]{40}$/.test(thumbprint ?? ""))
    throw new Error("Invalid Windows code-signing certificate thumbprint.");
  return {
    version: releaseVersion(tag),
    identifier: "sh.uterm.desktop",
    bundle: {
      createUpdaterArtifacts: true,
      ...(platform === "darwin" ? { macOS: { signingIdentity: "-" } } : {}),
      ...(platform === "win32" && thumbprint
        ? {
            windows: {
              certificateThumbprint: thumbprint,
              digestAlgorithm: "sha256",
              timestampUrl: "http://timestamp.digicert.com",
            },
          }
        : {}),
    },
    plugins: {
      updater: {
        pubkey: publicKey.trim(),
        endpoints: [
          `${releaseBase()}/uTerm-updates/${platform === "darwin" ? "latest-darwin-{{arch}}.json" : "latest.json"}`,
        ],
        windows: { installMode: "passive" },
      },
    },
  };
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export function collect(tag, target, bundle, output) {
  const version = releaseVersion(tag);
  if (!supportedTargets.includes(target)) throw new Error(`Unsupported release target: ${target}`);
  const extension = target.startsWith("darwin") ? ".app.tar.gz" : "-setup.exe";
  const matches = files(bundle).filter((path) => path.endsWith(extension));
  if (matches.length !== 1)
    throw new Error(`Expected one ${extension} updater bundle, found ${matches.length}.`);
  const source = matches[0];
  const signature = readFileSync(`${source}.sig`, "utf8").trim();
  if (!Buffer.from(signature, "base64").toString("utf8").startsWith("untrusted comment:"))
    throw new Error("Missing or malformed updater signature.");
  mkdirSync(output, { recursive: true });
  const filename = `uTerm-${version}-${target}${extension}`;
  copyFileSync(source, join(output, filename));
  copyFileSync(`${source}.sig`, join(output, `${filename}.sig`));
  let installer = { filename, sha256: sha256(source), size: readFileSync(source).length };
  if (target.startsWith("darwin")) {
    const dmgs = files(bundle).filter((path) => path.endsWith(".dmg"));
    if (dmgs.length !== 1) throw new Error("Expected one DMG installer.");
    copyFileSync(dmgs[0], join(output, `uTerm-${version}-${target}.dmg`));
    installer = {
      filename: `uTerm-${version}-${target}.dmg`,
      sha256: sha256(dmgs[0]),
      size: readFileSync(dmgs[0]).length,
    };
  }
  writeFileSync(
    join(output, `${target}.json`),
    JSON.stringify(
      { version, target, filename, signature, sha256: sha256(source), installer },
      null,
      2,
    ),
  );
}
export function collectPersonal(tag, sourceSHA, directory, output, publicKey) {
  const version = releaseVersion(tag);
  if (!/^[a-f0-9]{40}$/.test(sourceSHA))
    throw new Error("Personal packages require the exact release commit.");
  const reports = files(directory).filter((path) => basename(path) === "personal-package.json");
  if (reports.length !== 2) throw new Error("Expected two personal package reports.");
  const seen = new Set();
  const packages = [];
  for (const file of reports) {
    const report = JSON.parse(readFileSync(file, "utf8"));
    const target = { arm64: "darwin-aarch64", x86_64: "darwin-x86_64" }[report.architecture];
    if (
      !target ||
      seen.has(target) ||
      !report.passed ||
      report.sourceTreeDirty !== false ||
      report.sourceHeadSHA !== sourceSHA ||
      report.testedMergeSHA !== sourceSHA ||
      report.version !== version ||
      report.bundleIdentifier !== "sh.uterm.desktop.personal" ||
      report.buildConfiguration !== "release" ||
      (publicKey
        ? report.updateMode !== "automatic" || report.manualUpdates !== false
        : report.manualUpdates !== true) ||
      !report.smoke?.realWindow ||
      !report.smoke?.manualAppReplacement ||
      report.smoke.productionDataAccess !== false
    )
      throw new Error(
        "Personal package evidence does not match the release commit, version or actual installation.",
      );
    seen.add(target);
    if (publicKey) {
      publicKeyBytes(publicKey);
      if (
        report.updatePublicKey !== publicKey.trim() ||
        report.updateFeed !== personalFeed(report.architecture)
      )
        throw new Error("Personal package has a different updater public key or feed.");
    }
    const entries = Object.entries(report.packages ?? {});
    if (entries.length !== 2) throw new Error("Expected a personal DMG and ZIP.");
    const extensions = new Set();
    for (const [name, hash] of entries) {
      const extension = name.endsWith(".dmg") ? ".dmg" : name.endsWith(".zip") ? ".zip" : null;
      const source = join(resolve(file, ".."), name);
      if (
        !extension ||
        extensions.has(extension) ||
        basename(name) !== name ||
        !name.startsWith(
          `uTerm-Personal-${version}-macos-${report.architecture}-${sourceSHA.slice(0, 8)}`,
        ) ||
        !/^[a-f0-9]{64}$/.test(hash) ||
        sha256(source) !== hash
      )
        throw new Error("Personal archive name or checksum does not match its report.");
      extensions.add(extension);
      packages.push({
        source,
        filename: `uTerm-${version}-personal-${target}${extension}`,
        sha256: hash,
      });
    }
  }
  mkdirSync(output, { recursive: true });
  for (const item of packages) copyFileSync(item.source, join(output, item.filename));
  writeFileSync(
    join(output, `uTerm-${version}-personal-SHA256SUMS.txt`),
    packages.map((item) => `${item.sha256}  ${item.filename}\n`).join(""),
  );
  return packages;
}
export function writePersonalFeeds(tag, sourceSHA, directory, output, privateKey, publicKey) {
  publicKeyBytes(publicKey);
  collectPersonal(tag, sourceSHA, directory, output, publicKey);
  const version = releaseVersion(tag);
  for (const architecture of ["arm64", "x86_64"]) {
    const target = architecture === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
    const archive = readFileSync(join(output, `uTerm-${version}-personal-${target}.zip`));
    const signature = signPersonalArchive(archive, privateKey, publicKey);
    writeFileSync(
      join(output, `personal-stable-${architecture}.xml`),
      personalAppcast({
        version,
        architecture,
        archive,
        signature,
        repository: process.env.GITHUB_REPOSITORY,
      }),
    );
  }
}
export function manifest(tag, directory, previous, selectedTargets = targets) {
  if (
    !selectedTargets.length ||
    selectedTargets.some((target) => !supportedTargets.includes(target))
  )
    throw new Error("Select supported release targets.");
  const version = releaseVersion(tag);
  if (previous) {
    const old = releaseVersion(`uTerm-v${previous.version}`).split(".").map(Number);
    const next = version.split(".").map(Number);
    const index = next.findIndex((value, i) => value !== old[i]);
    if (index === -1 || next[index] < old[index])
      throw new Error("The stable feed must advance to a newer version.");
  }
  const platforms = {};
  const installers = {};
  for (const target of selectedTargets) {
    const entry = JSON.parse(readFileSync(join(directory, `${target}.json`), "utf8"));
    if (
      entry.version !== version ||
      entry.target !== target ||
      basename(entry.filename) !== entry.filename
    )
      throw new Error(`Invalid release descriptor: ${target}`);
    const path = join(directory, entry.filename);
    if (
      entry.sha256 !== sha256(path) ||
      entry.signature !== readFileSync(`${path}.sig`, "utf8").trim()
    )
      throw new Error(`Release artifact changed: ${target}`);
    platforms[target] = {
      url: `${releaseBase()}/${tag}/${entry.filename}`,
      signature: entry.signature,
    };
    const installer = entry.installer;
    if (
      !installer ||
      basename(installer.filename) !== installer.filename ||
      !Number.isSafeInteger(installer.size) ||
      installer.size <= 0 ||
      readFileSync(join(directory, installer.filename)).length !== installer.size ||
      sha256(join(directory, installer.filename)) !== installer.sha256
    )
      throw new Error(`Installer changed: ${target}`);
    installers[target] = { ...installer, url: `${releaseBase()}/${tag}/${installer.filename}` };
  }
  return {
    version,
    notes: process.env.DESKTOP_RELEASE_NOTES || releaseNotes(tag),
    pub_date: new Date().toISOString(),
    platforms,
    installers,
  };
}
async function main() {
  const [command, tag, first, second, third] = process.argv.slice(2);
  if (command === "configure") {
    writeFileSync(
      first,
      JSON.stringify(
        releaseConfig(
          tag,
          process.env.DESKTOP_UPDATER_PUBLIC_KEY,
          process.platform,
          process.env.WINDOWS_CERTIFICATE_THUMBPRINT,
        ),
        null,
        2,
      ),
    );
  } else if (command === "collect") collect(tag, first, second, third);
  else if (command === "collect-personal")
    collectPersonal(tag, first, second, third, process.env.PERSONAL_UPDATER_PUBLIC_KEY);
  else if (command === "personal-feeds")
    writePersonalFeeds(
      tag,
      first,
      second,
      third,
      process.env.PERSONAL_UPDATER_PRIVATE_KEY,
      process.env.PERSONAL_UPDATER_PUBLIC_KEY,
    );
  else if (command === "manifest") {
    const previous =
      second && second !== "-" ? JSON.parse(readFileSync(second, "utf8")) : undefined;
    const selectedTargets = third ? [third] : targets;
    writeFileSync(
      join(first, feedFilename(selectedTargets[0])),
      JSON.stringify(manifest(tag, first, previous, selectedTargets), null, 2),
    );
  } else if (command === "verify") {
    const selectedTargets = second ? [second] : targets;
    const value = manifest(tag, first, undefined, selectedTargets);
    for (const target of selectedTargets) {
      const entry = JSON.parse(readFileSync(join(first, `${target}.json`), "utf8"));
      for (const name of [
        entry.filename,
        `${entry.filename}.sig`,
        ...(target.startsWith("darwin") ? [`uTerm-${value.version}-${target}.dmg`] : []),
      ]) {
        const response = await fetch(`${releaseBase()}/${tag}/${name}`, {
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error(`Public download failed: ${name} (${response.status})`);
        const hash = createHash("sha256");
        for await (const chunk of response.body) hash.update(chunk);
        if (hash.digest("hex") !== sha256(join(first, name)))
          throw new Error(`Public download differs: ${name}`);
      }
    }
  } else
    throw new Error(
      "Usage: release.mjs configure TAG CONFIG | collect TAG TARGET BUNDLE OUTPUT | collect-personal TAG SOURCE_SHA INPUT OUTPUT | manifest TAG OUTPUT [PREVIOUS|-] [TARGET] | verify TAG OUTPUT [TARGET]",
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
