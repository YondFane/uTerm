import { defaults } from "./settings.ts";

export const interfaceFonts = [
  ["系统默认", defaults.interfaceFont],
  ["Arial", "Arial, sans-serif"],
  ["Helvetica Neue", '"Helvetica Neue", Arial, sans-serif'],
  ["Segoe UI", '"Segoe UI", sans-serif'],
  ["苹方", '"PingFang SC", sans-serif'],
  ["微软雅黑", '"Microsoft YaHei", sans-serif'],
  ["思源黑体", '"Source Han Sans SC", "Noto Sans CJK SC", sans-serif'],
] as const;
export const terminalFonts = [
  ["系统默认等宽字体", defaults.fontFamily],
  ...[
    "Cascadia Code",
    "Cascadia Mono",
    "SFMono-Regular",
    "Menlo",
    "Monaco",
    "Consolas",
    "JetBrains Mono",
    "Fira Code",
    "Source Code Pro",
  ].map((name) => [name, `"${name}", monospace`] as const),
] as const;
