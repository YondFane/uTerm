import { pathToFileURL } from "node:url";
import { englishMessages } from "../src/lib/i18n.ts";
import { sourceFiles, sourceTree, parseSource, walk, hasHan, backendKeys } from "./i18n-source.mjs";

const catalogData = {
  "src/lib/settings.ts": ["commands"],
  "src/lib/interface-themes.ts": ["interfaceThemes"],
  "src/components/SettingsPanel.tsx": ["tabs", "interfaceFonts", "terminalFonts"],
};
export function checkSources() {
  const issues = [];
  for (const path of sourceFiles()) {
    if (/\/i18n(?:-.*)?\.ts$/.test(path)) continue;
    const { code } = sourceTree(path);
    issues.push(...checkSource(path, code));
  }
  for (const key of backendKeys())
    if (!Object.hasOwn(englishMessages, key)) issues.push(`Missing backend translation: ${key}`);
  return issues;
}
export function checkSource(path, code) {
  const issues = [];
  const tree = parseSource(code);
  const report = (n, message) => issues.push(`${path}:${n.loc.start.line}: ${message}`);
  walk(tree, (node, parents) => {
    const parent = parents.at(-1);
    if (node.type === "StringLiteral" && hasHan(node.value)) {
      const translated = parents.some(
        (p) =>
          p.type === "CallExpression" &&
          ["t", "tx", "translate"].includes(p.callee.name) &&
          p.arguments
            .slice(0, p.callee.name === "translate" ? 2 : 1)
            .some((a) => a.start <= node.start && a.end >= node.end),
      );
      const metadata = parents.some(
        (p) => p.type === "VariableDeclarator" && catalogData[path]?.includes(p.id.name),
      );
      const tabId =
        path.endsWith("SettingsPanel.tsx") &&
        (parent?.type === "BinaryExpression" ||
          (parent?.type === "CallExpression" &&
            parent.callee.name === "useState" &&
            node.value === "通用"));
      if (!translated && !metadata && !tabId)
        report(node, `Untranslated literal ${JSON.stringify(node.value)}`);
      if (!Object.hasOwn(englishMessages, node.value))
        report(node, `Missing English message ${JSON.stringify(node.value)}`);
    }
    if (node.type === "JSXText" && hasHan(node.value)) report(node, "Untranslated JSX text");
    if (node.type === "TemplateLiteral" && node.quasis.some((q) => hasHan(q.value.cooked ?? "")))
      report(node, "Untranslated template literal");
    if (node.type === "CallExpression" && ["t", "tx", "translate"].includes(node.callee.name)) {
      if (
        parents.some(
          (p) =>
            p.type === "CallExpression" &&
            ["t", "tx", "translate"].includes(p.callee.name) &&
            p.arguments[p.callee.name === "translate" ? 1 : 0]?.start <= node.start &&
            p.arguments[p.callee.name === "translate" ? 1 : 0]?.end >= node.end,
        )
      )
        report(node, "Message translated twice");
      const index = node.callee.name === "translate" ? 1 : 0;
      const key = node.arguments[index];
      if (key?.type === "StringLiteral") {
        if (!Object.hasOwn(englishMessages, key.value))
          report(node, `Missing message ${key.value}`);
        const needed = [...key.value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        const params = node.arguments[index + 1];
        const provided =
          params?.type === "ObjectExpression"
            ? params.properties.map((p) => p.key?.name ?? p.key?.value).sort()
            : [];
        if (
          (!params || params.type === "ObjectExpression") &&
          JSON.stringify([...new Set(needed)]) !== JSON.stringify(provided)
        )
          report(node, `Wrong message parameters: ${key.value}`);
      }
    }
    const brand = /^(?:uTerm\s*\/?|Agent|Git|GitHub|PowerShell|Aa|·\s*UTF-8)$/;
    if (node.type === "JSXText" && /[a-zA-Z]/.test(node.value) && !brand.test(node.value.trim()))
      report(node, `Untranslated English JSX: ${node.value.trim()}`);
    if (
      node.type === "JSXAttribute" &&
      ["title", "aria-label", "placeholder"].includes(node.name.name) &&
      node.value?.type === "StringLiteral" &&
      /[a-zA-Z]/.test(node.value.value) &&
      !brand.test(node.value.value)
    )
      report(node, `Untranslated English attribute: ${node.value.value}`);
  });
  return issues;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const issues = checkSources();
  if (issues.length) {
    console.error(issues.join("\n"));
    process.exitCode = 1;
  } else console.log("All application Chinese literals are registered and localized.");
}
