import { tx } from "./i18n.ts";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { themes } from "./themes";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { defaults, readSettings, settingsKey, validateShortcuts } from "./settings";
import type { Settings } from "./settings";
import { activeLanguage, setUiLanguage } from "./i18n";
import { interfacePalette, isLightInterfaceTheme } from "./interface-themes";
import { canonicalStateActive, persistSettings, sharedSettings } from "./shared-state";
const Context = createContext<{
  settings: Settings;
  light: boolean;
  error: string;
  save: (value: Settings, mac: boolean) => Promise<void>;
  resizeFont: (
    key: "fontSize" | "fileFontSize" | "gitDiffFontSize",
    delta: number,
    mac: boolean,
  ) => Promise<void>;
  reset: () => Promise<void>;
} | null>(null);
export interface ContentSettingsAdapter {
  settings: Settings;
  update: (patch: Partial<Settings>) => Promise<Settings>;
  adjust: (
    key: "fontSize" | "fileFontSize" | "gitDiffFontSize",
    delta: number,
  ) => Promise<Settings>;
}
export function SettingsProvider({
  children,
  content,
}: {
  children: ReactNode;
  content?: ContentSettingsAdapter;
}) {
  const [initial] = useState(() => {
    try {
      return {
        settings:
          content?.settings ?? sharedSettings() ?? readSettings(localStorage.getItem(settingsKey)),
        error: "",
      };
    } catch (reason) {
      return { settings: defaults, error: String(reason) };
    }
  });
  const [settings, setSettings] = useState(initial.settings);
  const currentSettings = useRef(settings);
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
    root.style.setProperty("--ui-active-icon", settings.activeIconColor || palette.accent);
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
    root.style.setProperty("--file-font-size", `${settings.fileFontSize}px`);
    root.style.setProperty("--git-diff-font-size", `${settings.gitDiffFontSize}px`);
    root.style.setProperty("--row-padding", `${settings.rowPadding}px`);
    root.style.setProperty("--window-padding", `${settings.windowPadding}px`);
  }, [settings, light]);
  useEffect(() => {
    if (isTauri())
      void invoke("window_appearance", { blur: settings.blur })
        .then(() => setAppearanceError(""))
        .catch((reason) => setAppearanceError(tx("背景效果未应用：{p0}", { p0: String(reason) })));
  }, [settings.blur]);
  async function save(value: Settings, mac: boolean) {
    if (error) throw new Error(error);
    const checked = readSettings(JSON.stringify(value));
    validateShortcuts(checked, mac);
    const previous = currentSettings.current;
    const patch = Object.fromEntries(
      Object.entries(checked).filter(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key as keyof Settings]),
      ),
    );
    const saved = content
      ? await content.update(patch)
      : canonicalStateActive()
        ? await persistSettings((current) => {
            const next = readSettings(JSON.stringify({ ...current, ...patch }));
            validateShortcuts(next, mac);
            return next;
          })
        : checked;
    if (!content && !canonicalStateActive())
      localStorage.setItem(settingsKey, JSON.stringify(saved));
    currentSettings.current = saved;
    setSettings(saved);
  }
  async function reset() {
    if (content) {
      const saved = await content.update({ ...defaults, shortcuts: {} });
      currentSettings.current = saved;
      setSettings(saved);
      setError("");
      return;
    }
    const old = canonicalStateActive() ? null : localStorage.getItem(settingsKey);
    if (old) localStorage.setItem(`${settingsKey}.backup`, old);
    if (canonicalStateActive()) await persistSettings(() => ({ ...defaults, shortcuts: {} }));
    else localStorage.setItem(settingsKey, JSON.stringify(defaults));
    const checked = { ...defaults, shortcuts: {} };
    currentSettings.current = checked;
    setSettings(checked);
    setError("");
  }
  async function resizeFont(
    key: "fontSize" | "fileFontSize" | "gitDiffFontSize",
    delta: number,
    mac: boolean,
  ) {
    if (content) {
      const saved = await content.adjust(key, delta);
      currentSettings.current = saved;
      setSettings(saved);
      return;
    }
    if (canonicalStateActive()) {
      const saved = await persistSettings((current) => {
        const next = { ...current, [key]: Math.max(10, Math.min(32, current[key] + delta)) };
        validateShortcuts(next, mac);
        return next;
      });
      currentSettings.current = saved;
      setSettings(saved);
      return;
    }
    const current = currentSettings.current;
    await save({ ...current, [key]: Math.max(10, Math.min(32, current[key] + delta)) }, mac);
  }
  return (
    <Context.Provider
      value={{ settings, light, error: error || appearanceError, save, resizeFont, reset }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSettings() {
  const context = useContext(Context);
  if (!context) throw new Error("Settings provider is missing");
  return context;
}
