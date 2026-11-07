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
import { coreRequest, initializeSharedState, sharedSettings } from "./lib/shared-state";
import { EditorDraftHandoff, enableSharedEditorRecovery } from "./lib/editor-draft-handoff";
import { EditorDraftRecovery } from "./components/EditorDraftRecovery";

suppressBrowserContextMenu(window);

try {
  setUiLanguage(activeLanguage(readSettings(localStorage.getItem(settingsKey)).language));
} catch {
  setUiLanguage(activeLanguage(defaults.language));
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const application = createRoot(root);

async function start() {
  const qa = import.meta.env.VITE_UTERM_STATE_QA === "1" ? await import("./qa/shared-state") : null;
  await qa?.prepare();
  if (isTauri()) {
    try {
      await initializeSharedState();
      setUiLanguage(activeLanguage(sharedSettings()?.language ?? defaults.language));
    } catch (reason) {
      application.render(<StateRecovery reason={reason} />);
      void qa?.run(true);
      return;
    }
    let handoff: EditorDraftHandoff | undefined;
    try {
      handoff = new EditorDraftHandoff(coreRequest, localStorage);
      enableSharedEditorRecovery(await handoff.initialize(), handoff.legacy);
    } catch (reason) {
      application.render(
        <EditorDraftRecovery
          reason={reason}
          handoff={handoff}
          ready={(snapshot) => {
            enableSharedEditorRecovery(snapshot, handoff?.legacy ?? null);
            renderApplication();
          }}
        />,
      );
      void qa?.reportEditorRecoveryFailure(reason);
      return;
    }
  }
  renderApplication();
  function renderApplication() {
    application.render(
      <StrictMode>
        <SettingsProvider>
          <App />
        </SettingsProvider>
      </StrictMode>,
    );
    void qa?.run(false);
  }
}
void start();
