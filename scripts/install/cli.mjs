#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { win32 } from "node:path";
import { realpathSync } from "node:fs";

export function installerCommand(platform, env = process.env) {
  if (platform === "darwin") {
    return { command: "/bin/bash", args: [fileURLToPath(new URL("install.sh", import.meta.url))] };
  }
  if (platform === "win32") {
    if (!env.SystemRoot || !win32.isAbsolute(env.SystemRoot)) {
      throw new Error("Missing Windows system directory. / 缺少 Windows 系统目录。");
    }
    return {
      command: win32.join(
        env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("install.ps1", import.meta.url)),
      ],
    };
  }
  throw new Error("Only macOS and Windows x64 are supported. / 仅支持 macOS 和 Windows x64。");
}

export function main(args = process.argv.slice(2), platform = process.platform, run = spawnSync) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(
      "Usage: uterm-install [--help]\nInstall stable uTerm for macOS or Windows x64. / 安装 macOS 或 Windows x64 稳定版 uTerm。",
    );
    return 0;
  }
  if (args.length) {
    console.error("Unknown arguments. Use --help. / 未知参数，请使用 --help。");
    return 1;
  }
  try {
    const { command, args: commandArgs } = installerCommand(platform);
    const result = run(command, commandArgs, { stdio: "inherit", shell: false });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`Installer interrupted / 安装中断: ${result.signal}`);
    return result.status ?? 1;
  } catch (error) {
    console.error(`Installation failed / 安装失败: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
