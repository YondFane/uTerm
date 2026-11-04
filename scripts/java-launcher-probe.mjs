import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { join, resolve } from "node:path";

const output = resolve(process.argv[2] ?? "ci-evidence/java-launcher-probe.json");
const home = process.env.JAVA_HOME;
if (!home) throw new Error("Set JAVA_HOME to JDK 21");
const root = mkdtempSync(join(tmpdir(), "uterm-java-launcher-"));
const tool = (name) => join(home, "bin", name + (process.platform === "win32" ? ".exe" : ""));
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const tested = git("rev-parse", "HEAD");
const report = {
  kind: "encoding diagnostics, not task or platform acceptance",
  sourceHeadSHA: process.env.PR_HEAD_SHA ?? tested,
  testedMergeSHA: tested,
  sourceTreeDirty: !!git("status", "--porcelain"),
  platform: process.platform,
  architecture: process.arch,
  system: release(),
  java: spawnSync(tool("java"), ["-version"], { encoding: "utf8" }).stderr,
  variants: [],
};
try {
  writeFileSync(
    join(root, "EncodingProbe.java"),
    `public class EncodingProbe {
  public static void main(String[] args) {
    System.out.println("ARG:"+args[0]);
    System.out.println("EMPTY:"+args[1].isEmpty());
    System.out.println("PROP:"+System.getProperty("qa.value"));
    System.out.println("JNU:"+System.getProperty("sun.jnu.encoding"));
    System.out.println("NATIVE:"+System.getProperty("native.encoding"));
    System.out.println("FILE:"+System.getProperty("file.encoding"));
  }
}`,
  );
  const build = (name, args) => {
    const result = spawnSync(tool(name), args, { cwd: root, encoding: "utf8", timeout: 15000 });
    if (result.status !== 0) throw new Error(`${name}: ${result.error ?? result.stderr}`);
  };
  build("javac", ["-encoding", "UTF-8", "EncodingProbe.java"]);
  build("jar", [
    "--create",
    "--file",
    "fixture.jar",
    "--main-class",
    "EncodingProbe",
    "EncodingProbe.class",
  ]);
  const jar = "literal 中文 & %.jar";
  renameSync(join(root, "fixture.jar"), join(root, jar));
  const args = [
    "-Dfile.encoding=UTF-8",
    "-Dstdout.encoding=UTF-8",
    "-Dsun.stdout.encoding=UTF-8",
    "-Dqa.value=属性 & %PATH%",
    "-jar",
    jar,
    "literal 中文 & %PATH%",
    "",
  ];
  const quoted = args
    .map((value) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"')
    .join("\n");
  writeFileSync(join(root, "utf8.args"), quoted, "utf8");
  const variants = [
    ["direct", args],
    ["utf8-argfile", ["@utf8.args"]],
    ["utf8-argfile-jnu", ["-Dsun.jnu.encoding=UTF-8", "@utf8.args"]],
    [
      "utf8-argfile-native-jnu",
      ["-Dnative.encoding=UTF-8", "-Dsun.jnu.encoding=UTF-8", "@utf8.args"],
    ],
  ];
  for (const [name, arguments_] of variants) {
    const result = spawnSync(tool("java"), arguments_, {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
    });
    const stdout = result.stdout ?? "";
    report.variants.push({
      name,
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout,
      stderr: result.stderr,
      preserved:
        result.status === 0 &&
        stdout.includes("ARG:literal 中文 & %PATH%") &&
        stdout.includes("EMPTY:true") &&
        stdout.includes("PROP:属性 & %PATH%"),
    });
  }
} catch (error) {
  report.probeFailure = String(error);
} finally {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
