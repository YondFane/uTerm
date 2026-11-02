import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsProvider } from "./lib/SettingsContext";
import { App } from "./App";
import "./styles.css";
import { activeLanguage, setUiLanguage } from "./lib/i18n";
import { StateRecovery } from "./components/StateRecovery";
import { defaults, readSettings, settingsKey } from "./lib/settings";
import { suppressBrowserContextMenu } from "./lib/context-menu";
import { isTauri } from "@tauri-apps/api/core";
import { initializeSharedState, sharedSettings } from "./lib/shared-state";

suppressBrowserContextMenu(window);

try {
  setUiLanguage(activeLanguage(readSettings(localStorage.getItem(settingsKey)).language));
} catch {
  setUiLanguage(activeLanguage(defaults.language));
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

async function start() {
  if (isTauri()) {
    try {
      await initializeSharedState();
      setUiLanguage(activeLanguage(sharedSettings()?.language ?? defaults.language));
    } catch (reason) {
      createRoot(root!).render(<StateRecovery reason={reason} />);
      return;
    }
  }
  createRoot(root!).render(
    <StrictMode>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </StrictMode>,
  );
}
void start();
