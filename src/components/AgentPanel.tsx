import { useUiLanguage } from "../lib/useUiLanguage";
import { tx, getUiLanguage, localizeMessage } from "../lib/i18n";
import { useSettings } from "../lib/SettingsContext";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import type { AgentDefinition, RuntimeInfo } from "../lib/desktop";
import { agentNames, SessionIcon } from "./SidebarIcon";
import { agentInstallers } from "../lib/agent-install";
export const notificationKey = "uterm.desktop.agentNotifications";
interface Usage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  records: number;
  partial: boolean;
  notice: string | null;
  windows: { label: string; percent: number; seconds?: number; resetsAt?: string | number }[];
}
export function AgentPanel({
  runtime,
  close,
  reload,
}: {
  runtime: RuntimeInfo;
  close: () => void;
  reload: () => Promise<void>;
}) {
  useUiLanguage();

  const dialog = useRef<HTMLDialogElement>(null);
  const backdrop = useDialogBackdrop(close);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      {...backdrop}
      ref={dialog}
      className="name-dialog agent-dialog"
      aria-labelledby="agent-dialog-title"
      onCancel={close}
    >
      <header className="inspector-header">
        <h2 id="agent-dialog-title">Agent</h2>
        <button onClick={close} aria-label={tx("关闭 Agent 设置")}>
          ×
        </button>
      </header>
      <AgentSettings runtime={runtime} reload={reload} />
    </dialog>
  );
}

