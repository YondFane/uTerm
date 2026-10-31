import { tx, localizeMessage } from "./i18n.ts";
import { parseJavaArguments, formatJavaArguments, parseJavaEnvironment } from "./java-build.ts";
import type { JavaTask } from "./java-build.ts";

export type PythonMode = "script" | "module" | "fastapi" | "flask" | "django";
export interface PythonRunConfig {
  interpreter: string;
  mode: PythonMode;
  target: string;
  working_directory: string;
  arguments: string[];
  host: string;
  port: number;
  reload: boolean;
}
export interface PythonConfiguration {
  revision: string;
  configured: boolean;
  project: PythonRunConfig;
}
export interface PythonInterpreter {
  path: string;
  version: string;
  virtual_environment: boolean;
}
export interface PythonCandidate {
  mode: PythonMode;
  target: string;
  working_directory: string;
}
export interface PythonProject {
  candidates: PythonCandidate[];
  truncated: boolean;
}
export type PythonTask = JavaTask;
export const formatPythonArguments = formatJavaArguments;
export function parsePythonArguments(value: string) {
  try {
    return parseJavaArguments(value);
  } catch {
    throw new Error("PYTHON_ARGUMENTS_INVALID");
  }
}
export function parsePythonEnvironment(value: string) {
  try {
    return parseJavaEnvironment(value);
  } catch {
    throw new Error("PYTHON_ENVIRONMENT_INVALID");
  }
}
export function pythonDraft(
  configuration: PythonConfiguration,
  info: PythonProject,
  interpreters: PythonInterpreter[],
): PythonRunConfig {
  if (configuration.configured) return configuration.project;
  const frameworks = info.candidates.filter((value) => !["script", "module"].includes(value.mode));
  const main = info.candidates.filter(
    (value) => value.mode === "script" && /(^|\/)main\.py$/.test(value.target),
  );
  const candidates = frameworks.length ? frameworks : main.length ? main : info.candidates;
  const candidate = candidates.length === 1 ? candidates[0] : null;
  return {
    ...configuration.project,
    ...candidate,
    interpreter: interpreters[0]?.path ?? "",
    port: candidate?.mode === "flask" ? 5000 : 8000,
  };
}
export function pythonUrl(config: PythonRunConfig): string | null {
  if (!["fastapi", "flask", "django"].includes(config.mode)) return null;
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
  if (
    !/^[a-fA-F\d.:]+$/.test(host) ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535
  )
    return null;
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`;
}
export function pythonTaskUrl(task: PythonTask): string | null {
  const value = task.task.action.split("|")[1];
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !/^[\da-fA-F.:[\]]+$/.test(url.hostname)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function pythonError(reason: unknown): string {
  const text = String(reason);
  const errors: Record<string, string> = {
    PYTHON_CONFIG_INVALID: tx("Python 运行配置无效，原配置已保留。"),
    PYTHON_CONFIG_CONFLICT: tx("配置已被其他窗口修改，请重新读取后再保存。"),
    PYTHON_CONFIG_SAVE: tx("无法保存运行配置，原配置已保留。"),
    PYTHON_PROJECT_INVALID: tx("工作目录和脚本必须位于所选项目根目录内。"),
    PYTHON_INTERPRETER_REQUIRED: tx("请选择可用的 Python 3 解释器，或重新检测本机环境。"),
    PYTHON_DEPENDENCY_MISSING: tx("所选 Python 环境缺少框架依赖，请在该环境中安装后重试。"),
    PYTHON_TARGET_INVALID: tx("启动入口无效，请选择 Python 脚本或填写有效的模块与应用入口。"),
    PYTHON_ARGUMENTS_INVALID: tx("参数中的引号未闭合，或包含无效字符。"),
    PYTHON_ENVIRONMENT_INVALID: tx("环境变量须逐行填写 KEY=value，名称不可重复或以 UTERM_ 开头。"),
    PYTHON_OPERATION_FAILED: tx("Python 运行操作失败，请重试。"),
    JAVA_HOST_UPGRADE_REQUIRED: tx(
      "后台服务需要升级。请先关闭现有会话，再重新打开应用；已有进程未被终止。",
    ),
    JAVA_TASK_RUNNING: tx("此项目已有任务正在运行，请先停止后再启动。"),
    JAVA_TASK_INVALID: tx("运行参数或环境变量无效，请检查后重试。"),
    JAVA_PROJECT_INVALID: tx("工作目录和脚本必须位于所选项目根目录内。"),
  };
  const key = Object.keys(errors).find((key) => text.includes(key));
  if (key === "PYTHON_DEPENDENCY_MISSING")
    return `${errors[key]} ${text.split("PYTHON_DEPENDENCY_MISSING:")[1] ?? ""}`;
  return key ? errors[key] : localizeMessage(text);
}
