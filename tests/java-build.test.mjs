import test from "node:test";
import assert from "node:assert/strict";
import {
  parseJavaArguments,
  formatJavaArguments,
  parseJavaEnvironment,
} from "../src/lib/java-build.ts";

test("Java arguments preserve Windows paths, quotes, empty values and shell metacharacters", () => {
  const values = [
    "-Xmx1g",
    "--name=中文 空格",
    "C:\\work\\demo",
    "",
    "a&b",
    "100%PATH%",
    'literal"quote',
    "literal\ttab\nline\rreturn",
  ];
  assert.deepEqual(parseJavaArguments(formatJavaArguments(values)), values);
  assert.deepEqual(parseJavaArguments("'one value' C:\\work\\demo & echo"), [
    "one value",
    "C:\\work\\demo",
    "&",
    "echo",
  ]);
  assert.throws(() => parseJavaArguments('"unclosed'), /JAVA_ARGUMENTS_INVALID/);
  assert.throws(() => parseJavaArguments("bad\0value"), /JAVA_ARGUMENTS_INVALID/);
});
test("Java environment values remain literal and reject duplicate or host-control names", () => {
  assert.deepEqual(
    { ...parseJavaEnvironment("TOKEN=value=with=equals\nNAME=中文 & %PATH%\nEMPTY=") },
    { TOKEN: "value=with=equals", NAME: "中文 & %PATH%", EMPTY: "" },
  );
  for (const value of [
    "TOKEN=a\ntoken=b",
    "UTERM_DESKTOP_HOST=elsewhere",
    "NO_EQUALS",
    "1INVALID=value",
  ])
    assert.throws(() => parseJavaEnvironment(value), /JAVA_ENVIRONMENT_INVALID/);
});