export function AgentSettings({
  runtime,
  reload,
}: {
  runtime: RuntimeInfo;
  reload: () => Promise<void>;
}) {
  useUiLanguage();

  const { settings, save: saveSettings } = useSettings();
  const [definitions, setDefinitions] = useState(runtime.agent_definitions);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgentDefinition | null>(null);
  const [argumentsText, setArgumentsText] = useState("[]");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installTarget, setInstallTarget] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ agent: string; value: Usage } | null>(null);
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem(notificationKey) === "true",
  );
  const ids = [
    ...new Set([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "kimi",
      "grok",
      ...definitions.map((item) => item.id),
    ]),
  ];
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function save(next: AgentDefinition[]) {
    await invoke("save_agents", { definitions: next });
    setDefinitions(next);
    await reload();
  }
  return (
    <div className="agent-settings">
      {error && (
        <p role="alert">
          {error
            .split("\n")
            .map((line) => localizeMessage(line))
            .join("\n")}
        </p>
      )}
      {notice && <p role="status">{localizeMessage(notice)}</p>}
      <div className="agent-catalog">
        {ids.map((id) => {
          const definition = definitions.find((item) => item.id === id);
          const installer = agentInstallers[id];
          const automatic = installer?.package && (!definition || definition.program === id);
          return (
            <section key={id} className="agent-definition">
              <header>
                <SessionIcon agent={id} />
                <strong>{definition?.name ?? agentNames[id] ?? id}</strong>
                <span>{runtime.agents.includes(id) ? tx("可用") : tx("未找到程序")}</span>
                <input
                  className="agent-enable"
                  type="checkbox"
                  role="switch"
                  aria-label={tx("启用 {p0}", { p0: definition?.name ?? agentNames[id] ?? id })}
                  title={tx("启用后显示新建入口")}
                  checked={settings.enabledAgents.includes(id)}
                  disabled={
                    busy || (!runtime.agents.includes(id) && !settings.enabledAgents.includes(id))
                  }
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void perform(async () => {
                      saveSettings(
                        {
                          ...settings,
                          enabledAgents: enabled
                            ? [...settings.enabledAgents, id]
                            : settings.enabledAgents.filter((agent) => agent !== id),
                        },
                        runtime.platform === "macos",
                      );
                    });
                  }}
                />
              </header>
              <div className="agent-buttons">
                {!runtime.agents.includes(id) && (
                  <button disabled={busy} onClick={() => setInstallTarget(id)}>
                    {tx("安装程序")}
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() => {
                    setCreating(false);
                    setEditing(
                      definition ?? { id, name: agentNames[id] ?? id, program: id, arguments: [] },
                    );
                    setArgumentsText(JSON.stringify(definition?.arguments ?? []));
                  }}
                >
                  {tx("配置")}
                </button>
                {["codex", "claude", "gemini"].includes(id) && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          setNotice(
                            await invoke<string>("agent_hooks", { agent: id, enabled: true }),
                          );
                        })
                      }
                    >
                      {tx("安装 Hooks")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          setNotice(
                            await invoke<string>("agent_hooks", { agent: id, enabled: false }),
                          );
                        })
                      }
                    >
                      {tx("移除 Hooks")}
                    </button>
                  </>
                )}
                {["codex", "claude", "kimi", "grok"].includes(id) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        setUsage({
                          agent: id,
                          value: await invoke<Usage>("agent_usage", {
                            agent: id,
                            remote: settings.usageRemote,
                          }),
                        });
                      })
                    }
                  >
                    {tx("读取用量")}
                  </button>
                )}
                {id === "claude" && runtime.platform === "macos" && (
                  <button
                    disabled={busy || !settings.usageRemote}
                    onClick={() =>
                      void perform(async () => {
                        setUsage({
                          agent: id,
                          value: await invoke<Usage>("agent_usage", {
                            agent: id,
                            remote: true,
                            allowKeychain: true,
                          }),
                        });
                      })
                    }
                  >
                    {tx("通过钥匙串读取用量")}
                  </button>
                )}
                {definition && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(() => save(definitions.filter((item) => item.id !== id)))
                    }
                  >
                    {agentNames[id] ? tx("恢复默认") : tx("移除配置")}
                  </button>
                )}
              </div>
              {installTarget === id && (
                <div className="agent-editor">
                  <p>
                    {automatic
                      ? tx("将通过 npm 全局安装程序，需要 Node.js 和网络连接，不会自动提权。")
                      : tx("请按发布方说明安装程序，再配置可执行文件路径。")}
                  </p>
                  {automatic && <code>{`npm install -g ${installer.package}`}</code>}
                  <div className="agent-buttons">
                    {automatic && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            setInstalling(id);
                            try {
                              const available = await invoke<boolean>("install_agent", {
                                agent: id,
                              });
                              setNotice(
                                available
                                  ? tx("安装完成，程序已可用。")
                                  : tx(
                                      "安装命令已完成，但未找到程序。请配置程序路径或重启 uTerm 后重新检测。",
                                    ),
                              );
                              await reload();
                            } finally {
                              setInstalling(null);
                            }
                          })
                        }
                      >
                        {installing === id ? tx("正在安装…") : tx("确认安装")}
                      </button>
                    )}
                    {installer && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await invoke("open_external", { url: installer.url });
                          })
                        }
                      >
                        {tx("官方安装说明")}
                      </button>
                    )}
                    <button disabled={busy} onClick={() => void perform(reload)}>
                      {tx("重新检测")}
                    </button>
                    <button disabled={busy} onClick={() => setInstallTarget(null)}>
                      {tx("取消")}
                    </button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
      <button
        disabled={busy}
        onClick={() => {
          setCreating(true);
          setEditing({ id: "", name: "", program: "", arguments: [] });
          setArgumentsText("[]");
        }}
      >
        {tx("添加 Agent")}
      </button>
      {editing && (
        <form
          className="agent-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              if (creating && ids.includes(editing.id))
                throw new Error(tx("Agent 标识已存在，请使用其他标识。"));
              const argumentsValue: unknown = JSON.parse(argumentsText);
              if (
                !Array.isArray(argumentsValue) ||
                !argumentsValue.every((value) => typeof value === "string")
              )
                throw new Error(tx('参数应为字符串数组，例如 ["--model", "模型名"]。'));
              const next = { ...editing, arguments: argumentsValue as string[] };
              await save([...definitions.filter((item) => item.id !== next.id), next]);
              setEditing(null);
            });
          }}
        >
          <label>
            {tx("标识")}
            <input
              required
              value={editing.id}
              disabled={!creating}
              pattern="[a-zA-Z0-9_-]{1,80}"
              onChange={(event) => setEditing({ ...editing, id: event.target.value })}
            />
          </label>
          <label>
            {tx("名称")}
            <input
              required
              value={editing.name}
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            />
          </label>
          <label>
            {tx("程序路径或命令")}
            <input
              required
              value={editing.program}
              onChange={(event) => setEditing({ ...editing, program: event.target.value })}
            />
          </label>
          <label>
            {tx("参数（JSON 数组）")}
            <input
              value={argumentsText}
              onChange={(event) => setArgumentsText(event.target.value)}
            />
          </label>
          <div>
            <button type="button" onClick={() => setEditing(null)}>
              {tx("取消")}
            </button>
            <button disabled={busy}>{tx("保存")}</button>
          </div>
        </form>
      )}
      <label className="notification-toggle">
        <input
          type="checkbox"
          checked={notifications}
          disabled={busy}
          onChange={(event) => {
            const checked = event.target.checked;
            void perform(async () => {
              if (
                checked &&
                !(await isPermissionGranted()) &&
                (await requestPermission()) !== "granted"
              )
                throw new Error(tx("通知权限未开启，请在系统设置中允许通知。"));
              localStorage.setItem(notificationKey, String(checked));
              setNotifications(checked);
            });
          }}
        />
        {tx("任务完成或需要处理时通知")}
      </label>
      {runtime.debug && <p className="muted">{tx("开发构建不发送任务通知。")}</p>}
      {busy && <p role="status">{tx("正在处理…")}</p>}
      {usage && (
        <section className="agent-usage">
          <h3>{tx("{p0} · 近 7 天", { p0: agentNames[usage.agent] })}</h3>
          <dl>
            <dt>{tx("输入")}</dt>
            <dd>{usage.value.input.toLocaleString(getUiLanguage())}</dd>
            <dt>{tx("输出")}</dt>
            <dd>{usage.value.output.toLocaleString(getUiLanguage())}</dd>
            <dt>{tx("缓存读取")}</dt>
            <dd>{usage.value.cache_read.toLocaleString(getUiLanguage())}</dd>
            <dt>{tx("缓存写入")}</dt>
            <dd>{usage.value.cache_write.toLocaleString(getUiLanguage())}</dd>
          </dl>
          {!usage.value.records && <p>{tx("未找到近 7 天的 Token 记录。")}</p>}
          {usage.value.partial && <p>{tx("日志较大，当前统计仅包含已读取的部分。")}</p>}
          {usage.value.windows.map((window, index) => (
            <div key={index}>
              <span>
                {tx("{p0}：已用 {p1}%", {
                  p0: window.seconds
                    ? tx("{p0} 小时", { p0: window.seconds / 3600 })
                    : localizeMessage(window.label),
                  p1: Math.round(window.percent),
                })}
              </span>
              <progress max="100" value={window.percent} />
              {window.resetsAt && (
                <small>
                  {tx("重置于 {p0}", {
                    p0: new Date(
                      typeof window.resetsAt === "number"
                        ? window.resetsAt * 1000
                        : window.resetsAt,
                    ).toLocaleString(getUiLanguage()),
                  })}
                </small>
              )}
            </div>
          ))}
          {usage.value.notice && <p>{localizeMessage(usage.value.notice)}</p>}
        </section>
      )}
    </div>
  );
}
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
