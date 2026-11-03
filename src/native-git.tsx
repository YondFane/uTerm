import { useState } from "react";
import { GitPanel } from "./components/GitPanel";
import { contentInvoke } from "./lib/content-host";
import { localizeMessage, tx } from "./lib/i18n";

export function NativeGit({ directory }: { directory: string }) {
  const [expanded, setExpanded] = useState(false);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  async function openFile(path: string) {
    try {
      await contentInvoke("content_open_file", { path });
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }
  return (
    <main className="native-content native-git" data-expanded={expanded || undefined}>
      <div className="native-git-layout">
        <GitPanel
          directory={directory}
          resizeHandle={null}
          headerActions={
            <>
              <strong>Git</strong>
              <span className="native-git-directory" title={directory}>
                {directory}
              </span>
              <button
                disabled={busy}
                onClick={() =>
                  void contentInvoke("editor_exit").catch((reason) => setError(String(reason)))
                }
              >
                {tx("关闭")}
              </button>
            </>
          }
          expanded={expanded}
          onExpandedChange={setExpanded}
          diffTarget={target}
          onOpenFile={(path) => void openFile(path)}
          onBusyChange={setBusy}
          refreshRevision={revision}
          onChanged={() => setRevision((value) => value + 1)}
          allowFavorites={false}
        />
        <section className="native-git-diff" ref={setTarget} hidden={!expanded} />
      </div>
      {error && (
        <p role="alert" className="inspector-message">
          {localizeMessage(error)}
        </p>
      )}
    </main>
  );
}
