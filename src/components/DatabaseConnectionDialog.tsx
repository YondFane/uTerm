import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
import {
  databaseError,
  databaseKinds,
  databaseNames,
  databasePorts,
  parseElasticsearchAddress,
  validDatabaseConfig,
  type DatabaseConfig,
  type DatabaseKind,
} from "../lib/database";
import { sshTargetFor, type SshConnection } from "../lib/workspace";
import { DatabaseComponents } from "./DatabaseComponents";

export function DatabaseConnectionDialog({
  connection,
  ssh,
  workspaceId,
  save,
  close,
  report,
}: {
  connection?: DatabaseConfig;
  ssh: SshConnection[];
  workspaceId: string;
  save: (config: DatabaseConfig, password: string) => boolean;
  close: () => void;
  report: (message: string) => void;
}) {
  useUiLanguage();
  ssh = ssh.filter((item) => !item.temporary);
  const [config, setConfig] = useState<DatabaseConfig>(
    connection ?? {
      id: crypto.randomUUID(),
      name: "",
      kind: "mysql",
      host: "127.0.0.1",
      port: 3306,
      database: "",
      username: "",
      tls: true,
      ca_file: "",
      credential_id: null,
    },
  );
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(!!connection?.credential_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [componentsOpen, setComponentsOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdrop = useDialogBackdrop(() => {
    if (!busy) close();
  });
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const field = <K extends keyof DatabaseConfig>(key: K, value: DatabaseConfig[K]) =>
    setConfig((previous) => ({ ...previous, [key]: value }));
  const addressError = () =>
    tx("请输入有效的域名、IP 或 HTTP/HTTPS 根地址，不支持 URL 中的凭据、路径、查询参数或片段。");
  const normalizeAddress = () => {
    if (config.kind !== "elasticsearch") return config;
    const address = parseElasticsearchAddress(config.host);
    if (!address) {
      setError(addressError());
      return null;
    }
    const next = { ...config, ...address };
    setConfig(next);
    return next;
  };
  const value = () => {
    const next = normalizeAddress();
    if (!next) return null;
    if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) {
      setError(tx("端口必须是 1 到 65535 之间的整数。"));
      return null;
    }
    return {
      ...next,
      name: next.name.trim() || `${databaseNames[next.kind]} ${next.host}:${next.port}`,
    };
  };
  async function test() {
    const next = value();
    if (!next) return;
    if (!validDatabaseConfig(next)) {
      setError(tx("数据库连接配置无效。"));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    let handle: string | null = null;
    try {
      const result = await invoke<{ handle: string }>("database_connect", {
        config: next,
        password: password || null,
      });
      handle = result.handle;
      setNotice(tx("数据库连接测试成功。"));
    } catch (reason) {
      setError(databaseError(reason));
    } finally {
      if (handle)
        await invoke("database_disconnect", { handle, discard: false }).catch((reason) =>
          setError(databaseError(reason)),
        );
      setBusy(false);
    }
  }
  async function submit() {
    let next = value();
    if (!next) return;
    if (!validDatabaseConfig(next)) {
      setError(tx("数据库连接配置无效。"));
      return;
    }
    if (remember && !password && !next.credential_id) {
      setError(tx("请输入需要保存的密码。"));
      return;
    }
    setBusy(true);
    setError("");
    let created: string | null = null;
    let saved = false;
    try {
      if (remember) {
        const reference = await invoke<string>("database_credential", {
          config: next,
          password: password || null,
          remove: false,
        });
        if (reference !== connection?.credential_id) created = reference;
        next = { ...next, credential_id: reference };
      } else next = { ...next, credential_id: null };
      saved = save(next, remember ? "" : password);
      if (!saved) throw new Error("DB_STORAGE");
      if (connection?.credential_id && connection.credential_id !== next.credential_id)
        await invoke("database_credential", { config: connection, password: null, remove: true });
      close();
    } catch (reason) {
      if (saved) {
        report(tx("连接已保存，但旧凭据清理失败：{message}", { message: databaseError(reason) }));
        close();
      } else {
        let message = databaseError(reason);
        if (created) {
          try {
            await invoke("database_credential", {
              config: { ...next, credential_id: created },
              password: null,
              remove: true,
            });
          } catch (cleanup) {
            message += ` ${databaseError(cleanup)}`;
          }
        }
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="ssh-dialog database-dialog"
      {...backdrop}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      aria-labelledby="database-dialog-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id="database-dialog-title">
          {connection ? tx("编辑数据库连接") : tx("添加数据库连接")}
        </h2>
        <fieldset disabled={busy}>
          <label>
            {tx("数据库类型")}
            <select
              value={config.kind}
              onChange={(event) => {
                const kind = event.target.value as DatabaseKind;
                setConfig((previous) => ({
                  ...previous,
                  kind,
                  port: databasePorts[kind],
                  credential_id: null,
                  auth_source: undefined,
                  auth_mode: undefined,
                }));
              }}
            >
              {databaseKinds.map((kind) => (
                <option value={kind} key={kind}>
                  {databaseNames[kind]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {tx("名称")}
            <input
              autoFocus
              value={config.name}
              onChange={(event) => field("name", event.target.value)}
              maxLength={200}
            />
          </label>
          <label>
            {tx("主机地址")}
            <input
              required
              value={config.host}
              placeholder={config.kind === "elasticsearch" ? "https://example.com" : undefined}
              onChange={(event) => {
                field("host", event.target.value);
                setError("");
              }}
              onBlur={() => {
                if (config.kind === "elasticsearch") normalizeAddress();
              }}
            />
          </label>
          <label>
            {tx("端口")}
            <input
              type="number"
              min={1}
              max={65535}
              required
              value={config.port}
              onChange={(event) => field("port", Number(event.target.value))}
            />
          </label>
          <label>
            {config.kind === "oracle"
              ? tx("Oracle 服务名")
              : config.kind === "elasticsearch"
                ? tx("默认索引（可选）")
                : tx("数据库名称（可选）")}
            <input
              required={config.kind === "oracle"}
              value={config.database}
              onChange={(event) => field("database", event.target.value)}
            />
          </label>
          {config.kind === "mongodb" && (
            <label>
              {tx("认证数据库")}
              <input
                value={config.auth_source ?? "admin"}
                onChange={(event) => field("auth_source", event.target.value)}
              />
            </label>
          )}
          {config.kind === "elasticsearch" && (
            <label>
              {tx("认证方式")}
              <select
                value={config.auth_mode ?? "basic"}
                onChange={(event) => field("auth_mode", event.target.value as "basic" | "api_key")}
              >
                <option value="basic">{tx("用户名和密码")}</option>
                <option value="api_key">{tx("API Key")}</option>
              </select>
            </label>
          )}
          <label>
            {tx("用户名")}
            <input
              value={config.username}
              onChange={(event) => field("username", event.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            {config.kind === "elasticsearch" && config.auth_mode === "api_key"
              ? "API Key"
              : tx("密码")}
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={config.credential_id ? tx("留空使用已保存密码") : ""}
              autoComplete="new-password"
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            {tx("记住密码（系统凭据库）")}
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.tls}
              onChange={(event) => field("tls", event.target.checked)}
            />
            {tx("启用 TLS")}
          </label>
          {config.tls && (
            <label>
              {tx("CA 证书路径（可选）")}
              <input
                value={config.ca_file}
                onChange={(event) => field("ca_file", event.target.value)}
              />
            </label>
          )}
          <label>
            {tx("SSH 隧道")}
            <select
              value={config.ssh_target?.connection_id ?? ""}
              onChange={(event) => {
                const selected = ssh.find((item) => item.id === event.target.value);
                field("ssh_target", selected ? sshTargetFor(selected, workspaceId) : undefined);
              }}
            >
              <option value="">{tx("直连")}</option>
              {ssh.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <p>{tx("TLS 验证服务器证书和主机名。SSH 隧道由所选 SSH 服务器访问数据库地址。")}</p>
        </fieldset>
        <details onToggle={(event) => setComponentsOpen(event.currentTarget.open)}>
          <summary>{tx("安装或管理连接组件")}</summary>
          {componentsOpen && <DatabaseComponents selectedKind={config.kind} />}
        </details>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={() => void test()}>
            {tx("测试连接")}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            {tx("取消")}
          </button>
          <button disabled={busy}>{tx("保存连接")}</button>
        </footer>
      </form>
    </dialog>
  );
}
