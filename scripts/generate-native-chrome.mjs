import { createHash } from "node:crypto";
import { format } from "prettier";
import { readFileSync, writeFileSync } from "node:fs";

const bytes = readFileSync("shared/contracts/chrome-ui-v1.json", "utf8");
const contract = JSON.parse(bytes);
const digest = createHash("sha256").update(bytes).digest("hex");
if (contract.version !== 1) throw Error("Unsupported chrome contract version");
const dictionary = (values) =>
  "[\n" +
  Object.entries(values)
    .map(([key, value]) => `        ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(",\n") +
  "\n    ]";
let swift =
  "// Generated from chrome-ui-v1.json; run pnpm chrome:generate.\n// 由 chrome-ui-v1.json 生成；执行 pnpm chrome:generate。\n\nimport Foundation\n\n";
for (const [kind, values] of Object.entries(contract.icons)) {
  const type = `Core${kind === "sidebar" ? "Sidebar" : "Toolbar"}Icon`;
  swift += `public enum ${type}: String, CaseIterable, Sendable {\n    case ${Object.keys(values).join(", ")}\n}\n\n`;
}
swift += `public enum CoreChrome {\n    public static let contractSHA256 = "${digest}"\n`;
for (const [key, value] of Object.entries(contract.metrics)) {
  if (!/^[a-zA-Z]+$/.test(key) || !Number.isFinite(value) || value <= 0)
    throw Error("Invalid chrome metric");
  swift += `    public static let ${key}: Double = ${value}\n`;
}
for (const [kind, values] of Object.entries(contract.icons))
  swift += `    public static let ${kind}: [String: String] = ${dictionary(values)}\n`;
swift += "}\n";
const ts = await format(
  `// Generated from chrome-ui-v1.json; run pnpm chrome:generate.
// 由 chrome-ui-v1.json 生成；执行 pnpm chrome:generate。
export const chromeContractSHA256 = "${digest}";
`,
  { parser: "typescript" },
);
for (const [path, expected] of [
  ["macos/Sources/UTermBridge/CoreChrome.generated.swift", swift],
  ["src/lib/chrome.generated.ts", ts],
]) {
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== expected)
      throw Error("Client chrome is stale. Run pnpm chrome:generate.");
  } else writeFileSync(path, expected);
}
