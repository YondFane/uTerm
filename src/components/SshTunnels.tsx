import { useState } from "react";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { sshError } from "../lib/file-target";
import { validSshForward, type SshForward } from "../lib/workspace";
import type { SshTunnelStatus } from "../lib/ssh";

export function SshTunnels({
  rules,
  statuses,
  save,
  start,
  stop,
  error: listError,
}: {
  rules: SshForward[];
  statuses: SshTunnelStatus[];
  save: (rules: SshForward[]) => boolean;
  start: (rule: SshForward) => Promise<void>;
  stop: (id: string) => Promise<void>;
  error?: string;
}) {
  useUiLanguage();
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  async function change(id: string, operation: () => Promise<void>) {
    if (pending.includes(id)) return;
    setPending((previous) => [...previous, id]);
    setError("");
    try {
      await operation();
    } catch (reason) {
      setError(sshError(reason));
    } finally {
      setPending((previous) => previous.filter((value) => value !== id));
    }
  }
  return (
    <section className="ssh-tunnels" aria-label={tx("端口转发")}>
      <h3>{tx("本地端口转发")}</h3>
      <p className="muted">
        {tx(
          "仅监听 127.0.0.1，远端地址由 SSH 服务器访问。手动启动，退出应用时停止；本地监听不代表远端服务可用。",
        )}
      </p>
      <div className="ssh-forward-list">
        {rules.map((rule) => {
          const status = statuses.find((item) => item.id === rule.id);
          const active = status?.state === "running" || status?.state === "starting";
          return (
            <div className="ssh-forward" key={rule.id}>
              <code>
                127.0.0.1:{rule.local_port} →{" "}
                {rule.remote_host.includes(":") ? `[${rule.remote_host}]` : rule.remote_host}:
                {rule.remote_port}
              </code>
              <span role="status">
                {status?.state === "starting"
                  ? tx("正在启动转发…")
                  : status?.state === "running"
                    ? tx("本地端口正在监听")
                    : status?.state === "error"
                      ? tx("转发失败")
                      : tx("已停止")}
              </span>
              <div className="ssh-forward-actions">
                <button
                  disabled={pending.includes(rule.id) || !!listError}
                  onClick={() => void change(rule.id, () => (active ? stop(rule.id) : start(rule)))}
                >
                  {active ? tx("停止转发") : tx("启动转发")}
                </button>
                <button
                  disabled={active || pending.includes(rule.id) || !!listError}
                  onClick={() => {
                    if (!save(rules.filter((item) => item.id !== rule.id)))
                      setError(tx("无法保存端口转发配置。"));
                    else void change(rule.id, () => stop(rule.id));
                  }}
                >
                  {tx("移除转发")}
                </button>
              </div>
              {status?.error && <p role="alert">{sshError(status.error)}</p>}
            </div>
          );
        })}
      </div>
      <form
        className="ssh-forward-form"
        onSubmit={(event) => {
          event.preventDefault();
          const rule = {
            id: crypto.randomUUID(),
            local_port: Number(localPort),
            remote_host: remoteHost.trim(),
            remote_port: Number(remotePort),
          };
          if (
            !validSshForward(rule) ||
            rules.length >= 16 ||
            rules.some((item) => item.local_port === rule.local_port)
          ) {
            setError(tx("端口转发配置无效或本地端口重复。每个连接最多 16 条规则。"));
            return;
          }
          if (save([...rules, rule])) {
            setLocalPort("");
            setRemotePort("");
            setError("");
          } else setError(tx("无法保存端口转发配置。"));
        }}
      >
        <label>
          {tx("本地端口")}
          <input
            required
            type="number"
            min={1}
            max={65535}
            value={localPort}
            onChange={(event) => setLocalPort(event.target.value)}
          />
        </label>
        <label>
          {tx("远端地址")}
          <input
            required
            maxLength={255}
            value={remoteHost}
            onChange={(event) => setRemoteHost(event.target.value)}
          />
        </label>
        <label>
          {tx("远端端口")}
          <input
            required
            type="number"
            min={1}
            max={65535}
            value={remotePort}
            onChange={(event) => setRemotePort(event.target.value)}
          />
        </label>
        <button>{tx("添加转发")}</button>
      </form>
      {(error || listError) && <p role="alert">{error || listError}</p>}
    </section>
  );
}
