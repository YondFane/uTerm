import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsProvider } from "./lib/SettingsContext";
import { App } from "./App";
import "./styles.css";
import { activeLanguage, setUiLanguage } from "./lib/i18n";
import { defaults, readSettings, settingsKey } from "./lib/settings";

try {
  setUiLanguage(activeLanguage(readSettings(localStorage.getItem(settingsKey)).language));
} catch {
  setUiLanguage(activeLanguage(defaults.language));
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

createRoot(root).render(
  <StrictMode>
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </StrictMode>,
);
