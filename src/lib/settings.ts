import { tx } from "./i18n.ts";
import { themes, validTheme } from "./themes.ts";
import type { Theme } from "./themes.ts";
import type { LanguagePreference } from "./i18n.ts";
import { interfaceThemes } from "./interface-themes.ts";
import type { InterfaceThemeId } from "./interface-themes.ts";
export const settingsKey = "uterm.desktop.settings.v1";
export const commands = [
  ["palette", "命令面板", "Mod+Shift+KeyP"],
  ["settings", "设置", "Mod+Comma"],
  ["project", "添加项目", "Mod+KeyO"],
  ["terminal", "新建终端", "Mod+KeyT"],
  ["chat", "新建聊天", "Mod+KeyN"],
  ["quick", "快速打开文件", "Mod+KeyP"],
  ["search", "搜索项目", "Mod+Shift+KeyF"],
  ["files", "显示或隐藏文件", ""],
  ["toggleSidebar", "显示或隐藏左侧栏", "Mod+KeyB"],
  ["toggleInspector", "显示或隐藏工具面板", "Mod+Alt+KeyB"],
  ["swapPanes", "交换左右窗格", ""],
  ["git", "显示或隐藏 Git", ""],
  ["github", "显示或隐藏 GitHub", ""],
  ["agents", "Agent 与用量", ""],
  ["splitRight", "向右分屏", "Mod+KeyD"],
  ["splitDown", "向下分屏", "Mod+Shift+KeyD"],
  ["zoom", "放大或还原窗格", "Mod+Shift+Enter"],
  ["ungroup", "取消分组", ""],
  ["left", "聚焦左侧窗格", "Mod+Alt+ArrowLeft"],
  ["right", "聚焦右侧窗格", "Mod+Alt+ArrowRight"],
  ["up", "聚焦上方窗格", "Mod+Alt+ArrowUp"],
  ["down", "聚焦下方窗格", "Mod+Alt+ArrowDown"],
  ["next", "下一个会话", "Mod+Shift+BracketRight"],
  ["previous", "上一个会话", "Mod+Shift+BracketLeft"],
  ["close", "关闭会话", "Mod+KeyW"],
  ["link", "复制会话链接", ""],
  ["terminalSearch", "搜索终端输出", "Mod+KeyF"],
] as const;
export type CommandId = (typeof commands)[number][0];
export interface Settings {
  breakReminder: boolean;
  breakInterval: number;
  inspectorPosition: "left" | "right";
  interfaceTheme: InterfaceThemeId;
  darkTheme: string;
  lightTheme: string;
  customThemes: Theme[];
  interfaceFont: string;
  interfaceSize: number;
  rowPadding: number;
  windowPadding: number;
  opacity: number;
  blur: boolean;
  language: LanguagePreference;
  version: 1;
  appearance: "system" | "dark" | "light";
  fontFamily: string;
  fontThicken: boolean;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelect: boolean;
  defaultShell: "default" | "cmd";
  defaultAgent: string;
  enabledAgents: string[];
  projectOrder: "manual" | "name";
  usageRemote: boolean;
  shortcuts: Partial<Record<CommandId, string>>;
}
export const defaults: Settings = {
  breakReminder: false,
  breakInterval: 60,
  inspectorPosition: "right",
  interfaceTheme: "black",
  darkTheme: "default-dark",
  lightTheme: "default-light",
  customThemes: [],
  interfaceFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  interfaceSize: 13,
  rowPadding: 1,
  windowPadding: 10,
  opacity: 1,
  blur: false,
  language: "system",
  version: 1,
  appearance: "dark",
  fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
  fontThicken: false,
  fontSize: 14,
  lineHeight: 1,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 3000,
  copyOnSelect: false,
  defaultShell: "default",
  defaultAgent: "codex",
  enabledAgents: [],
  projectOrder: "manual",
  usageRemote: true,
  shortcuts: {},
};
export function binding(settings: Settings, id: CommandId, mac: boolean): string {
  const value = settings.shortcuts[id];
  if (value !== undefined) return value;
  if (!mac && id === "terminalSearch") return "Mod+Shift+KeyF";
  if (!mac && id === "search") return "Mod+Alt+KeyF";
  return commands.find((item) => item[0] === id)?.[2] ?? "";
}
export function chord(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">,
  mac: boolean,
): string {
  if (mac ? event.ctrlKey || !event.metaKey : event.metaKey || !event.ctrlKey) return "";
  if (
    !/^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Comma|Period|Slash|BracketLeft|BracketRight|Enter|Backslash|Minus|Equal)$/.test(
      event.code,
    )
  )
    return "";
  return [
    "Mod",
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
    event.code,
  ].join("+");
}
export function shortcutLabel(value: string, mac: boolean): string {
  return value
    .replace("Mod", mac ? "⌘" : "Ctrl")
    .replace("Alt", mac ? "⌥" : "Alt")
    .replace("Shift", mac ? "⇧" : "Shift")
    .replace(/Key|Digit/g, "")
    .replace("Comma", ",")
    .replace("BracketLeft", "[")
    .replace("BracketRight", "]")
    .replace("Arrow", "");
}
export function readSettings(raw: string | null): Settings {
  if (raw === null) return { ...defaults, shortcuts: {} };
  const parsed = JSON.parse(raw);
  const v = parsed?.version === 1 && {
    ...parsed,
    enabledAgents: parsed.enabledAgents === undefined ? [] : parsed.enabledAgents,
    breakReminder:
      parsed.breakReminder === undefined ? defaults.breakReminder : parsed.breakReminder,
    breakInterval:
      parsed.breakInterval === undefined ? defaults.breakInterval : parsed.breakInterval,
    inspectorPosition:
      parsed.inspectorPosition === undefined
        ? defaults.inspectorPosition
        : parsed.inspectorPosition,
    interfaceTheme:
      parsed.interfaceTheme === undefined ? defaults.interfaceTheme : parsed.interfaceTheme,
  };
  const finite = (n: unknown, min: number, max: number) =>
    typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  if (
    !v ||
    v.version !== 1 ||
    typeof v.breakReminder !== "boolean" ||
    !Number.isInteger(v.breakInterval) ||
    !finite(v.breakInterval, 1, 1440) ||
    !["left", "right"].includes(v.inspectorPosition) ||
    !interfaceThemes.some((theme) => theme.id === v.interfaceTheme) ||
    !["dark", "light", "system"].includes(v.appearance) ||
    typeof v.fontFamily !== "string" ||
    !v.fontFamily.trim() ||
    v.fontFamily.length > 300 ||
    typeof v.fontThicken !== "boolean" ||
    !finite(v.fontSize, 10, 32) ||
    !finite(v.lineHeight, 1, 2) ||
    !["block", "bar", "underline"].includes(v.cursorStyle) ||
    typeof v.cursorBlink !== "boolean" ||
    !finite(v.scrollback, 100, 100000) ||
    !Number.isInteger(v.scrollback) ||
    typeof v.copyOnSelect !== "boolean" ||
    !["default", "cmd"].includes(v.defaultShell) ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(v.defaultAgent) ||
    !Array.isArray(v.enabledAgents) ||
    !v.enabledAgents.every(
      (id: unknown) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(id),
    ) ||
    new Set(v.enabledAgents).size !== v.enabledAgents.length ||
    !["manual", "name"].includes(v.projectOrder) ||
    typeof v.usageRemote !== "boolean" ||
    !v.shortcuts ||
    typeof v.shortcuts !== "object" ||
    Array.isArray(v.shortcuts)
  )
    throw new Error(tx("设置文件无效，原数据已保留。请恢复默认设置后重试。"));
  if (
    !Array.isArray(v.customThemes) ||
    v.customThemes.length > 30 ||
    !v.customThemes.every(validTheme) ||
    ![...themes, ...v.customThemes].some((theme) => theme.id === v.darkTheme) ||
    ![...themes, ...v.customThemes].some((theme) => theme.id === v.lightTheme) ||
    typeof v.interfaceFont !== "string" ||
    !v.interfaceFont.trim() ||
    v.interfaceFont.length > 300 ||
    !finite(v.interfaceSize, 10, 20) ||
    !finite(v.rowPadding, 0, 8) ||
    !finite(v.windowPadding, 0, 40) ||
    !finite(v.opacity, 0.3, 1) ||
    typeof v.blur !== "boolean" ||
    !["system", "zh-Hans", "en"].includes(v.language)
  )
    throw new Error(tx("外观设置无效，原数据已保留。"));
  for (const [key, value] of Object.entries(v.shortcuts)) {
    if (
      !commands.some((item) => item[0] === key) ||
      typeof value !== "string" ||
      (value &&
        !/^Mod\+(Alt\+)?(Shift\+)?(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Comma|Period|Slash|BracketLeft|BracketRight|Enter|Backslash|Minus|Equal)$/.test(
          value,
        ))
    )
      throw new Error(tx("快捷键配置无效，原数据已保留。"));
  }
  return {
    ...(Object.fromEntries(Object.keys(defaults).map((key) => [key, v[key]])) as Settings),
    shortcuts: { ...v.shortcuts },
  };
}
export function validateShortcuts(settings: Settings, mac: boolean): void {
  const used = new Map<string, string>();
  for (const [id, title] of commands) {
    const key = binding(settings, id, mac);
    if (!key) continue;
    if (
      [
        "Mod+KeyC",
        "Mod+KeyV",
        "Mod+KeyX",
        "Mod+KeyA",
        "Mod+KeyZ",
        "Mod+Shift+KeyZ",
        "Mod+KeyS",
        "Mod+KeyQ",
        "Mod+KeyH",
      ].includes(key)
    )
      throw new Error(tx("{p0}：此快捷键由系统或编辑器使用。", { p0: tx(title) }));
    if (used.has(key))
      throw new Error(tx("{p0} 与 {p1} 的快捷键重复。", { p0: tx(title), p1: tx(used.get(key)!) }));
    used.set(key, title);
  }
}
export function sessionLink(id: string): string {
  return `uterm://session/${encodeURIComponent(id)}`;
}
export function sessionFromLink(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "uterm:" ||
    url.hostname !== "session" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname)
  )
    throw new Error(tx("会话链接无效。"));
  return url.pathname.slice(1);
}

export function availableAgents(settings: Settings, detected: readonly string[]): string[] {
  return detected.filter((id) => settings.enabledAgents.includes(id));
}
