import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { sshError } from "../lib/file-target";
import { validSshHost, type SshConnection } from "../lib/workspace";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";

export function SshConnectionDialog({
  connection,
  save,
  close,
}: {
  connection?: SshConnection;
  save: (connection: SshConnection) => boolean;
  close: () => void;
}) {
  useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(connection?.name ?? "");
  const [host, setHost] = useState(connection?.host ?? "");
  const [os, setOs] = useState<"posix" | "windows">(connection?.os ?? "posix");
  const [root, setRoot] = useState(connection?.root ?? "");
  const [info, setInfo] = useState<{ available: boolean; aliases: string[] } | null>(null);
  const [error, setError] = useState("");
  const backdrop = useDialogBackdrop(close);
  useEffect(() => {
    dialog.current?.showModal();
    let disposed = false;
    invoke<{ available: boolean; aliases: string[] }>("ssh_info")
      .then((value) => {
        if (!disposed) setInfo(value);
      })
      .catch((error) => {
        if (!disposed) setError(sshError(error));
      });
    return () => {
      disposed = true;
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="ssh-dialog"
      {...backdrop}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      aria-labelledby="ssh-dialog-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!validSshHost(host)) {
            setError(tx("请输入有效的 SSH Host 别名。"));
            return;
          }
          if (
            save({
              id: connection?.id ?? crypto.randomUUID(),
              name: name.trim() || host,
              host,
              os,
              root: root.trim(),
              sessions: connection?.sessions ?? [],
              splitGroups: connection?.splitGroups ?? [],
            })
          )
            close();
          else setError(tx("无法保存连接，请检查工作区存储后重试。"));
        }}
      >
        <h2 id="ssh-dialog-title">{connection ? tx("编辑 SSH 连接") : tx("添加 SSH 连接")}</h2>
        <label>
          {tx("名称")}
          <input
            autoFocus
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {tx("SSH Host 别名")}
          <input
            required
            value={host}
            list="ssh-host-aliases"
            maxLength={255}
            onChange={(event) => setHost(event.target.value)}
          />
        </label>
        <datalist id="ssh-host-aliases">
          {info?.aliases.map((alias) => (
            <option key={alias} value={alias} />
          ))}
        </datalist>
        <label>
          {tx("远端系统")}
          <select value={os} onChange={(event) => setOs(event.target.value as typeof os)}>
            <option value="posix">{tx("Linux / macOS")}</option>
            <option value="windows">{tx("Windows")}</option>
          </select>
        </label>
        <label>
          {tx("远程文件根目录")}
          <input
            value={root}
            maxLength={4096}
            onChange={(event) => setRoot(event.target.value)}
            placeholder={tx("留空使用服务端登录目录")}
          />
        </label>
        <p className="muted">
          {tx(
            "使用系统 OpenSSH 配置。文件面板需要密钥或 ssh-agent；首次连接请在 SSH 终端确认主机指纹。",
          )}
        </p>
        {info && !info.available && (
          <p role="alert">{tx("未找到系统 OpenSSH。请先安装 OpenSSH 客户端。")}</p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={close}>
            {tx("取消")}
          </button>
          <button disabled={info?.available === false}>{tx("保存")}</button>
        </div>
      </form>
    </dialog>
  );
}
