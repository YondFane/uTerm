import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileEditor, UnsavedDialog } from "./components/FileEditor";
import { SettingsProvider, useSettings } from "./lib/SettingsContext";
import { contentInvoke, listenContent } from "./lib/content-host";
import { activeLanguage, localizeMessage, setUiLanguage, tx } from "./lib/i18n";
import { readSettings, type Settings } from "./lib/settings";
import { isDirty } from "./lib/file-document";
import { useFileDocument } from "./lib/useFileDocument";
import "./styles.css";
import "./native-content.css";
import "./assets/fonts/fonts.css";
import { BundledFontReady } from "./components/BundledFontReady";
import { NativeGit } from "./native-git";
import { NativeDatabase } from "./native-database";
import { NativeRedis } from "./native-redis";
import { NativeGitHubPR } from "./native-github-pr";
import { NativeGitHub } from "./native-github";
import { NativeFiles } from "./native-files";
import { NativeSshQuick } from "./native-ssh-quick";

interface Context {
  kind?: "file" | "files" | "git" | "github" | "database" | "redis" | "ssh-quick" | "github-pr";
  directory: string;
  path: string;
  line?: number;
  settings: Settings;
  editable: boolean;
  embedded?: boolean;
}
function ContentFontCommands({ kind }: { kind: Context["kind"] }) {
  const { resizeFont, reload } = useSettings();
  const resize = useRef(resizeFont);
  resize.current = resizeFont;
  const [error, setError] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const reloadSettings = useRef(reload);
  reloadSettings.current = reload;
  useEffect(() => {
    let disposed = false;
    const subscription = listenContent("content-settings-changed", () => {
      void reloadSettings
        .current()
        .then(() => {
          if (!disposed) setSettingsError("");
        })
        .catch((reason) => {
          if (!disposed) setSettingsError(String(reason));
        });
    }).catch((reason) => {
      if (!disposed) setSettingsError(String(reason));
    });
    return () => {
      disposed = true;
      void subscription.then((stop) => stop?.());
    };
  }, []);
  useEffect(() => {
    if (kind && kind !== "file" && kind !== "git") return;
    let disposed = false;
    const subscription = listenContent<number>("content-font-adjust", (delta) => {
      if (delta !== 1 && delta !== -1) return;
      const eligible =
        kind === "git"
          ? document.querySelector(".git-diff pre")
          : document.querySelector(".code-editor-host, .markdown-preview");
      if (!eligible || document.querySelector(".html-preview, dialog[open]")) return;
      void resize
        .current(kind === "git" ? "gitDiffFontSize" : "fileFontSize", delta, true)
        .then(() => {
          if (!disposed) setError("");
        })
        .catch((reason) => {
          if (!disposed) setError(String(reason));
        });
    }).catch((reason) => {
      if (!disposed) setError(String(reason));
      return undefined;
    });
    return () => {
      disposed = true;
      void subscription.then((remove) => remove?.());
    };
  }, [kind]);
  return error || settingsError ? (
    <p role="alert" className="native-content-command-error">
      {error
        ? tx("无法保存字号：{p0}", { p0: localizeMessage(error) })
        : localizeMessage(settingsError)}
    </p>
  ) : null;
}
function Content({ context }: { context: Context }) {
  const state = useFileDocument(
    context.settings.fileTabLimit,
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
  const current = useRef(editor);
  current.current = editor;
  const [focusError, setFocusError] = useState("");
  const [focusRequest, setFocusRequest] = useState({ line: context.line ?? 0, serial: 0 });
  const appliedFocus = useRef(-1);
  const dirty = isDirty(editor.document);
  useEffect(() => {
    if (!context.editable || !context.embedded) return;
    let disposed = false;
    void contentInvoke("content_editor_state", { dirty }).catch((reason) => {
      if (!disposed) setFocusError(String(reason));
    });
    return () => {
      disposed = true;
    };
  }, [dirty, context.editable, context.embedded]);
  useEffect(() => {
    void current.current.open(context.directory, context.path, context.line);
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void listenContent<number>("file-focus-line", (line) => {
      if (Number.isSafeInteger(line) && line > 0) {
        setFocusRequest((previous) => ({ line, serial: previous.serial + 1 }));
      }
    })
      .then(async (remove) => {
        if (disposed) {
          remove();
          return;
        }
        unsubscribe = remove;
        const latest = await contentInvoke<Context>("content_context");
        if (!disposed && Number.isSafeInteger(latest.line) && latest.line! > 0) {
          setFocusRequest((previous) => ({ line: latest.line!, serial: previous.serial + 1 }));
        }
      })
      .catch((reason) => {
        if (!disposed) setFocusError(String(reason));
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [context.directory, context.path]);
  useEffect(() => {
    if (
      !editor.document ||
      editor.pending ||
      editor.transitioning ||
      focusRequest.line <= 0 ||
      appliedFocus.current === focusRequest.serial
    )
      return;
    appliedFocus.current = focusRequest.serial;
    void current.current.open(context.directory, context.path, focusRequest.line);
  }, [editor.document?.id, editor.pending, editor.transitioning, focusRequest]);
  return (
    <main className="native-content">
      {focusError && <p role="alert">{localizeMessage(focusError)}</p>}
      {editor.document ? (
        <FileEditor editor={editor} />
      ) : (
        <p role={editor.error ? "alert" : "status"}>
          {editor.error ? localizeMessage(editor.error) : tx("文件")}
        </p>
      )}
      {context.editable && <UnsavedDialog editor={editor} />}
    </main>
  );
}
function StartupFailure({ reason, retry }: { reason: unknown; retry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <main className="native-content native-content-startup-error">
      <p role="alert">{localizeMessage(String(reason))}</p>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void retry().finally(() => setBusy(false));
        }}
      >
        {tx("重试")}
      </button>
    </main>
  );
}
async function start() {
  const language = activeLanguage(window.utermContentLanguage ?? "system");
  setUiLanguage(language);
  document.documentElement.lang = language;
  const target = document.getElementById("root");
  if (!target) throw new Error("Missing content root");
  const root = createRoot(target);
  async function load() {
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
          <BundledFontReady>
            <ContentFontCommands kind={context.kind} />
            {context.kind === "ssh-quick" ? (
              <NativeSshQuick />
            ) : context.kind === "github-pr" ? (
              <NativeGitHubPR />
            ) : context.kind === "files" ? (
              <NativeFiles directory={context.directory} />
            ) : context.kind === "database" ? (
              <NativeDatabase />
            ) : context.kind === "redis" ? (
              <NativeRedis />
            ) : context.kind === "github" ? (
              <NativeGitHub directory={context.directory} />
            ) : context.kind === "git" ? (
              <NativeGit directory={context.directory} />
            ) : (
              <Content context={context} />
            )}
          </BundledFontReady>
        </SettingsProvider>,
      );
    } catch (reason) {
      root.render(<StartupFailure reason={reason} retry={load} />);
    }
  }
  await load();
}
void start();
