import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { sshError } from "../lib/file-target";
import { validSshTarget, sshTargetFor, type SshConnection } from "../lib/workspace";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
import { sshEndpoint, type ResolvedSsh } from "../lib/ssh";

export function SshConnectionDialog({
  connection,
  workspaceId,
  save,
  close,
  connect,
}: {
  connection?: SshConnection;
  workspaceId: string;
  save: (connection: SshConnection) => boolean;
  close: () => void;
  connect?: (connection: SshConnection) => void;
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
    connection?.authentication ?? "config",
  );
  const [identity, setIdentity] = useState(connection?.identity_file ?? "");
  const [jump, setJump] = useState(connection?.jump_host ?? "");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(connection?.remember_password ?? false);
  const [os, setOs] = useState<"posix" | "windows">(connection?.os ?? "posix");
  const [root, setRoot] = useState(connection?.root ?? "");
  const [info, setInfo] = useState<{ available: boolean; aliases: string[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState<ResolvedSsh | null>(null);
  const [resolving, setResolving] = useState(false);
  const resolutionRequest = useRef(0);
  useEffect(() => {
    resolutionRequest.current++;
    setResolved(null);
    setResolving(false);
  }, [host, port, username, identity, authentication, mode, jump]);
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
      resolutionRequest.current++;
    };
  }, []);
  function configuration(): SshConnection {
    return {
      id,
      name: name.trim() || host.trim(),
      host: host.trim(),
      mode,
      ...(port ? { port: Number(port) } : {}),
      username: username.trim(),
      authentication,
      ...(jump.trim() ? { jump_host: jump.trim() } : {}),
      ...(connection?.temporary ? { temporary: true } : {}),
      ...(connection?.forwards ? { forwards: connection.forwards } : {}),
      identity_file: authentication === "key" ? identity.trim() : "",
      credential_id: authentication === "password" ? (connection?.credential_id ?? null) : null,
      remember_password: authentication === "password" && remember,
      os,
      root: root.trim(),
      sessions: connection?.sessions ?? [],
      splitGroups: connection?.splitGroups ?? [],
    };
  }
  async function preview() {
    const target = sshTargetFor(configuration(), workspaceId);
    if (!validSshTarget(target)) {
      setError(tx("SSH 连接配置无效。"));
      return;
    }
    const request = ++resolutionRequest.current;
    setResolving(true);
    setError("");
    try {
      const value = await invoke<ResolvedSsh>("ssh_resolve", { connection: target });
      if (request === resolutionRequest.current) setResolved(value);
    } catch (reason) {
      if (request === resolutionRequest.current) setError(sshError(reason));
    } finally {
      if (request === resolutionRequest.current) setResolving(false);
    }
  }
  async function submit(start = false) {
    if (busy) return;
    const value = configuration();
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
      if (start) connect?.(value);
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
          const submitter = (event.nativeEvent as SubmitEvent).submitter;
          void submit(submitter?.getAttribute("value") === "connect");
        }}
      >
        <h2 id="ssh-dialog-title">{connection ? tx("编辑 SSH 连接") : tx("添加 SSH 连接")}</h2>
        <fieldset disabled={busy}>
          <div className="ssh-connection-modes" role="group" aria-label={tx("连接方式")}>
            {(["direct", "alias"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={mode === value}
                onClick={() => {
                  if (mode === value) return;
                  setMode(value);
                  setPort(value === "direct" ? port || "22" : "");
                }}
              >
                {value === "direct" ? tx("主机地址") : tx("OpenSSH 配置")}
              </button>
            ))}
          </div>
          <label>
            {mode === "direct" ? tx("主机地址") : tx("SSH Host 别名")}
            <input
              autoFocus
              name="host"
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
          {mode === "alias" && (
            <p className="muted">
              {tx("持续引用 OpenSSH 配置；用户名和端口留空时继承配置，已有跳板机设置继续生效。")}
            </p>
          )}
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
          <div className="ssh-config-preview">
            <button
              type="button"
              disabled={busy || resolving || !host.trim()}
              onClick={() => void preview()}
            >
              {resolving ? tx("正在读取…") : tx("查看生效配置")}
            </button>
            {resolved && (
              <output>
                {sshEndpoint(sshTargetFor(configuration(), workspaceId), resolved)}
                {resolved.proxy ? " · " + tx("使用跳板机或代理") : ""}
              </output>
            )}
          </div>
          <details className="ssh-advanced" open={connection ? true : undefined}>
            <summary>{tx("更多设置")}</summary>
            <label>
              {tx("跳板机（可选）")}
              <input
                name="jump_host"
                value={jump}
                list="ssh-host-aliases"
                maxLength={512}
                placeholder={tx("bastion / user@bastion:22")}
                onChange={(event) => setJump(event.target.value)}
              />
            </label>
            <p className="muted">
              {tx(
                "选择 OpenSSH 别名或填写一台跳板机地址，留空继承配置。跳板机使用自己的 OpenSSH 配置或 ssh-agent；密码模式不支持跳板机。",
              )}
            </p>
            <label>
              {tx("连接名称（可选）")}
              <input
                value={name}
                maxLength={200}
                placeholder={tx("默认使用主机名")}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
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
          </details>
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
          <button value="save" disabled={busy || info?.available === false}>
            {busy ? tx("正在处理…") : tx("仅保存")}
          </button>
          {connect && (
            <button
              className="primary"
              value="connect"
              disabled={busy || info?.available === false}
            >
              {tx("保存并连接")}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
