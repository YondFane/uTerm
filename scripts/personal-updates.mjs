import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import paths, { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function publicKeyBytes(value) {
  const text = (value ?? "").trim();
  const bytes = Buffer.from(text, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== text)
    throw new Error("PERSONAL_UPDATER_PUBLIC_KEY must be a base64 Ed25519 public key (32 bytes).");
  return bytes;
}

function repositoryName(repository) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ""))
    throw new Error("Expected the public GitHub owner/repository for personal updates.");
  return repository;
}

export function personalFeed(architecture, repository = process.env.GITHUB_REPOSITORY) {
  if (!["arm64", "x86_64"].includes(architecture))
    throw new Error("Unsupported personal macOS architecture.");
  return `https://github.com/${repositoryName(repository)}/releases/download/uTerm-updates/personal-stable-${architecture}.xml`;
}

export function personalConfiguration(architecture, publicKey, repository) {
  if (!publicKey?.trim()) return { UTermUpdateMode: "manual", SUAllowsAutomaticUpdates: false };
  publicKeyBytes(publicKey);
  return {
    UTermUpdateMode: "automatic",
    UTermUpdateFeedURL: personalFeed(architecture, repository),
    UTermUpdateChannel: "stable",
    SUPublicEDKey: publicKey.trim(),
    SUAllowsAutomaticUpdates: true,
    SUVerifyUpdateBeforeExtraction: true,
  };
}

export function signPersonalArchive(archive, privateKey, publicKey) {
  const seed = Buffer.from((privateKey ?? "").trim(), "base64");
  if (seed.length !== 32 || seed.toString("base64") !== (privateKey ?? "").trim())
    throw new Error("PERSONAL_UPDATER_PRIVATE_KEY must be a base64 Ed25519 seed (32 bytes).");
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const expected = publicKeyBytes(publicKey);
  const actual = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  if (!actual.equals(expected)) throw new Error("Personal updater private and public keys differ.");
  const signature = sign(null, archive, key);
  if (!verify(null, archive, createPublicKey(key), signature))
    throw new Error("Personal update signature verification failed.");
  return signature.toString("base64");
}

const xml = (text) =>
  String(text).replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c],
  );

export function externalKeyDirectory(checkout, directory, path = paths) {
  const traversal = path.relative(checkout, directory);
  return path.isAbsolute(traversal) || traversal === ".." || traversal.startsWith(`..${path.sep}`);
}

export function personalAppcast({ version, architecture, archive, signature, repository }) {
  personalFeed(architecture, repository);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Personal updates require a stable semantic version.");
  if (Buffer.from(signature, "base64").length !== 64 || !archive.length)
    throw new Error("Missing personal archive or Ed25519 signature.");
  const target = architecture === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
  const url = `https://github.com/${repository}/releases/download/uTerm-v${version}/uTerm-${version}-personal-${target}.zip`;
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:uterm="https://uterm.invalid/test-updates">
  <channel>
    <title>uTerm Personal</title>
    <item>
      <title>uTerm Personal ${xml(version)}</title>
      <sparkle:channel>stable</sparkle:channel>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <uterm:platform>macos</uterm:platform>
      <uterm:architecture>${architecture}</uterm:architecture>
      <enclosure url="${xml(url)}" sparkle:version="${xml(version)}" sparkle:shortVersionString="${xml(version)}" sparkle:edSignature="${xml(signature)}" length="${archive.length}" type="application/octet-stream"/>
    </item>
  </channel>
</rss>
`;
}

function main() {
  const [command, argument, output] = process.argv.slice(2);
  if (command === "keygen") {
    const directory = resolve(argument ?? "");
    if (!argument)
      throw new Error("Specify a new directory outside the checkout for updater keys.");
    if (!externalKeyDirectory(fileURLToPath(new URL("../", import.meta.url)), directory))
      throw new Error("Updater keys must be generated outside the checkout.");
    mkdirSync(directory, { mode: 0o700 });
    const pair = generateKeyPairSync("ed25519");
    const seed = pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
    const pub = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    writeFileSync(join(directory, "private-key.txt"), seed.toString("base64") + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    writeFileSync(join(directory, "public-key.txt"), pub.toString("base64") + "\n", {
      mode: 0o644,
      flag: "wx",
    });
    console.log(
      "Created private-key.txt and public-key.txt. Back up the private key securely; never commit it.",
    );
  } else if (command === "config") {
    console.log(
      JSON.stringify(
        personalConfiguration(
          argument,
          process.env.PERSONAL_UPDATER_PUBLIC_KEY,
          process.env.GITHUB_REPOSITORY ?? "YondFane/uTerm",
        ),
      ),
    );
  } else if (command === "sign") {
    const signature = signPersonalArchive(
      readFileSync(argument),
      readFileSync(output, "utf8"),
      process.env.PERSONAL_UPDATER_PUBLIC_KEY,
    );
    console.log(signature);
  } else
    throw new Error(
      "Usage: personal-updates.mjs keygen NEW_DIRECTORY | config ARCH | sign ARCHIVE PRIVATE_KEY_FILE",
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
