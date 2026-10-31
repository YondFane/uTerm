import { tx, localizeMessage } from "./i18n.ts";
import { databaseError } from "./database.ts";

export interface MavenConfig {
  distribution: "local" | "managed";
  home: string;
  settings: string;
  repository: string;
  wrapper: boolean;
}
export interface JavaProjectConfig {
  maven_scope: "global" | "project";
  maven_configured?: boolean;
  maven: MavenConfig;
  module: string;
  java_version: number;
  java_home: string;
  mode: "development" | "jar";
  main_class?: string;
  maven_profiles: string;
  spring_profiles: string;
  vm_arguments: string[];
  arguments: string[];
  jar: string;
  skip_tests: boolean;
  offline: boolean;
}
export interface JavaConfiguration {
  revision: string;
  global: MavenConfig;
  project: JavaProjectConfig;
  configured: boolean;
  jdks: { home: string; version: number; registered?: boolean; available?: boolean }[];
  maven_home: string | null;
}
export interface JavaModule {
  path: string;
  name: string;
  packaging: string;
  java_version: number | null;
  boot: boolean;
  jars: string[];
  main_classes?: { name: string; spring_boot: boolean }[];
}
export interface JavaTask {
  spec: { id: string; directory: string; shell: string; agent: null };
  generation: string;
  task: { root: string; name: string; action: string; created: number };
  running: boolean;
  code: number | null;
}
export interface JavaComponent {
  id: string;
  version: string;
  size: number;
  source: string;
  installed: boolean;
  downloaded: number;
}
export interface JavaComponentsStatus {
  items: JavaComponent[];
  busy: boolean;
}

export function parseJavaArguments(text: string): string[] {
  const result: string[] = [];
  let value = "",
    quote = "",
    present = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\0") throw new Error("JAVA_ARGUMENTS_INVALID");
    if (
      char === "\\" &&
      index + 1 < text.length &&
      (text[index + 1] === quote || text[index + 1] === "\\") &&
      quote
    ) {
      value += text[++index];
      present = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else value += char;
      present = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      present = true;
    } else if (/\s/.test(char)) {
      if (present) {
        result.push(value);
        value = "";
        present = false;
      }
    } else {
      value += char;
      present = true;
    }
  }
  if (quote) throw new Error("JAVA_ARGUMENTS_INVALID");
  if (present) result.push(value);
  return result;
}
function quoteJavaArgument(value: string): string {
  // Match the literal parser: escape quotes and backslashes, without JSON control escapes.
  // 与字面量解析器保持一致：只转义引号和反斜杠，不引入 JSON 控制字符转义。
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatJavaArguments(values: string[]): string {
  return values
    .map((value) => (/\s|["']/.test(value) || !value ? quoteJavaArgument(value) : value))
    .join(" ");
}
export function parseJavaEnvironment(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error("JAVA_ENVIRONMENT_INVALID");
    const normalizedName = match[1].toUpperCase();
    if (normalizedName.startsWith("UTERM_") || names.has(normalizedName))
      throw new Error("JAVA_ENVIRONMENT_INVALID");
    names.add(normalizedName);
    result[match[1]] = match[2];
  }
  return result;
}
export function javaError(reason: unknown): string {
  const value = String(reason);
  const errors: Record<string, string> = {
    JAVA_HOST_UPGRADE_REQUIRED: tx(
      "后台服务需要升级。请先关闭现有会话，再重新打开应用；已有进程未被终止。",
    ),
    JAVA_CONFIG_INVALID: tx("Java 构建配置无效，原配置已保留。"),
    JAVA_CONFIG_CONFLICT: tx("配置已被其他窗口修改，请重新读取后再保存。"),
    JAVA_CONFIG_SAVE: tx("无法保存构建配置，原配置已保留。"),
    JAVA_PROJECT_INVALID: tx("项目路径必须位于所选根目录内。"),
    JAVA_POM_INVALID: tx("无法读取 Maven 项目，请检查 pom.xml 与模块路径。"),
    JAVA_POM_LIMIT: tx("Maven 模块超过 200 个，请选择较小的项目根目录。"),
    JAVA_MAIN_CLASS_INVALID: tx("启动主类必须是完整 Java 类名，例如 com.example.Application。"),
    JAVA_MAIN_CLASS_AMBIGUOUS: tx("检测到多个启动主类，请选择一个或手动填写。"),
    JAVA_MAIN_SCAN_LIMIT: tx("Java 源码超过检测上限，请选择较小的项目或模块。"),
    JAVA_MAIN_SCAN_FAILED: tx("无法读取 Java 源码，请检查文件权限后重新检测。"),
    JAVA_MODULE_INVALID: tx("请选择可运行的 Maven 模块。"),
    JAVA_JDK_REQUIRED: tx("未检测到所选版本的完整 JDK。请选择本机 JDK，或安装对应版本。"),
    JAVA_JDK_VERSION: tx("所选 JDK 与配置的 Java 版本不同，请重新选择。"),
    JAVA_JDK_REGISTRY_INVALID: tx("无法读取本机 JDK 记录，原记录已保留。"),
    JAVA_JDK_LIMIT: tx("最多手动添加 64 个 JDK，请先移除不需要的记录。"),
    JAVA_MAVEN_REQUIRED: tx("未找到 Maven。请选择本机 Maven、安装托管版本，或使用项目 Wrapper。"),
    JAVA_WRAPPER_INVALID: tx("无法读取项目 Wrapper 分发配置，请检查 HTTPS ZIP 地址及校验值。"),
    JAVA_WRAPPER_OFFLINE: tx("项目 Wrapper 尚未缓存，首次使用需要网络连接。"),
    JAVA_SETTINGS_MISSING: tx("找不到所选 settings.xml，请检查文件路径。"),
    JAVA_JAR_AMBIGUOUS: tx("无法确定可执行 JAR，请从项目内选择一个产物。"),
    JAVA_TASK_RUNNING: tx("此项目已有任务正在运行，请先停止后再启动。"),
    JAVA_TASK_MISSING: tx("后台任务已不存在，请重新启动任务。"),
    JAVA_TASK_BUSY: tx("已有安装或任务正在准备，请稍后重试。"),
    JAVA_TASK_INVALID: tx("构建任务参数无效，请检查参数和环境变量。"),
    JAVA_ARGUMENTS_INVALID: tx("参数中的引号未闭合，或包含无效字符。"),
    JAVA_ENVIRONMENT_INVALID: tx("环境变量须逐行填写 KEY=value，名称不可重复或以 UTERM_ 开头。"),
    JAVA_COMPONENT_MISSING: tx("找不到所选开发组件。"),
    JAVA_COMPONENT_INVALID: tx("开发组件缺少所需程序，请重新安装。"),
    JAVA_PLATFORM_UNSUPPORTED: tx("当前平台没有对应的开发组件，请选择本机环境。"),
    JAVA_OPERATION_FAILED: tx("Java 构建操作失败，请重试。"),
  };
  const key = Object.keys(errors).find((key) => value.includes(key));
  if (key) return errors[key];
  if (/DB_COMPONENT_|DOWNLOAD_/.test(value)) return databaseError(reason);
  return localizeMessage(value);
}
export const javaSize = (size: number) =>
  size >= 1e6 ? `${(size / 1e6).toFixed(1)} MB` : `${Math.ceil(size / 1e3)} KB`;
