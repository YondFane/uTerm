import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
import { redisError, validRedisConfig, resolveRedisSsh, type RedisConfig } from "../lib/redis";
import { sshTargetFor, type SshConnection } from "../lib/workspace";

export function RedisConnectionDialog({
  connection,
  ssh,
  workspaceId,
  save,
  close,
}: {
  connection?: RedisConfig;
  ssh: SshConnection[];
  workspaceId: string;
  save: (connection: RedisConfig, password: string) => boolean;
  close: () => void;
}) {
  useUiLanguage();
  ssh = ssh.filter((item) => !item.temporary);
  const [config, setConfig] = useState<RedisConfig>(
    connection
      ? resolveRedisSsh(connection, ssh, workspaceId)
      : {
          id: crypto.randomUUID(),
          name: "",
          host: "127.0.0.1",
          port: 6379,
          db: 0,
          username: "",
          tls: false,
          ca_file: "",
          server_name: "",
          ssh_host: "",
          credential_id: null,
        },
  );
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(!!connection?.credential_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const dismiss = () => {
    if (!busy) close();
  };
  const backdrop = useDialogBackdrop(dismiss);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const field = <K extends keyof RedisConfig>(key: K, value: RedisConfig[K]) => {
    setNotice("");
    setConfig((previous) => ({ ...previous, [key]: value }));
  };
  async function testConnection() {
    const value = {
      ...resolveRedisSsh(config, ssh, workspaceId),
      name: config.name.trim() || `${config.host}:${config.port}`,
    };
    if (!validRedisConfig(value)) {
      setError(tx("Redis 连接配置无效。"));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    let handle: string | null = null;
    try {
      const opened = await invoke<{ handle: string }>("redis_connect", {
        config: value,
        password: password || null,
      });
      handle = opened.handle;
      const result = await invoke<{ elapsed: number }>("redis_request", {
        handle,
        request: { op: "console", args: ["PING"] },
      });
      setNotice(tx("连接测试成功，PING 耗时 {elapsed} 毫秒。", { elapsed: result.elapsed }));
    } catch (error) {
      setError(redisError(error));
    } finally {
      if (handle) {
        try {
          await invoke("redis_disconnect", { handle });
        } catch (error) {
          setError(redisError(error));
        }
      }
      setBusy(false);
    }
  }
  async function submit() {
    const value = {
      ...resolveRedisSsh(config, ssh, workspaceId),
      name: config.name.trim() || `${config.host}:${config.port}`,
      credential_id: remember ? config.credential_id : null,
    };
    if (!validRedisConfig(value)) {
      setError(tx("Redis 连接配置无效。"));
      return;
    }
    if (remember && !password && !value.credential_id) {
      setError(tx("请输入需要保存的密码。"));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    let created: string | null = null;
    try {
      if (remember && password) {
        created = await invoke<string>("redis_credential", {
          config: value,
          password,
          remove: false,
        });
        value.credential_id = created;
      }
      if (!save(value, remember ? "" : password)) {
        if (created)
          await invoke("redis_credential", {
            config: { ...value, credential_id: created },
            password: null,
            remove: true,
          });
        setError(tx("无法保存连接，请检查工作区存储后重试。"));
        return;
      }
      if (connection?.credential_id && connection.credential_id !== value.credential_id)
        await invoke("redis_credential", { config: connection, password: null, remove: true });
      close();
    } catch (error) {
      setError(redisError(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="ssh-dialog redis-dialog"
      {...backdrop}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      aria-labelledby="redis-dialog-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id="redis-dialog-title">
          {connection ? tx("编辑 Redis 连接") : tx("添加 Redis 连接")}
        </h2>
        <fieldset disabled={busy}>
          <label>
            {tx("名称")}
            <input
              autoFocus
              value={config.name}
              maxLength={200}
              onChange={(e) => field("name", e.target.value)}
            />
          </label>
          <div className="redis-form-row">
            <label>
              {tx("Redis 地址")}
              <input
                required
                value={config.host}
                maxLength={255}
                onChange={(e) => field("host", e.target.value)}
              />
            </label>
            <label>
              {tx("端口")}
              <input
                type="number"
                required
                min={1}
                max={65535}
                value={config.port}
                onChange={(e) => field("port", Number(e.target.value))}
              />
            </label>
            <label>
              {tx("数据库 DB")}
              <input
                type="number"
                required
                min={0}
                max={1024}
                value={config.db}
                onChange={(e) => field("db", Number(e.target.value))}
              />
            </label>
          </div>
          <label>
            {tx("用户名（可选）")}
            <input
              autoComplete="off"
              value={config.username}
              maxLength={512}
              onChange={(e) => field("username", e.target.value)}
            />
          </label>
          <label>
            {tx("密码（可选）")}
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setNotice("");
              }}
              placeholder={config.credential_id ? tx("留空使用已保存密码") : ""}
            />
          </label>
          <label className="redis-checkbox">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {tx("记住密码（系统凭据库）")}
          </label>
          <label>
            {tx("SSH 隧道")}
            <select
              value={config.ssh_target?.connection_id ?? config.ssh_host}
              onChange={(e) => {
                const target = ssh.find((item) => item.id === e.target.value);
                setConfig((previous) => ({
                  ...previous,
                  ssh_host: target?.host ?? e.target.value,
                  ssh_target: target ? sshTargetFor(target, workspaceId) : undefined,
                }));
              }}
            >
              <option value="">{tx("直连")}</option>
              {ssh.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.host}
                </option>
              ))}
              {config.ssh_host &&
                !ssh.some((item) => item.id === config.ssh_target?.connection_id) && (
                  <option value={config.ssh_target?.connection_id ?? config.ssh_host}>
                    {config.ssh_host}
                  </option>
                )}
            </select>
          </label>
          {config.ssh_host && (
            <p className="muted">
              {tx("Redis 地址由 SSH 服务器访问；使用所选 SSH 连接的认证方式，并需允许 TCP 转发。")}
            </p>
          )}
          <label className="redis-checkbox">
            <input
              type="checkbox"
              checked={config.tls}
              onChange={(e) => field("tls", e.target.checked)}
            />
            {tx("启用 TLS")}
          </label>
          {config.tls && (
            <>
              <label>
                {tx("TLS 服务端名称（可选）")}
                <input
                  value={config.server_name}
                  onChange={(e) => field("server_name", e.target.value)}
                  placeholder={config.host}
                />
              </label>
              <div>
                <label htmlFor="redis-ca-file">{tx("CA 证书（可选）")}</label>
                <div className="redis-form-row">
                  <input id="redis-ca-file" value={config.ca_file} readOnly />
                  <button
                    type="button"
                    onClick={() =>
                      void invoke<string | null>("redis_pick_ca")
                        .then((path) => {
                          if (path) field("ca_file", path);
                        })
                        .catch((error) => setError(redisError(error)))
                    }
                  >
                    {tx("选择文件")}
                  </button>
                  <button type="button" onClick={() => field("ca_file", "")}>
                    {tx("清除")}
                  </button>
                </div>
              </div>
              <p className="muted">{tx("验证证书及服务端名称。留空 CA 时使用系统信任证书。")}</p>
            </>
          )}
        </fieldset>
        {notice && (
          <p className="redis-connected" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="remote-file-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={() => void testConnection()}>
            {tx("测试连接")}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            {tx("取消")}
          </button>
          <button type="submit" disabled={busy}>
            {busy ? tx("正在保存…") : tx("保存连接")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
