import test from "node:test";
import assert from "node:assert/strict";
import {
  pythonDraft,
  parsePythonArguments,
  formatPythonArguments,
  parsePythonEnvironment,
  pythonUrl,
  pythonTaskUrl,
} from "../src/lib/python-run.ts";

const config = {
  interpreter: "",
  mode: "script",
  target: "",
  working_directory: ".",
  arguments: [],
  host: "127.0.0.1",
  port: 8000,
  reload: false,
};
test("Python defaults prefer a unique framework entry and project venv without replacing saved choices", () => {
  const interpreter = {
    path: "D:\\项目\\.venv\\Scripts\\python.exe",
    version: "3.13",
    virtual_environment: true,
  };
  const project = {
    candidates: [
      { mode: "script", target: "src/app/main.py", working_directory: "." },
      { mode: "fastapi", target: "app.main:app", working_directory: "src" },
    ],
    truncated: false,
  };
  const draft = pythonDraft({ configured: false, project: config }, project, [interpreter]);
  assert.equal(draft.mode, "fastapi");
  assert.equal(draft.target, "app.main:app");
  assert.equal(draft.working_directory, "src");
  assert.equal(draft.interpreter, interpreter.path);
  const saved = {
    ...config,
    interpreter: "D:\\external\\python.exe",
    mode: "module",
    target: "custom.main",
  };
  assert.deepEqual(
    pythonDraft({ configured: true, project: saved }, project, [interpreter]),
    saved,
  );
  project.candidates.push({ mode: "flask", target: "web:app", working_directory: "." });
  assert.equal(pythonDraft({ configured: false, project: config }, project, []).target, "");
});
test("Python argument and environment parsers preserve literal values and reject malformed data", () => {
  const values = ["D:\\中文 project\\file.py", "&", "%PATH%", "", 'a"b', "a\\b", "--name=测试"];
  assert.deepEqual(parsePythonArguments(formatPythonArguments(values)), values);
  assert.deepEqual(
    { ...parsePythonEnvironment("VALUE=中文 & %PATH%\nEMPTY=\nEQUAL=a=b") },
    { VALUE: "中文 & %PATH%", EMPTY: "", EQUAL: "a=b" },
  );
  assert.throws(() => parsePythonArguments('"unclosed'), /PYTHON_ARGUMENTS_INVALID/);
  for (const value of ["UTERM_TOKEN=x", "KEY=x\nkey=y", "BAD-NAME=x", "no-equals"])
    assert.throws(() => parsePythonEnvironment(value), /PYTHON_ENVIRONMENT_INVALID/);
});
test("service links use the running task metadata and handle bind-all and IPv6", () => {
  assert.equal(pythonUrl({ ...config, mode: "fastapi", host: "0.0.0.0" }), "http://127.0.0.1:8000");
  assert.equal(pythonUrl({ ...config, mode: "django", host: "::" }), "http://[::1]:8000");
  assert.equal(pythonUrl(config), null);
  assert.equal(
    pythonTaskUrl({ task: { action: "python:run|http://127.0.0.1:45123" } }),
    "http://127.0.0.1:45123",
  );
  for (const value of [
    "python:run",
    "python:run|javascript:alert(1)",
    "python:run|http://user:pass@127.0.0.1/",
    "python:run|http://example.com/",
  ])
    assert.equal(pythonTaskUrl({ task: { action: value } }), null);
});
