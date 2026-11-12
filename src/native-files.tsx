import { useEffect, useState } from "react";
import { FilePanel, type FileMode } from "./components/FilePanel";
import { NativeInspectorActions } from "./components/NativeInspectorActions";
import { contentInvoke, listenContent } from "./lib/content-host";
import { localizeMessage, tx } from "./lib/i18n";
import { useSettings } from "./lib/SettingsContext";
import {
  installFileClipboardWriter,
  restoreFileClipboard,
  type FileClipboard,
} from "./lib/file-clipboard";

interface FilesContext {
  mode: FileMode;
  request: number;
  clipboard: FileClipboard;
}

export function NativeFiles({ directory }: { directory: string }) {
  const settings = useSettings();
  const [context, setContext] = useState<FilesContext | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let refreshRevision = 0;
    let hydratedClipboard = false;
    const stops: (() => void)[] = [];
    stops.push(
      installFileClipboardWriter(
        (value) => contentInvoke("files_clipboard", { value }),
        (reason) => {
          if (!disposed) setError(tx("复制失败：{p0}", { p0: localizeMessage(String(reason)) }));
        },
      ),
    );
    const refresh = async () => {
      const revision = ++refreshRevision;
      try {
        const value = await contentInvoke<FilesContext>("files_context");
        if (!disposed && revision === refreshRevision) {
          if (!hydratedClipboard) {
            restoreFileClipboard(value.clipboard ?? null);
            hydratedClipboard = true;
          }
          setContext(value);
          setError("");
        }
      } catch (reason) {
        if (!disposed && revision === refreshRevision) setError(String(reason));
      }
    };
    for (const [kind, receive] of [
      ["files-frozen", (value: unknown) => setFrozen(value === true)],
      ["files-mode-changed", () => void refresh()],
      [
        "files-settings-changed",
        () => void settings.reload().catch((reason) => setError(String(reason))),
      ],
    ] as const) {
      void listenContent(kind, receive)
        .then((stop) => {
          if (disposed) stop();
          else stops.push(stop);
        })
        .catch((reason) => {
          if (!disposed) setError(String(reason));
        });
    }
    void refresh();
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [directory]);
  async function command(method: string, params: Record<string, unknown>) {
    try {
      await contentInvoke(method, params);
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }
  return (
    <main className="native-content native-files">
      {error && <p role="alert">{localizeMessage(error)}</p>}
      {context ? (
        <fieldset disabled={frozen}>
          <FilePanel
            directory={directory}
            paused={frozen}
            resizeHandle={null}
            headerActions={
              <NativeInspectorActions
                active="files"
                command={(kind) => void command("files_toolbar", { kind })}
              />
            }
            mode={context.mode}
            request={context.request}
            setMode={(mode) => void command("files_mode", { mode })}
            open={(path, line) => void command("content_open_file", { path, line: line ?? 0 })}
            beforeMutation={(action) => action()}
          />
        </fieldset>
      ) : (
        <p role="status">{tx("加载中…")}</p>
      )}
    </main>
  );
}
