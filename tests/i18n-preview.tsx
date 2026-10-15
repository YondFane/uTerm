import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { SettingsProvider } from "../src/lib/SettingsContext";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { defaults, settingsKey } from "../src/lib/settings";
import { setUiLanguage } from "../src/lib/i18n";
import { emptyWorkspace } from "../src/lib/workspace";
import "../src/styles.css";
if (!localStorage.getItem(settingsKey))
  localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
setUiLanguage(
  JSON.parse(localStorage.getItem(settingsKey)!).language === "zh-Hans" ? "zh-Hans" : "en",
);
let autostart = false;
mockIPC((cmd, args) => {
  if (cmd === "autostart_configure") {
    if (typeof args.enabled === "boolean") autostart = args.enabled;
    return autostart;
  }
  return { enabled: false, port: 0, directory: "", endpoint: "" };
});
const noop = () => {};
createRoot(document.getElementById("root")!).render(
  <SettingsProvider>
    <SettingsPanel
      runtime={{
        platform: "windows",
        architecture: "x86_64",
        version: "0.1.0",
        home: "",
        agents: ["codex"],
        agent_definitions: [],
        debug: true,
        chat_directory: "",
      }}
      updates={{
        available: { enabled: false, version: "", notes: null, downloaded: false },
        phase: "idle",
        error: "",
        progress: { downloaded: 0, total: null },
        check: async () => {},
        download: async () => {},
        install: async () => {},
      }}
      close={noop}
      reloadAgents={async () => {}}
      workspace={emptyWorkspace()}
      updateWorkspace={noop}
    />
  </SettingsProvider>,
);
