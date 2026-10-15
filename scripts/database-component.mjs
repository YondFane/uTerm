import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../components/database/", import.meta.url));
const classes = join(root, "target", "classes");
rmSync(classes, { recursive: true, force: true });
mkdirSync(classes, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}
run("javac", [
  "--release",
  "17",
  "-g:none",
  "-encoding",
  "UTF-8",
  "-d",
  classes,
  ...readdirSync(join(root, "src"))
    .filter((name) => name.endsWith(".java"))
    .sort()
    .map((name) => join(root, "src", name)),
]);
const jar = join(root, "target", "uterm-database-1.1.0.jar");
run("jar", [
  "--create",
  "--no-manifest",
  "--date=2020-01-01T00:00:00Z",
  "--file",
  jar,
  "-C",
  classes,
  ".",
]);
const bytes = readFileSync(jar);
const bundledJar = join(root, "engine.jar");
const catalogPath = join(root, "catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const engine = {
  version: "1.1.0",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
};
if (process.argv.includes("--record")) {
  catalog.engine = engine;
  writeFileSync(bundledJar, bytes);
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
} else if (
  catalog.engine?.sha256 !== engine.sha256 ||
  catalog.engine?.size !== engine.size ||
  !readFileSync(bundledJar).equals(bytes)
) {
  throw new Error(
    "Engine differs from the bundled JAR or catalog. Rebuild and review --record output.",
  );
}
console.log(`Database engine: ${bytes.length} bytes, SHA-256 ${engine.sha256}`);
