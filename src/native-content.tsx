import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { FileEditor, UnsavedDialog } from "./components/FileEditor";
import { SettingsProvider } from "./lib/SettingsContext";
import { contentInvoke } from "./lib/content-host";
import { activeLanguage, localizeMessage, setUiLanguage, tx } from "./lib/i18n";
import { readSettings, type Settings } from "./lib/settings";
import { useFileDocument } from "./lib/useFileDocument";
import "./styles.css";
import "./native-content.css";

interface Context {
  directory: string;
  path: string;
  settings: Settings;
  editable: boolean;
}
function Content({ context }: { context: Context }) {
  const state = useFileDocument(
    10,
    !context.editable,
    context.editable ? context.directory : undefined,
  );
  const editor: ReturnType<typeof useFileDocument> = {
    ...state,
    close: (after, id) =>
      state.close(async () => {
        await after?.();
        await contentInvoke<void>("editor_exit");
      }, id),
  };
  useEffect(() => {
    void editor.open(context.directory, context.path);
  }, [context.directory, context.path]);
  return (
    <main className="native-content">
      {editor.document ? (
        <FileEditor editor={editor} allowPdfAnnotations={false} />
      ) : (
        <p role={editor.error ? "alert" : "status"}>
          {editor.error ? localizeMessage(editor.error) : tx("文件")}
        </p>
      )}
      {context.editable && <UnsavedDialog editor={editor} />}
    </main>
  );
}
async function start() {
  const target = document.getElementById("root");
  if (!target) throw new Error("Missing content root");
  const root = createRoot(target);
  try {
    const context = await contentInvoke<Context>("content_context");
    context.settings = readSettings(JSON.stringify(context.settings));
    setUiLanguage(activeLanguage(context.settings.language));
    const content = {
      settings: context.settings,
      read: async () => {
        const current = await contentInvoke<Context>("content_context");
        return readSettings(JSON.stringify(current.settings));
      },
      update: async (patch: Partial<Settings>) =>
        readSettings(JSON.stringify(await contentInvoke("content_settings_patch", { patch }))),
      adjust: async (key: "fontSize" | "fileFontSize" | "gitDiffFontSize", delta: number) =>
        readSettings(JSON.stringify(await contentInvoke("content_font_adjust", { key, delta }))),
    };
    root.render(
      <SettingsProvider content={content}>
        <Content context={context} />
      </SettingsProvider>,
    );
  } catch (reason) {
    root.render(<p role="alert">{localizeMessage(String(reason))}</p>);
  }
}
void start();
