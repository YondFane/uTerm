import { tx } from "./i18n.ts";
export interface Theme {
  id: string;
  name: string;
  background: string;
  foreground: string;
  selectionBackground: string;
  cursor: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}
const ansi = {
  black: "#282a36",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#6272a4",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};
export const themes: Theme[] = [
  {
    id: "default-dark",
    name: "uTerm Dark",
    background: "#211f1d",
    foreground: "#f0ebe3",
    selectionBackground: "#584a37",
    cursor: "#d9b987",
    ...ansi,
  },
  {
    id: "default-light",
    name: "uTerm Light",
    background: "#faf8f5",
    foreground: "#302b25",
    selectionBackground: "#e2d5bd",
    cursor: "#866126",
    ...ansi,
    red: "#ba2525",
    green: "#26702a",
    yellow: "#855f00",
    blue: "#275cad",
    magenta: "#913398",
    cyan: "#117b88",
    white: "#555555",
  },
  {
    id: "dracula",
    name: "Dracula",
    background: "#282a36",
    foreground: "#f8f8f2",
    selectionBackground: "#44475a",
    cursor: "#f8f8f2",
    ...ansi,
  },
  {
    id: "nord",
    name: "Nord",
    background: "#2e3440",
    foreground: "#d8dee9",
    selectionBackground: "#434c5e",
    cursor: "#d8dee9",
    ...ansi,
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    background: "#002b36",
    foreground: "#839496",
    selectionBackground: "#073642",
    cursor: "#93a1a1",
    ...ansi,
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    background: "#fdf6e3",
    foreground: "#657b83",
    selectionBackground: "#eee8d5",
    cursor: "#586e75",
    ...ansi,
    red: "#dc322f",
    green: "#668000",
    yellow: "#946f00",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#19877e",
  },
  {
    id: "gruvbox",
    name: "Gruvbox Dark",
    background: "#282828",
    foreground: "#ebdbb2",
    selectionBackground: "#504945",
    cursor: "#ebdbb2",
    ...ansi,
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    background: "#1a1b26",
    foreground: "#c0caf5",
    selectionBackground: "#33467c",
    cursor: "#c0caf5",
    ...ansi,
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
  },
];
export function importTheme(source: string, name: string): Theme {
  if (source.length > 32000 || !name.trim() || name.length > 80)
    throw new Error(tx("主题名称或内容无效。"));
  const value: Theme = {
    ...themes[0],
    id: `custom-${encodeURIComponent(name.trim().toLowerCase())}`,
    name: name.trim(),
  };
  const palette: (keyof Theme)[] = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ];
  let recognized = 0;
  for (const line of source.split("\n")) {
    const match = line
      .trim()
      .match(/^(background|foreground|cursor-color|selection-background|palette)\s*=\s*(.*)$/);
    if (!match) continue;
    let target = (
      {
        background: "background",
        foreground: "foreground",
        "cursor-color": "cursor",
        "selection-background": "selectionBackground",
      } as Record<string, keyof Theme>
    )[match[1]];
    let color = match[2].trim();
    if (match[1] === "palette") {
      const pair = color.match(/^(\d+)\s*=\s*(.+)$/);
      if (!pair || !palette[Number(pair[1])]) throw new Error(tx("主题调色板序号无效。"));
      target = palette[Number(pair[1])];
      color = pair[2];
    }
    if (!/^#?[a-f0-9]{6}$/i.test(color)) throw new Error(tx("主题颜色应为六位十六进制。"));
    value[target] = `#${color.replace("#", "")}`;
    recognized++;
  }
  if (!recognized) throw new Error(tx("没有找到 Ghostty 主题颜色。"));
  return value;
}
export function validTheme(value: Theme): boolean {
  return (
    typeof value?.id === "string" &&
    value.id.startsWith("custom-") &&
    typeof value.name === "string" &&
    value.name.length <= 80 &&
    Object.keys(themes[0])
      .filter((key) => !["id", "name"].includes(key))
      .every((key) => /^#[a-f0-9]{6}$/i.test(value[key as keyof Theme]))
  );
}
