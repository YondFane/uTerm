import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTauri } from "../scripts/tauri-build.mjs";

const download =
  "Downloading https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip";
const failure = "\u001b[31mError failed to bundle project: `http status: 504`\u001b[0m";

async function exercise(results) {
  const root = mkdtempSync(join(tmpdir(), "uterm-build-retry "));
  const cli = join(root, "fake cli.mjs");
  const state = join(root, "calls.json");
  writeFileSync(
    cli,
    `
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    const path = ${JSON.stringify(state)};
    const calls = existsSync(path) ? JSON.parse(readFileSync(path)) : [];
    const results = ${JSON.stringify(results)};
    const result = results[Math.min(calls.length, results.length - 1)];
    calls.push(process.argv.slice(2));
    writeFileSync(path, JSON.stringify(calls));
    console.error(result.log);
    process.exitCode = result.code;
  `,
  );
  const args = ["--bundles", "nsis", "--config", "literal $() & 中文 path.json", "--", "--locked"];
  const delays = [];
  const output = [];
  try {
    const code = await buildTauri(args, {
      cli,
      delay: async (ms) => delays.push(ms),
      output: (stream, text) => output.push({ stream, text }),
    });
    const calls = JSON.parse(readFileSync(state));
    for (const call of calls) assert.deepEqual(call, ["build", ...args]);
    return { code, calls, delays, output };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("NSIS gateway failure retries and preserves literal CLI arguments and output", async () => {
  const result = await exercise([
    { code: 1, log: download + "\n" + failure },
    { code: 0, log: "Signed package ready" },
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.delays, [5000]);
  assert.ok(result.output.some(({ text }) => text.includes("http status: 504")));
  assert.ok(result.output.some(({ text }) => text.includes("Signed package ready")));
});

test("repeated NSIS gateway failures stop after three attempts with the actual failure", async () => {
  const result = await exercise([{ code: 7, log: download + "\n" + failure }]);
  assert.equal(result.code, 7);
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.delays, [5000, 5000]);
});

test("compiler, signing, permanent HTTP and unrelated download failures do not retry", async () => {
  for (const log of [
    download + "\nerror: compiler failed",
    download + "\nError failed to bundle project: invalid signing key",
    download + "\nError failed to bundle project: `http status: 404`",
    download + "\nDownloading https://example.invalid/unrelated.zip\n" + failure,
    download + "\n" + failure + "\nError invalid signing key",
    failure,
  ]) {
    const result = await exercise([{ code: 2, log }]);
    assert.equal(result.code, 2);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.delays, []);
  }
});
