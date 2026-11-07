import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { format } from "prettier";

const schemas = JSON.parse(
  execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--locked",
      "--manifest-path",
      "crates/uterm-core/Cargo.toml",
      "--bin",
      "uterm-core-contract",
      "--",
      "--schema",
    ],
    { encoding: "utf8" },
  ),
);
function type(schema, swift) {
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((t) => t !== "null");
    if (nonNull.length !== 1) throw Error("Unsupported schema union");
    return (
      type({ ...schema, type: nonNull[0] }, swift) +
      (schema.type.includes("null") ? (swift ? "?" : " | null") : "")
    );
  }
  if (schema === true || (!schema.type && !schema.$ref && !schema.anyOf)) return "JSONValue";
  if (schema.$ref) return `Core${schema.$ref.split("/").at(-1)}`;
  if (schema.anyOf)
    return (
      type(
        schema.anyOf.find((s) => s.type !== "null"),
        swift,
      ) + (swift ? "?" : " | null")
    );
  if (schema.type === "object" && schema.additionalProperties)
    return swift
      ? `[String: ${type(schema.additionalProperties, true)}]`
      : `Record<string, ${type(schema.additionalProperties, false)}>`;
  if (schema.type === "array")
    return swift ? `[${type(schema.items, true)}]` : `${type(schema.items, false)}[]`;
  const scalar = swift
    ? { string: "String", integer: "UInt32", number: "Double", boolean: "Bool" }
    : { string: "string", integer: "number", number: "number", boolean: "boolean" };
  if (!scalar[schema.type]) throw Error(`Unsupported contract schema: ${JSON.stringify(schema)}`);
  if (!swift && schema.type === "integer" && ["uint64", "int64"].includes(schema.format))
    return "bigint";
  if (swift && schema.type === "integer")
    return (
      {
        uint8: "UInt8",
        uint16: "UInt16",
        uint32: "UInt32",
        uint64: "UInt64",
        int8: "Int8",
        int16: "Int16",
        int32: "Int32",
        int64: "Int64",
      }[schema.format] ?? "Int"
    );
  return scalar[schema.type];
}
const banner =
  "// Generated from uterm-core Rust DTOs; run pnpm contracts:generate.\n// 由 uterm-core Rust DTO 生成；执行 pnpm contracts:generate。\n";
const ts =
  banner +
  "export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };\n\n" +
  Object.entries(schemas)
    .map(
      ([name, s]) =>
        `export interface Core${name} {\n${Object.entries(s.properties)
          .map(([key, p]) => `  ${key}${s.required?.includes(key) ? "" : "?"}: ${type(p, false)};`)
          .join("\n")}\n}`,
    )
    .join("\n\n") +
  "\n";
const swift =
  banner +
  "import Foundation\n\n" +
  Object.entries(schemas)
    .map(
      ([name, s]) =>
        `public struct Core${name}: Codable, Sendable {\n${Object.entries(s.properties)
          .map(([key, p]) => {
            let t = type(p, true);
            return `    public var ${key}: ${t}${s.required?.includes(key) || t.endsWith("?") ? "" : "?"}`;
          })
          .join("\n")}\n}`,
    )
    .join("\n\n") +
  "\n";
for (const [path, raw] of [
  ["src/lib/core-contract.generated.ts", ts],
  ["macos/Sources/UTermBridge/CoreContract.generated.swift", swift],
]) {
  const bytes = path.endsWith(".ts")
    ? await format(raw, { parser: "typescript", printWidth: 100 })
    : raw;
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== bytes) throw Error(`Generated contract drift: ${path}`);
  } else writeFileSync(path, bytes);
}
