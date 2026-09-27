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
  if (target.startsWith("darwin")) {
    const dmgs = files(bundle).filter((path) => path.endsWith(".dmg"));
    if (dmgs.length !== 1) throw new Error("Expected one DMG installer.");
    copyFileSync(dmgs[0], join(output, `uTerm-${version}-${target}.dmg`));
  }
  writeFileSync(
    join(output, `${target}.json`),
    JSON.stringify({ version, target, filename, signature, sha256: sha256(source) }, null, 2),
  );
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
  }
  return {
    version,
    notes: process.env.DESKTOP_RELEASE_NOTES || releaseNotes(tag),
    pub_date: new Date().toISOString(),
    platforms,
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
      "Usage: release.mjs configure TAG CONFIG | collect TAG TARGET BUNDLE OUTPUT | manifest TAG OUTPUT [PREVIOUS|-] [TARGET] | verify TAG OUTPUT [TARGET]",
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
