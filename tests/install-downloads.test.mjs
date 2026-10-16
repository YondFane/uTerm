import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test(
  "Windows installer retries and resumes, reuses verified cache and rejects altered content",
  { skip: process.platform !== "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "uterm-download-test-"));
    const bytes = Buffer.from("verified installer fixture");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const requests = [];
    let mode = "interrupted";
    const server = createServer((request, response) => {
      if (request.url.includes("latest.json")) {
        response.end(
          JSON.stringify({
            version: "1.2.3",
            installers:
              mode === "legacy"
                ? undefined
                : { "windows-x86_64": { sha256: hash, size: bytes.length } },
          }),
        );
        return;
      }
      requests.push(request.headers.range ?? "full");
      if (mode === "missing") {
        response.writeHead(404);
        response.end();
        return;
      }
      if (mode === "corrupt") {
        response.writeHead(200, { "Content-Length": bytes.length });
        response.end(Buffer.alloc(bytes.length));
        return;
      }
      if (requests.length === 1) {
        response.writeHead(503, { "Retry-After": "0" });
        response.end();
        return;
      }
      if (requests.length === 2) {
        response.writeHead(200, { "Content-Length": bytes.length });
        response.end(bytes.subarray(0, 8));
        return;
      }
      if (request.headers.range) {
        assert.equal(request.headers.range, "bytes=8-");
        response.writeHead(206, {
          "Content-Length": bytes.length - 8,
          "Content-Range": `bytes 8-${bytes.length - 1}/${bytes.length}`,
        });
        response.end(bytes.subarray(8));
      } else {
        response.writeHead(200, { "Content-Length": bytes.length });
        response.end(bytes);
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const fixture = join(root, "installer.ps1");
    const source = readFileSync(resolve("scripts/install/install.ps1"), "utf8").replace(
      "https://github.com/YondFane/uTerm/releases/download",
      `http://127.0.0.1:${server.address().port}`,
    );
    writeFileSync(
      fixture,
      "\ufeff[Console]::OutputEncoding = [Text.UTF8Encoding]::new()\nfunction Start-Process { param($FilePath, [switch]$Wait, [switch]$PassThru) Add-Content -LiteralPath $env:TEST_INSTALL_LOG -Value 'started'; return [pscustomobject]@{ ExitCode = 0 } }\n" +
        source,
    );
    const log = join(root, "launched.txt");
    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture],
          { env: { ...process.env, LOCALAPPDATA: root, TEST_INSTALL_LOG: log }, windowsHide: true },
        );
        let output = "";
        child.stdout.on("data", (bytes) => (output += bytes.toString()));
        child.stderr.on("data", (bytes) => (output += bytes.toString()));
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, output }));
      });
    try {
      let result = await run();
      assert.equal(result.code, 0, result.output);
      assert.deepEqual(requests, ["full", "full", "bytes=8-"]);
      result = await run();
      assert.equal(result.code, 0, result.output);
      assert.equal(requests.length, 3);
      const cached = join(root, "uTerm/installer-cache-v1", `windows-x86_64-${hash}.part`);
      writeFileSync(cached, Buffer.alloc(bytes.length));
      mode = "corrupt";
      result = await run();
      assert.notEqual(result.code, 0);
      assert.match(result.output, /verification failed/);
      assert.equal(existsSync(cached), false);
      assert.equal(readFileSync(log, "utf8").trim().split(/\r?\n/).length, 2);
      mode = "missing";
      const before = requests.length;
      result = await run();
      assert.notEqual(result.code, 0);
      assert.equal(requests.length, before + 1);
      assert.match(result.output, /Manual download/);
      mode = "legacy";
      const previous = requests.length;
      for (let attempt = 0; attempt < 2; attempt++) {
        result = await run();
        assert.equal(result.code, 0, result.output);
      }
      assert.equal(requests.length, previous + 2, "older feeds use fresh downloads");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
