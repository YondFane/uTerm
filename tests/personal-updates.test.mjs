import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  personalAppcast,
  personalConfiguration,
  personalFeed,
  signPersonalArchive,
  externalKeyDirectory,
} from "../scripts/personal-updates.mjs";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey
      .export({ type: "pkcs8", format: "der" })
      .subarray(-32)
      .toString("base64"),
    publicKey: pair.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64"),
  };
}

test("external key directories support Windows drives while rejecting checkout descendants", () => {
  const checkout = String.raw`D:\a\uTerm\uTerm`;
  assert.equal(externalKeyDirectory(checkout, String.raw`C:\Users\runner\Temp\keys`, win32), true);
  assert.equal(externalKeyDirectory(checkout, String.raw`D:\a\_temp\keys`, win32), true);
  assert.equal(externalKeyDirectory(checkout, String.raw`d:\a\uterm\uterm\keys`, win32), false);
  assert.equal(externalKeyDirectory(checkout, checkout, win32), false);
  assert.equal(externalKeyDirectory("/workspace/uTerm", "/tmp/keys", posix), true);
  assert.equal(externalKeyDirectory("/workspace/uTerm", "/workspace/uTerm/keys", posix), false);
});

test("personal updater signatures bind archive bytes and the embedded public key", () => {
  const key = keys();
  const archive = Buffer.from("signed ZIP fixture 中文");
  const signature = signPersonalArchive(archive, key.privateKey, key.publicKey);
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(key.publicKey, "base64"),
    ]),
    type: "spki",
    format: "der",
  });
  assert.ok(verify(null, archive, publicKey, Buffer.from(signature, "base64")));
  assert.equal(
    verify(
      null,
      Buffer.concat([archive, Buffer.from("tampered")]),
      publicKey,
      Buffer.from(signature, "base64"),
    ),
    false,
  );
  assert.throws(
    () => signPersonalArchive(archive, key.privateKey, keys().publicKey),
    /keys differ/,
  );
  for (const value of [
    "",
    "secret-file",
    Buffer.alloc(64).toString("base64"),
    key.privateKey + "!",
  ])
    assert.throws(() => signPersonalArchive(archive, value, key.publicKey), /32 bytes/);
});

test("personal feeds keep architectures and clients separate and require valid release identities", () => {
  const key = keys();
  for (const architecture of ["arm64", "x86_64"]) {
    const config = personalConfiguration(architecture, key.publicKey, "owner/uTerm");
    assert.equal(
      config.UTermUpdateFeedURL,
      `https://github.com/owner/uTerm/releases/download/uTerm-updates/personal-stable-${architecture}.xml`,
    );
    assert.equal(config.SUAllowsAutomaticUpdates, true);
    const archive = Buffer.from("archive");
    const feed = personalAppcast({
      version: "1.2.3",
      architecture,
      archive,
      signature: signPersonalArchive(archive, key.privateKey, key.publicKey),
      repository: "owner/uTerm",
    });
    assert.ok(feed.includes(`<uterm:architecture>${architecture}</uterm:architecture>`));
    assert.ok(
      feed.includes(
        `uTerm-1.2.3-personal-darwin-${architecture === "arm64" ? "aarch64" : "x86_64"}.zip`,
      ),
    );
    assert.ok(feed.includes('sparkle:version="1.2.3"'));
    assert.ok(!feed.includes(key.privateKey));
  }
  assert.equal(personalConfiguration("arm64", "", "owner/uTerm").UTermUpdateMode, "manual");
  for (const value of ["not-base64", Buffer.alloc(31).toString("base64"), key.publicKey + "!"])
    assert.throws(() => personalConfiguration("arm64", value, "owner/uTerm"), /public key/);
  for (const repository of ["", "../repo", "owner/repo/other", "owner/repo?query"])
    assert.throws(() => personalFeed("arm64", repository));
  assert.throws(() => personalFeed("universal", "owner/uTerm"));
});

test("key generation refuses overwrite and keeps private material out of stdout", () => {
  const root = mkdtempSync(join(tmpdir(), "uterm-personal-keys-"));
  const directory = join(root, "keys");
  const script = fileURLToPath(new URL("../scripts/personal-updates.mjs", import.meta.url));
  try {
    const out = execFileSync(process.execPath, [script, "keygen", directory], { encoding: "utf8" });
    const privateKey = readFileSync(join(directory, "private-key.txt"), "utf8").trim();
    const publicKey = readFileSync(join(directory, "public-key.txt"), "utf8").trim();
    assert.ok(!out.includes(privateKey));
    signPersonalArchive(Buffer.from("check"), privateKey, publicKey);
    if (process.platform !== "win32") {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(join(directory, "private-key.txt")).mode & 0o777, 0o600);
    }
    assert.throws(() =>
      execFileSync(process.execPath, [script, "keygen", directory], { stdio: "pipe" }),
    );
    assert.equal(readFileSync(join(directory, "private-key.txt"), "utf8").trim(), privateKey);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
