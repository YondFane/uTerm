import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { sshError } from "../lib/file-target";
import { validSshTarget, sshTargetFor, type SshConnection } from "../lib/workspace";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";

export function SshConnectionDialog({
  connection,
  workspaceId,
  save,
  close,
}: {
  connection?: SshConnection;
  workspaceId: string;
  save: (connection: SshConnection) => boolean;
  close: () => void;
}) {
  useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [id] = useState(connection?.id ?? crypto.randomUUID());
  const [name, setName] = useState(connection?.name ?? "");
  const [mode, setMode] = useState<"direct" | "alias">(
    connection ? (connection.mode ?? "alias") : "direct",
  );
  const [host, setHost] = useState(connection?.host ?? "");
  const [port, setPort] = useState(connection?.port?.toString() ?? (connection ? "" : "22"));
  const [username, setUsername] = useState(connection?.username ?? "");
  const [authentication, setAuthentication] = useState<"config" | "key" | "password">(
    connection?.authentication ?? (connection ? "config" : "key"),
  );
  const [identity, setIdentity] = useState(connection?.identity_file ?? "");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(connection?.remember_password ?? false);
  const [os, setOs] = useState<"posix" | "windows">(connection?.os ?? "posix");
  const [root, setRoot] = useState(connection?.root ?? "");
  const [info, setInfo] = useState<{ available: boolean; aliases: string[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dismiss = () => {
    if (!busy) close();
  };
  const backdrop = useDialogBackdrop(dismiss);
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
  async function submit() {
    const value: SshConnection = {
      id,
      name: name.trim() || host.trim(),
      host: host.trim(),
      mode,
      ...(port ? { port: Number(port) } : {}),
      username: username.trim(),
      authentication,
      identity_file: authentication === "key" ? identity.trim() : "",
      credential_id: authentication === "password" ? (connection?.credential_id ?? null) : null,
      remember_password: authentication === "password" && remember,
      os,
      root: root.trim(),
      sessions: connection?.sessions ?? [],
      splitGroups: connection?.splitGroups ?? [],
    };
    if (!validSshTarget(sshTargetFor(value, workspaceId))) {
      setError(tx("SSH 连接配置无效。"));
      return;
    }
    setBusy(true);
    setError("");
    let reference: string | null = null;
    let saved = false;
    try {
      reference = await invoke<string | null>("ssh_configure_auth", {
        connection: sshTargetFor(
          { ...value, remember_password: connection?.remember_password ?? false },
          workspaceId,
        ),
        password: password || null,
        remember: authentication === "password" && remember,
      });
      value.credential_id = reference;
      if (!save(value)) throw new Error(tx("无法保存连接，请检查工作区存储后重试。"));
      saved = true;
      if (connection?.credential_id && connection.credential_id !== reference) {
        await invoke("ssh_forget_auth", {
          reference: connection.credential_id,
          remember: connection.remember_password ?? false,
        });
      }
      close();
    } catch (reason) {
      let message = sshError(reason);
      if (!saved && reference && reference !== connection?.credential_id) {
        try {
          await invoke("ssh_forget_auth", { reference, remember });
        } catch (cleanup) {
          message += " " + sshError(cleanup);
        }
      }
      setError(saved ? tx("连接已保存，但旧凭据清理失败：{message}", { message }) : message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="ssh-dialog ssh-connection-dialog"
      {...backdrop}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      aria-labelledby="ssh-dialog-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id="ssh-dialog-title">{connection ? tx("编辑 SSH 连接") : tx("添加 SSH 连接")}</h2>
        <fieldset disabled={busy}>
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
            {tx("连接方式")}
            <select
              value={mode}
              onChange={(event) => {
                const next = event.target.value as "direct" | "alias";
                setMode(next);
                if (next === "direct" && !port) setPort("22");
              }}
            >
              <option value="direct">{tx("主机地址")}</option>
              <option value="alias">{tx("SSH Host 别名")}</option>
            </select>
          </label>
          <label>
            {mode === "direct" ? tx("主机地址") : tx("SSH Host 别名")}
            <input
              required
              value={host}
              list={mode === "alias" ? "ssh-host-aliases" : undefined}
              maxLength={255}
              onChange={(event) => setHost(event.target.value)}
            />
          </label>
          <datalist id="ssh-host-aliases">
            {info?.aliases.map((alias) => (
              <option key={alias} value={alias} />
            ))}
          </datalist>
          <div className="ssh-address-row">
            <label>
              {tx("端口")}
              <input
                type="number"
                required={mode === "direct"}
                min={1}
                max={65535}
                value={port}
                placeholder={tx("使用 OpenSSH 配置")}
                onChange={(event) => setPort(event.target.value)}
              />
            </label>
            <label>
              {tx("用户名")}
              <input
                value={username}
                maxLength={256}
                placeholder={tx("留空使用 OpenSSH 配置")}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
          </div>
          <label>
            {tx("认证方式")}
            <select
              value={authentication}
              onChange={(event) => setAuthentication(event.target.value as typeof authentication)}
            >
              <option value="config">{tx("OpenSSH 自动认证")}</option>
              <option value="key">{tx("私钥 / ssh-agent")}</option>
              <option value="password">{tx("密码")}</option>
            </select>
          </label>
          {authentication === "key" && (
            <>
              <label>
                {tx("私钥文件（可选）")}
                <div className="ssh-key-picker">
                  <input
                    value={identity}
                    maxLength={4096}
                    placeholder={tx("留空使用 ssh-agent 或默认密钥")}
                    onChange={(event) => setIdentity(event.target.value)}
                  />
                  <button
                    type="button"
                    aria-label={tx("选择文件…")}
                    onClick={() =>
                      void invoke<string | null>("ssh_pick_identity")
                        .then((value) => {
                          if (value) setIdentity(value);
                        })
                        .catch((error) => setError(sshError(error)))
                    }
                  >
                    {tx("选择文件…")}
                  </button>
                </div>
              </label>
              <p className="muted">{tx("有口令的私钥用于文件或隧道时，请先加入 ssh-agent。")}</p>
            </>
          )}
          {authentication === "password" && (
            <>
              <label>
                {tx("SSH 密码")}
                <input
                  type="password"
                  autoComplete="off"
                  value={password}
                  maxLength={1023}
                  placeholder={connection?.credential_id ? tx("留空保留现有密码") : undefined}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label className="ssh-password-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                {tx("记住密码（系统凭据库）")}
              </label>
              <p className="muted">
                {tx(
                  "不记住密码时仅在本次运行有效，重开应用后需重新输入。密码认证暂不支持跳板机或验证码。",
                )}
              </p>
            </>
          )}
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
            {tx("使用系统 OpenSSH。首次连接需确认主机指纹；端口和用户名留空时沿用 OpenSSH 配置。")}
          </p>
        </fieldset>
        {info && !info.available && (
          <p role="alert">{tx("未找到系统 OpenSSH。请先安装 OpenSSH 客户端。")}</p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={dismiss}>
            {tx("取消")}
          </button>
          <button disabled={busy || info?.available === false}>
            {busy ? tx("正在处理…") : tx("保存")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
