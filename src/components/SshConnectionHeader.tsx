import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { sshError } from "../lib/file-target";
import { sshEndpoint, sshFilesLabel, sshTerminalLabel } from "../lib/ssh";
import type { ResolvedSsh, SshFileStatus, TerminalStatus } from "../lib/ssh";
import type { SshTarget } from "../lib/workspace";

export function SshConnectionHeader({
  target,
  terminalStatus,
  sessions,
  filesStatus,
  filesVisible,
  disabled,
  canEdit,
  newTerminal,
  showFiles,
  edit,
  temporary,
  promote,
  showTunnels,
  tunnelsVisible,
}: {
  target: SshTarget;
  terminalStatus?: TerminalStatus;
  sessions: number;
  filesStatus: SshFileStatus;
  filesVisible: boolean;
  disabled: boolean;
  canEdit: boolean;
  newTerminal: () => void;
  showFiles: () => void;
  edit: () => void;
  temporary?: boolean;
  promote?: () => void;
  showTunnels?: () => void;
  tunnelsVisible?: boolean;
}) {
  useUiLanguage();
  const [resolved, setResolved] = useState<ResolvedSsh | null>(null);
  const [error, setError] = useState("");
  const key = JSON.stringify(target);
  useEffect(() => {
    let disposed = false;
    setResolved(null);
    setError("");
    invoke<ResolvedSsh>("ssh_resolve", { connection: target })
      .then((value) => {
        if (!disposed) setResolved(value);
      })
      .catch((reason) => {
        if (!disposed) setError(sshError(reason));
      });
    return () => {
      disposed = true;
    };
  }, [key]);
  return (
    <section className="ssh-context" aria-label={tx("SSH 连接详情")}>
      <div className="ssh-context-heading">
        <strong>
          {tx("SSH")} · {target.name}
        </strong>
        <span className="ssh-endpoint">{sshEndpoint(target, resolved)}</span>
        {!resolved && target.mode !== "direct" && (
          <span className="muted">{tx("用户名与端口按 OpenSSH 配置生效")}</span>
        )}
        {resolved?.proxy && <span className="badge">{tx("使用跳板机或代理")}</span>}
      </div>
      <div className="ssh-context-actions">
        {temporary && (
          <button disabled={disabled} onClick={promote}>
            {tx("保存为常用连接")}
          </button>
        )}
        {showTunnels && (
          <button disabled={disabled} aria-pressed={tunnelsVisible} onClick={showTunnels}>
            {tx("端口转发")}
          </button>
        )}
        <button disabled={disabled} onClick={newTerminal}>
          {tx("新建 SSH 终端")}
        </button>
        <button disabled={disabled} aria-pressed={filesVisible} onClick={showFiles}>
          {tx("远程文件")}
        </button>
        <button
          disabled={disabled || !canEdit}
          onClick={edit}
          title={
            !canEdit
              ? tx("连接正在使用，请先关闭相关会话、文件和依赖的工作台，并停止转发。")
              : undefined
          }
        >
          {tx("编辑 SSH 连接")}
        </button>
      </div>
      <div className="ssh-channel-status" role="status">
        <span>
          {terminalStatus
            ? sshTerminalLabel(terminalStatus)
            : tx("已保存会话：{count}", { count: sessions })}
        </span>
        <span data-state={filesStatus}>{sshFilesLabel(filesStatus)}</span>
      </div>
      {terminalStatus === "running" && (
        <p className="ssh-context-hint">
          {tx("进程状态不代表认证已完成，请在终端完成指纹或认证提示。")}
        </p>
      )}
      {["idle", "exited", "disconnected"].includes(terminalStatus ?? "") && (
        <p className="ssh-context-hint">
          {tx("旧输出已保留。重新附着只恢复本机连接；新建 SSH 终端会建立新的远程登录。")}
        </p>
      )}
      {error && (
        <p className="ssh-context-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
