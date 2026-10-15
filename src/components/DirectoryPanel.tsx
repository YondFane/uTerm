import { localizeMessage } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { tx } from "../lib/i18n";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { clipboardPath } from "../lib/file-document";
import { SidebarIcon, ToolbarIcon } from "./SidebarIcon";

export function DirectoryPanel({
  directory,
  platform,
  resizeHandle,
  headerActions,
}: {
  directory: string;
  platform: string;
  resizeHandle: ReactNode;
  headerActions: ReactNode;
}) {
  useUiLanguage();

  const [tools, setTools] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    void invoke<typeof tools>("directory_tools")
      .then((value) => {
        if (!disposed) setTools(value);
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, []);
  async function open(target: string) {
    setError("");
    setBusy(true);
    try {
      await invoke("directory_open", { directory, target });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="file-panel" aria-label={tx("工作目录面板")}>
      {resizeHandle}
      <header className="inspector-header">{headerActions}</header>
      <div className="directory-actions">
        <h3>{tx("工作目录")}</h3>
        <button
          onClick={() => {
            void navigator.clipboard
              .writeText(clipboardPath(directory))
              .then(() => {
                setCopied(true);
                setError("");
              })
              .catch((reason) => setError(String(reason)));
          }}
        >
          <ToolbarIcon name="files" />
          {copied ? tx("已拷贝路径") : tx("拷贝路径")}
        </button>
        <button disabled={busy} onClick={() => void open("reveal")}>
          <SidebarIcon name="folder" />
          {platform === "macos"
            ? tx("在“访达”中显示")
            : platform === "windows"
              ? tx("在文件资源管理器中显示")
              : tx("在文件管理器中显示")}
        </button>
        <button disabled={busy} onClick={() => void open("github")}>
          <ToolbarIcon name="github" />
          {tx("在 GitHub 上查看")}
        </button>
        {tools.map((tool) => (
          <button key={tool.id} disabled={busy} onClick={() => void open(tool.id)}>
            <ToolbarIcon name="command" />
            {tx("在 {p0} 中打开", { p0: tool.name })}
          </button>
        ))}
        {error && (
          <p role="alert" className="inspector-message">
            {localizeMessage(error)}
          </p>
        )}
      </div>
      <footer className="file-panel-footer" title={directory}>
        {directory}
      </footer>
    </aside>
  );
}
