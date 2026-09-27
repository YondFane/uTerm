const paperPalette = {
  canvas: "#fcfaf5",
  sidebar: "#f1ece1",
  surface: "#fffefb",
  hover: "#e8e0d1",
  border: "#d7cbb8",
  text: "#322d25",
  muted: "#716451",
  accent: "#87502f",
};
const skyPalette = {
  canvas: "#f5faff",
  sidebar: "#e8f1fa",
  surface: "#ffffff",
  hover: "#d8e8f5",
  border: "#bdd1e3",
  text: "#22364b",
  muted: "#536b81",
  accent: "#22628e",
};

export const interfaceThemes = [
  {
    id: "black",
    name: "暗黑",
    description: "纯黑与银灰，简洁沉浸。",
    dark: {
      canvas: "#101010",
      sidebar: "#090909",
      surface: "#191919",
      hover: "#272727",
      border: "#363636",
      text: "#f2f2f2",
      muted: "#ababab",
      accent: "#d4d4d4",
    },
    light: {
      canvas: "#f7f7f7",
      sidebar: "#ededed",
      surface: "#ffffff",
      hover: "#e0e0e0",
      border: "#cccccc",
      text: "#202020",
      muted: "#626262",
      accent: "#404040",
    },
  },
  {
    id: "sand",
    name: "砂岩",
    description: "暖灰与砂金，安静专注。",
    dark: {
      canvas: "#211f1d",
      sidebar: "#1b1918",
      surface: "#2a2724",
      hover: "#35312d",
      border: "#403b35",
      text: "#f0ebe3",
      muted: "#ada59a",
      accent: "#d9b987",
    },
    light: {
      canvas: "#faf8f5",
      sidebar: "#f0ede7",
      surface: "#ffffff",
      hover: "#e8e2d8",
      border: "#d9d2c7",
      text: "#302b25",
      muted: "#70665a",
      accent: "#866126",
    },
  },
  {
    id: "ocean",
    name: "深海",
    description: "深蓝与冰蓝，清晰利落。",
    dark: {
      canvas: "#111923",
      sidebar: "#0c131c",
      surface: "#1a2635",
      hover: "#253448",
      border: "#34465d",
      text: "#e5edf7",
      muted: "#a0b2ca",
      accent: "#8dbfff",
    },
    light: {
      canvas: "#f4f7fc",
      sidebar: "#e8eef7",
      surface: "#ffffff",
      hover: "#dae5f4",
      border: "#c6d3e5",
      text: "#203047",
      muted: "#536985",
      accent: "#245f9e",
    },
  },
  {
    id: "moss",
    name: "青苔",
    description: "墨绿与薄荷，柔和沉静。",
    dark: {
      canvas: "#141d19",
      sidebar: "#101713",
      surface: "#1e2b24",
      hover: "#2b3c32",
      border: "#3c5144",
      text: "#e6efe8",
      muted: "#a5b8aa",
      accent: "#91ceb0",
    },
    light: {
      canvas: "#f5f8f4",
      sidebar: "#e8efe5",
      surface: "#ffffff",
      hover: "#dce8d8",
      border: "#c8d6c3",
      text: "#27382c",
      muted: "#5a6e5d",
      accent: "#326c4d",
    },
  },
  {
    id: "paper",
    name: "纸白",
    description: "暖白与陶棕，温润清爽。",
    dark: paperPalette,
    light: paperPalette,
  },
  {
    id: "sky",
    name: "晴空",
    description: "冷白与天蓝，明亮通透。",
    dark: skyPalette,
    light: skyPalette,
  },
] as const;

export type InterfaceThemeId = (typeof interfaceThemes)[number]["id"];

export function isLightInterfaceTheme(id: InterfaceThemeId, light: boolean) {
  return light || id === "paper" || id === "sky";
}

export function interfacePalette(id: InterfaceThemeId, light: boolean) {
  const theme = interfaceThemes.find((theme) => theme.id === id) ?? interfaceThemes[0];
  return light ? theme.light : theme.dark;
}
