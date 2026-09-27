import { tx } from "./i18n.ts";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { themes } from "./themes";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { defaults, readSettings, settingsKey, validateShortcuts } from "./settings";
import type { Settings } from "./settings";
import { activeLanguage, setUiLanguage } from "./i18n";
import { interfacePalette, isLightInterfaceTheme } from "./interface-themes";
const Context = createContext<{
  settings: Settings;
  light: boolean;
  error: string;
  save: (value: Settings, mac: boolean) => void;
  reset: () => void;
} | null>(null);
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => {
    try {
      return { settings: readSettings(localStorage.getItem(settingsKey)), error: "" };
    } catch (reason) {
      return { settings: defaults, error: String(reason) };
    }
  });
  const [settings, setSettings] = useState(initial.settings);
  useEffect(() => {
    setUiLanguage(activeLanguage(settings.language));
  }, [settings.language]);
  const [error, setError] = useState(initial.error);
  const [appearanceError, setAppearanceError] = useState("");
  const [systemLight, setSystemLight] = useState(
    () => matchMedia("(prefers-color-scheme: light)").matches,
  );
  const light =
    settings.appearance === "light" || (settings.appearance === "system" && systemLight);
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: light)");
    const change = () => setSystemLight(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.lang = activeLanguage(settings.language);
    const interfaceLight = isLightInterfaceTheme(settings.interfaceTheme, light);
    root.dataset.appearance = interfaceLight ? "light" : "dark";
    root.dataset.interfaceTheme = settings.interfaceTheme;
    const palette = interfacePalette(settings.interfaceTheme, light);
    for (const [key, value] of Object.entries(palette))
      root.style.setProperty(`--ui-${key}`, value);
    root.style.setProperty("--ui-selected", palette.accent + (interfaceLight ? "12" : "16"));
    const theme =
      [...themes, ...settings.customThemes].find(
        (theme) => theme.id === (light ? settings.lightTheme : settings.darkTheme),
      ) ?? themes[0];
    root.style.setProperty(
      "--window-background",
      `rgba(${parseInt(theme.background.slice(1, 3), 16)}, ${parseInt(theme.background.slice(3, 5), 16)}, ${parseInt(theme.background.slice(5, 7), 16)}, ${settings.opacity})`,
    );
    root.style.setProperty("--theme-background", theme.background);
    root.style.setProperty("--theme-foreground", theme.foreground);
    root.style.setProperty("--window-opacity", String(settings.opacity));
    root.style.setProperty("--interface-font", settings.interfaceFont);
    root.style.setProperty("--interface-size", `${settings.interfaceSize}px`);
    root.style.setProperty("--row-padding", `${settings.rowPadding}px`);
    root.style.setProperty("--window-padding", `${settings.windowPadding}px`);
  }, [settings, light]);
  useEffect(() => {
    if (isTauri())
      void invoke("window_appearance", { blur: settings.blur })
        .then(() => setAppearanceError(""))
        .catch((reason) => setAppearanceError(tx("背景效果未应用：{p0}", { p0: String(reason) })));
  }, [settings.blur]);
  function save(value: Settings, mac: boolean) {
    if (error) throw new Error(error);
    const checked = readSettings(JSON.stringify(value));
    validateShortcuts(checked, mac);
    localStorage.setItem(settingsKey, JSON.stringify(checked));
    setSettings(checked);
  }
  function reset() {
    const old = localStorage.getItem(settingsKey);
    if (old) localStorage.setItem(`${settingsKey}.backup`, old);
    localStorage.setItem(settingsKey, JSON.stringify(defaults));
    setSettings({ ...defaults, shortcuts: {} });
    setError("");
  }
  return (
    <Context.Provider value={{ settings, light, error: error || appearanceError, save, reset }}>
      {children}
    </Context.Provider>
  );
}
export function useSettings() {
  const context = useContext(Context);
  if (!context) throw new Error("Settings provider is missing");
  return context;
}
