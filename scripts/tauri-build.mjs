import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const nsisTools = [
  /^https:\/\/github\.com\/tauri-apps\/binary-releases\/releases\/download\/nsis-[\d.]+\/nsis-[\d.]+\.zip$/,
  /^https:\/\/github\.com\/tauri-apps\/nsis-tauri-utils\/releases\/download\/nsis_tauri_utils-v[\d.]+\/nsis_tauri_utils\.dll$/,
];

export async function buildTauri(args, options = {}) {
  const cli =
    options.cli ??
    fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));
  const delay = options.delay ?? setTimeout;
  const output = options.output ?? ((stream, chunk) => process[stream].write(chunk));
  for (let attempt = 1; attempt <= 3; attempt++) {
    let tail = "";
    const child = spawn(process.execPath, [cli, "build", ...args], {
      cwd: root,
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
    for (const stream of ["stdout", "stderr"]) {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk) => {
        output(stream, chunk);
        tail = (tail + chunk).slice(-131072);
      });
    }
    const code = await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => {
        if (signal) reject(new Error(`Tauri build stopped by ${signal}`));
        else accept(status ?? 1);
      });
    });
    if (code === 0) return 0;
    // Retry only transient NSIS tool downloads; Tauri still verifies and packages every attempt.
    // 仅重试 NSIS 工具的临时下载错误；每次仍由 Tauri 执行校验与打包。
    const log = stripVTControlCharacters(tail);
    const download = [...log.matchAll(/Downloading (https:\/\/\S+)/g)].at(-1)?.[1];
    const nsis = nsisTools.some((pattern) => pattern.test(download ?? ""));
    const transient = /failed to bundle project: `http status: (?:429|502|503|504)`\s*$/.test(log);
    if (attempt === 3 || !nsis || !transient) return code;
    output(
      "stderr",
      `Retrying NSIS tool download after HTTP transport failure (${attempt}/3); waiting 5 seconds.\n`,
    );
    await delay(5000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await buildTauri(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
