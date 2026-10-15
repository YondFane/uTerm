import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import {
  displayDirectory,
  fileTarget,
  remoteDirectory,
  sshError,
  type RemoteRoot,
} from "../lib/file-target";
import {
  dismissTransfer,
  startRemoteTransfer,
  subscribeTransfers,
  transferSnapshot,
} from "../lib/remote-transfers";
import type { SshTarget } from "../lib/workspace";
import { FilePanel } from "./FilePanel";

function transferSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function RemoteFiles({
  connection,
  directory,
  onRoot,
  open,
  beforeMutation,
  resizeHandle,
  headerActions,
  newTerminal,
}: {
  connection: SshTarget;
  directory?: string;
  onRoot: (directory: string) => void;
  open: (directory: string, path: string) => void;
  beforeMutation: (directory: string, action: () => void) => void;
  resizeHandle: ReactNode;
  headerActions: ReactNode;
  newTerminal: () => void;
}) {
  useUiLanguage();
  const [root, setRoot] = useState<RemoteRoot | null>(() =>
    directory ? (fileTarget(directory) as { kind: "ssh"; root: RemoteRoot }).root : null,
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [overwrite, setOverwrite] = useState(false);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const initial = useRef(root);
  const rootCallback = useRef(onRoot);
  rootCallback.current = onRoot;
  useEffect(() => {
    if (initial.current && retry === 0) return;
    let disposed = false;
    setLoading(true);
    setError("");
    invoke<RemoteRoot>("ssh_files_open", { connection, expected: initial.current })
      .then((value) => {
        if (disposed) return;
        initial.current = value;
        setRoot(value);
        rootCallback.current(remoteDirectory(value));
      })
      .catch((error) => {
        if (!disposed) setError(sshError(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [retry]);
  const key = root ? remoteDirectory(root) : "";
  return (
    <div className="file-panel remote-files">
      {resizeHandle}
      <header className="inspector-header">{headerActions}</header>
      <div className="remote-file-status">
        <span title={key ? displayDirectory(key) : connection.host}>{connection.host}</span>
        <button
          disabled={loading}
          onClick={async () => {
            try {
              await invoke("ssh_files_disconnect", { connectionId: connection.connection_id });
              setRetry((value) => value + 1);
            } catch (error) {
              setError(sshError(error));
            }
          }}
        >
          {tx("重新连接")}
        </button>
        <button
          disabled={!root || loading}
          onClick={() => {
            beforeMutation(key, () => {
              void invoke("ssh_files_disconnect", { connectionId: connection.connection_id })
                .then(() => setRoot(null))
                .catch((error) => setError(sshError(error)));
            });
          }}
        >
          {tx("断开文件连接")}
        </button>
        <button onClick={newTerminal}>{tx("SSH 终端")}</button>
        <label>
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(event) => setOverwrite(event.target.checked)}
          />
          {tx("上传时覆盖同名文件")}
        </label>
      </div>
      {loading && <p role="status">{tx("正在连接远程文件…")}</p>}
      {error && (
        <p className="remote-file-error" role="alert">
          {error}
        </p>
      )}
      {root ? (
        <FilePanel
          key={`${key}:${revision}`}
          directory={key}
          mode="tree"
          request={0}
          setMode={() => {}}
          resizeHandle={null}
          headerActions={null}
          open={(path) => open(key, path)}
          beforeMutation={(action) => beforeMutation(key, action)}
          transfer={(path, direction) => {
            const start = () => {
              void startRemoteTransfer(root, path, direction, overwrite).then((success) => {
                if (success && mounted.current) setRevision((value) => value + 1);
              });
            };
            if (direction === "upload") beforeMutation(key, start);
            else start();
          }}
        />
      ) : null}
    </div>
  );
}
export function RemoteTransferShelf() {
  useUiLanguage();
  const tasks = useSyncExternalStore(subscribeTransfers, transferSnapshot);
  const [exitPending, setExitPending] = useState(false);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("ssh-transfer-exit-request", () => setExitPending(true))
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch((error) => setError(sshError(error)));
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (exitPending) dialog.current?.showModal();
    else dialog.current?.close();
  }, [exitPending]);
  return (
    <>
      {tasks.length > 0 && (
        <section className="remote-transfer-shelf" aria-label={tx("文件传输")}>
          {tasks.map((task) => (
            <div key={task.id} className="remote-transfer-row">
              <span title={task.name}>
                {task.direction === "upload" ? tx("上传文件") : tx("下载文件")}: {task.name}
              </span>
              <progress value={task.completed} max={task.total || 1} aria-label={tx("传输进度")} />
              <small>{`${transferSize(task.completed)} / ${transferSize(task.total)}`}</small>
              <span>
                {task.state === "done"
                  ? tx("传输完成")
                  : task.state === "cancelled"
                    ? tx("已取消")
                    : task.state === "error"
                      ? tx("失败")
                      : tx("传输中")}
              </span>
              {task.state === "running" ? (
                <button
                  onClick={() =>
                    void invoke("ssh_transfer_cancel", { id: task.id }).catch((error) =>
                      setError(sshError(error)),
                    )
                  }
                >
                  {tx("取消")}
                </button>
              ) : (
                <button onClick={() => dismissTransfer(task.id)}>{tx("关闭")}</button>
              )}
              {task.error && task.state === "error" && <p role="alert">{task.error}</p>}
            </div>
          ))}
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      <dialog
        ref={dialog}
        className="ssh-dialog"
        onCancel={(event) => {
          event.preventDefault();
          if (!cancelling) setExitPending(false);
        }}
      >
        <h2>{tx("文件仍在传输")}</h2>
        <p>{tx("可以等待传输完成，或取消传输后退出。未保存文件仍会通过保存保护。")}</p>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button disabled={cancelling} onClick={() => setExitPending(false)}>
            {tx("继续等待")}
          </button>
          <button
            disabled={cancelling}
            onClick={() => {
              setCancelling(true);
              void invoke("ssh_transfer_cancel_all", { exit: true })
                .then(() => setExitPending(false))
                .catch((error) => setError(sshError(error)))
                .finally(() => setCancelling(false));
            }}
          >
            {tx("取消传输并退出")}
          </button>
        </div>
      </dialog>
    </>
  );
}
