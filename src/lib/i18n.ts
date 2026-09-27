// uTerm ships Simplified Chinese and English only. / uTerm 仅提供简体中文与英文。
import { messages } from "./i18n-messages.ts";
import { backendMessages } from "./i18n-backend.ts";
export const supportedLanguages = ["zh-Hans", "en"] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];
export type LanguagePreference = "system" | SupportedLanguage;

export const languageOptions: ReadonlyArray<readonly [LanguagePreference, string]> = [
  ["system", ""],
  ["zh-Hans", "简体中文"],
  ["en", "English"],
];

/** Maps browser or WebView tags to uTerm's two shipped languages. / 将浏览器或 WebView 语言映射为 uTerm 的两种内置语言。 */
export function resolveLanguage(preferred: readonly string[]): SupportedLanguage {
  for (const value of preferred) {
    const parts = value.replaceAll("_", "-").toLowerCase().split("-");
    switch (parts[0]) {
      case "en":
        return "en";
      case "zh":
        return "zh-Hans";
    }
  }
  return "en";
}

export function activeLanguage(
  preference: LanguagePreference,
  preferred = typeof navigator === "undefined" ? ["en"] : navigator.languages,
) {
  return preference === "system" ? resolveLanguage(preferred) : preference;
}

const strings: Partial<Record<SupportedLanguage, Record<string, string>>> = {
  en: {
    ...messages,
    ...backendMessages,
    纸白: "Paper",
    晴空: "Clear Sky",
    "暖白与陶棕，温润清爽。": "Warm white and terracotta. Soft and fresh.",
    "冷白与天蓝，明亮通透。": "Cool white and sky blue. Bright and clear.",
    暗黑: "Black",
    "纯黑与银灰，简洁沉浸。": "Pure black and silver. Minimal and immersive.",
    界面主题: "Interface theme",
    砂岩: "Sandstone",
    深海: "Ocean",
    青苔: "Moss",
    "暖灰与砂金，安静专注。": "Warm charcoal and sand.",
    "深蓝与冰蓝，清晰利落。": "Deep navy and ice blue.",
    "墨绿与薄荷，柔和沉静。": "Forest green and mint.",
    "即时生效并自动保存，不改变终端配色。":
      "Applies and saves immediately. Terminal colors stay unchanged.",
    颜色模式: "Color mode",
    深色: "Dark",
    浅色: "Light",
    终端深色配色: "Dark terminal colors",
    终端浅色配色: "Light terminal colors",
    开始工作: "Get started",
    "专注于下一行。": "Focus on what’s next.",
    "项目、终端与 Agent，在一个工作空间中。":
      "Projects, terminals and agents. One focused workspace.",
    "请在桌面应用中管理项目和会话。": "Open the desktop app to manage projects and sessions.",
    "正在读取工作区。": "Loading your workspace.",
    打开项目: "Open a project",
    新建终端: "New terminal",
    新建聊天: "New chat",
    "选择目录，开始你的工作。": "Choose a directory and make it your workspace.",
    "在当前项目中启动 Shell。": "Start a shell in this project.",
    "与本地 Agent 一起处理任务。": "Work through a task with a local agent.",
    "无需项目，直接打开 Shell。": "Open a shell without a project.",
    "本地运行 · 自由掌控": "Runs locally. Yours to control.",
    所有命令: "All commands",
    关闭会话: "Close Session",
    设置: "Settings",
    关闭设置: "Close settings",
    通用: "General",
    外观: "Appearance",
    终端: "Terminal",
    工作区: "Workspace",
    快捷键: "Keyboard shortcuts",
    "Agent 与用量": "Agents & usage",
    本地控制: "Local control",
    软件更新: "Software update",
    应用语言: "App language",
    系统默认: "System default",
    跟随系统: "System default",
    "打开 uTerm": "Open uTerm",
    全部处理完毕: "All caught up",
    "退出 uTerm": "Quit uTerm",
    空闲: "Idle",
    工作中: "Working",
    需要你: "Needs you",
    已完成: "Done",
    已退出: "Exited",
    "Agent 对话": "Agent chats",
  },
};

export const englishMessages = strings.en!;
export const missingTranslations = new Set<string>();
export type MessageParams = Record<string, string | number>;
export function translate(
  language: SupportedLanguage,
  key: string,
  params: MessageParams = {},
): string {
  if (!Object.hasOwn(englishMessages, key)) {
    if (!missingTranslations.has(key)) console.error("Missing translation:", key);
    missingTranslations.add(key);
    return "[Missing translation]";
  }
  const template = language === "zh-Hans" ? key : englishMessages[key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!Object.hasOwn(params, name)) throw new Error(`Missing translation parameter: ${name}`);
    return String(params[name]);
  });
}
let currentLanguage: SupportedLanguage = "zh-Hans";
const languageListeners = new Set<() => void>();
export const getUiLanguage = () => currentLanguage;
export function subscribeLanguage(listener: () => void) {
  languageListeners.add(listener);
  return () => {
    languageListeners.delete(listener);
  };
}
export function setUiLanguage(language: SupportedLanguage) {
  if (currentLanguage === language) return;
  currentLanguage = language;
  for (const listener of languageListeners) listener();
}
export function tx(key: string, params?: MessageParams) {
  return translate(currentLanguage, key, params);
}

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const messagePatterns = Object.entries(englishMessages).flatMap(([key, en]) =>
  [key, en]
    .filter((value) => /\{\w+\}/.test(value))
    .map((value) => {
      const names = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const parts = value.split(/\{\w+\}/);
      return {
        key,
        names,
        pattern: new RegExp("^" + parts.map(escapePattern).join("([\\s\\S]*?)") + "$"),
      };
    }),
);
export function localizeMessage(value: unknown, language = currentLanguage, depth = 0): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  if (!text || depth > 4) return text;
  const exact = Object.hasOwn(englishMessages, text)
    ? text
    : Object.keys(englishMessages).find((key) => englishMessages[key] === text);
  if (exact && !/\{\w+\}/.test(exact)) return translate(language, exact);
  for (const { key, names, pattern } of messagePatterns) {
    const match = pattern.exec(text);
    if (match)
      return translate(
        language,
        key,
        Object.fromEntries(
          names.map((name, i) => [name, localizeMessage(match[i + 1], language, depth + 1)]),
        ),
      );
  }
  if (text.startsWith("Error: "))
    return "Error: " + localizeMessage(text.slice(7), language, depth + 1);
  return text;
}
