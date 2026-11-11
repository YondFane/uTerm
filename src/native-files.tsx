import { useEffect, useState } from "react";
import { FilePanel, type FileMode } from "./components/FilePanel";
import { ToolbarIcon } from "./components/SidebarIcon";
import { contentInvoke, listenContent } from "./lib/content-host";
import { localizeMessage, tx } from "./lib/i18n";
import { useSettings } from "./lib/SettingsContext";

interface FilesContext {
  mode: FileMode;
  request: number;
}

export function NativeFiles({ directory }: { directory: string }) {
  const settings = useSettings();
  const [context, setContext] = useState<FilesContext | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const refresh = async () => {
      try {
        const value = await contentInvoke<FilesContext>("files_context");
        if (!disposed) {
          setContext(value);
          setError("");
        }
      } catch (reason) {
        if (!disposed) setError(String(reason));
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
              <div className="inspector-switcher" role="group" aria-label={tx("工具面板")}>
                {(
                  [
                    ["files", "files", tx("文件")],
                    ["git", "git", "Git"],
                    ["github", "github", "GitHub"],
                    ["directory", "folder", tx("工作目录")],
                  ] as const
                ).map(([kind, icon, label]) => (
                  <button
                    key={kind}
                    className="toolbar-icon-button"
                    aria-label={label}
                    title={label}
                    aria-pressed={kind === "files"}
                    onClick={() => void command("files_toolbar", { kind })}
                  >
                    <ToolbarIcon name={icon} />
                  </button>
                ))}
              </div>
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
