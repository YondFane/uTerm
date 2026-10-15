import { parse } from "@babel/parser";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function sourceFiles(root = "src") {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name).replaceAll("\\", "/");
    return entry.isDirectory() ? sourceFiles(path) : /\.[jt]sx?$/.test(path) ? [path] : [];
  });
}
export function sourceTree(path) {
  const code = readFileSync(path, "utf8");
  return { code, tree: parseSource(code) };
}
export const parseSource = (code) =>
  parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
export function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, ancestors);
    return;
  }
  if (!node.type) return;
  visit(node, ancestors);
  for (const [key, value] of Object.entries(node))
    if (
      ![
        "loc",
        "comments",
        "leadingComments",
        "trailingComments",
        "innerComments",
        "tokens",
      ].includes(key)
    )
      walk(value, visit, [...ancestors, node]);
}
export const hasHan = (text) => /\p{Script=Han}/u.test(text);

export function backendKeys() {
  const keys = new Set();
  for (const name of readdirSync("src-tauri/src").filter((n) => n.endsWith(".rs"))) {
    const code = readFileSync(`src-tauri/src/${name}`, "utf8");
    let testPending = false,
      testDepth = 0;
    for (const match of code.matchAll(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#\[cfg\(test\)\]|"(?:\\.|[^"\\])*"|[{}]/g,
    )) {
      const value = match[0];
      if (value.startsWith("//") || value.startsWith("/*")) continue;
      if (value === "#[cfg(test)]") {
        testPending = true;
        continue;
      }
      if (testPending) {
        if (value === "{") {
          testDepth = 1;
          testPending = false;
        }
        continue;
      }
      if (testDepth) {
        if (value === "{") testDepth++;
        if (value === "}") testDepth--;
        continue;
      }
      if (!value.startsWith('"') || !hasHan(value)) continue;
      let index = 0;
      keys.add(JSON.parse(value).replace(/\{\}/g, () => `{p${index++}}`));
    }
  }
  return [...keys];
}
