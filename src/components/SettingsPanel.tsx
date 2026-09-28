import { localizeMessage } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { tx } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { interfacePalette, interfaceThemes } from "../lib/interface-themes";
import { invoke } from "@tauri-apps/api/core";
import { AgentSettings, AgentUsage } from "./AgentPanel";
import { canRemoveWorkspace, createWorkspaceGroup, removeWorkspace } from "../lib/workspace";
import type { Workspace } from "../lib/workspace";
import { useSettings } from "../lib/SettingsContext";
import {
  availableAgents,
  defaults,
  binding,
  chord,
  commands,
  shortcutLabel,
} from "../lib/settings";
import type { Settings, CommandId } from "../lib/settings";
import type { Updates } from "../lib/useUpdates";
import type { RuntimeInfo } from "../lib/desktop";
import { themes, importTheme } from "../lib/themes";
import { activeLanguage, languageOptions, translate } from "../lib/i18n";
const interfaceFonts = [
  ["系统默认", defaults.interfaceFont],
  ["Arial", "Arial, sans-serif"],
  ["Helvetica Neue", '"Helvetica Neue", Arial, sans-serif'],
  ["Segoe UI", '"Segoe UI", sans-serif'],
  ["苹方", '"PingFang SC", sans-serif'],
  ["微软雅黑", '"Microsoft YaHei", sans-serif'],
  ["思源黑体", '"Source Han Sans SC", "Noto Sans CJK SC", sans-serif'],
] as const;
const terminalFonts = [
  ["系统默认等宽字体", defaults.fontFamily],
  ...[
    "Cascadia Code",
    "Cascadia Mono",
    "SFMono-Regular",
    "Menlo",
    "Monaco",
    "Consolas",
    "JetBrains Mono",
    "Fira Code",
    "Source Code Pro",
  ].map((name) => [name, `"${name}", monospace`] as const),
] as const;
function FontSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  useUiLanguage();

  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {!options.some(([, font]) => font === value) && (
        <option value={value}>{tx("当前自定义字体：{p0}", { p0: value })}</option>
      )}
      {options.map(([label, font]) => (
        <option key={font} value={font}>
          {/\p{Script=Han}/u.test(label) ? tx(label) : label}
        </option>
      ))}
    </select>
  );
}
interface ControlStatus {
  enabled: boolean;
  directory: string;
  endpoint: string;
  port: number;
}
const tabs = [
  "通用",
  "外观",
  "终端",
  "工作区",
  "快捷键",
  "Agent",
  "用量",
  "本地控制",
  "软件更新",
] as const;
export function SettingsPanel({
  runtime,
  close,
  reloadAgents,
  workspace,
  updateWorkspace,
  updates,
}: {
  runtime: RuntimeInfo;
  updates: Updates;
  close: () => void;
  reloadAgents: () => Promise<void>;
  workspace: Workspace | null;
  updateWorkspace: (change: (previous: Workspace) => Workspace) => void;
}) {
  useUiLanguage();

  const { settings, light, error, save, reset } = useSettings();
  const enabledAgents = availableAgents(settings, runtime.agents);
  const [workspaceEdit, setWorkspaceEdit] = useState<{ id: string | null; name: string } | null>(
    null,
  );
  const [workspaceDelete, setWorkspaceDelete] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof tabs)[number]>("通用");
  const showingDownloadProgress = ["downloading", "ready"].includes(updates.phase);
  const downloadProgressMax =
    updates.progress.total ??
    (updates.phase === "ready" ? Math.max(updates.progress.downloaded, 1) : undefined);
  const downloadProgressValue = updates.progress.total
    ? updates.progress.downloaded
    : updates.phase === "ready"
      ? Math.max(updates.progress.downloaded, 1)
      : undefined;
  const dialog = useRef<HTMLDialogElement>(null);
  const backdrop = useDialogBackdrop(() => {
    if (updates.phase !== "installing") close();
  });
  const themeFile = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [control, setControl] = useState<ControlStatus | null>(null);
  const [launcher, setLauncher] = useState("");
  const [busy, setBusy] = useState(false);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState("");
  async function configureAutostart(enabled?: boolean) {
    setAutostartBusy(true);
    setAutostartError("");
    try {
      const actual = await invoke<boolean>("autostart_configure", { enabled });
      if (typeof actual !== "boolean") throw new Error("Invalid autostart status");
      setAutostart(actual);
      if (enabled !== undefined && actual !== enabled) throw new Error("Autostart state mismatch");
    } catch (reason) {
      setAutostartError(String(reason));
    } finally {
      setAutostartBusy(false);
    }
  }
  const mac = runtime.platform === "macos";
  const language = activeLanguage(settings.language);
  const t = (key: string) => translate(language, key);
  useEffect(() => {
    dialog.current?.showModal();
    void configureAutostart();
    void invoke<ControlStatus>("control_status")
      .then(setControl)
      .catch((reason) => setMessage(String(reason)));
  }, []);
  function change(patch: Partial<Settings>, report = setMessage) {
    try {
      save({ ...settings, ...patch }, mac);
      report("");
    } catch (reason) {
      report(String(reason));
    }
  }
  async function configure(enabled: boolean) {
    setBusy(true);
    try {
      await invoke("control_configure", { enabled });
      setControl(await invoke<ControlStatus>("control_status"));
      setMessage("");
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      {...backdrop}
      ref={dialog}
      className="name-dialog settings-dialog"
      aria-labelledby="settings-title"
      onCancel={(event) => {
        if (updates.phase === "installing") event.preventDefault();
        else close();
      }}
    >
      <header className="inspector-header">
        <h2 id="settings-title">{t("设置")}</h2>
        <button
          disabled={updates.phase === "installing"}
          onClick={close}
          aria-label={t("关闭设置")}
        >
          ×
        </button>
      </header>
      <div className="settings-layout" inert={updates.phase === "installing"}>
        <nav aria-label={t("设置")}>
          {tabs.map((name) => (
            <button
              key={name}
              aria-pressed={tab === name}
              onClick={() => {
                setTab(name);
                setRecording(null);
              }}
            >
              {t(name)}
            </button>
          ))}
        </nav>
        <section className="settings-content">
          <h3>{t(tab)}</h3>
          {error || message ? (
            <p role="alert" className="settings-error">
              {localizeMessage(error || message)}
            </p>
          ) : null}
          {tab === "通用" && (
            <>
              <label>
                {t("应用语言")}
                <select
                  value={settings.language}
                  onChange={(event) =>
                    change({ language: event.target.value as Settings["language"] })
                  }
                >
                  {languageOptions.map(([value, label]) => (
                    <option key={value} value={value}>
                      {value === "system" ? t("跟随系统") : label}
                    </option>
                  ))}
                </select>
                <span className="muted">{t("语言切换立即生效。")}</span>
              </label>
              <label>
                {t("开机自启动")}
                <input
                  type="checkbox"
                  role="switch"
                  checked={autostart === true}
                  disabled={autostartBusy || autostart === null}
                  onChange={(event) => void configureAutostart(event.target.checked)}
                />
                <span className="muted">{t("登录系统后自动打开 uTerm。")}</span>
              </label>
              {autostartError && (
                <p role="alert" className="settings-error">
                  {tx("无法设置自启动：{p0}", { p0: autostartError })}
                  <button disabled={autostartBusy} onClick={() => void configureAutostart()}>
                    {t("重试")}
                  </button>
                </p>
              )}
              <div className="break-reminder-settings-row">
                <label>
                  {t("休息提醒")}
                  <input
                    type="checkbox"
                    role="switch"
                    checked={settings.breakReminder}
                    onChange={(event) => change({ breakReminder: event.target.checked })}
                  />
                </label>
                <label>
                  {t("提醒间隔（分钟）")}
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    step={1}
                    disabled={!settings.breakReminder}
                    defaultValue={settings.breakInterval}
                    key={settings.breakInterval}
                    onBlur={(event) => {
                      const value = event.target.valueAsNumber;
                      if (Number.isInteger(value) && value >= 1 && value <= 1440)
                        change({ breakInterval: value });
                      else {
                        event.target.value = String(settings.breakInterval);
                        setMessage(t("提醒间隔必须为 1 至 1440 分钟的整数。"));
                      }
                    }}
                  />
                </label>
              </div>
              <footer>
                <button
                  onClick={() => {
                    try {
                      reset();
                      setMessage(tx("已恢复默认设置。原设置已备份。"));
                    } catch (reason) {
                      setMessage(String(reason));
                    }
                  }}
                >
                  {tx("恢复界面与终端默认设置")}
                </button>
              </footer>
            </>
          )}
          {tab === "外观" && (
            <>
              <fieldset className="interface-theme-picker">
                <legend>{t("界面主题")}</legend>
                <div className="interface-theme-options">
                  {interfaceThemes.map((theme) => {
                    const palette = interfacePalette(theme.id, light);
                    return (
                      <button
                        type="button"
                        key={theme.id}
                        aria-pressed={settings.interfaceTheme === theme.id}
                        className="interface-theme-option"
                        onClick={() => change({ interfaceTheme: theme.id })}
                        style={
                          {
                            "--preview-canvas": palette.canvas,
                            "--preview-sidebar": palette.sidebar,
                            "--preview-accent": palette.accent,
                            "--preview-border": palette.border,
                            "--preview-text": palette.text,
                          } as CSSProperties
                        }
                      >
                        <span className="interface-theme-preview" aria-hidden="true">
                          <i />
                          <span>
                            <b />
                            <b />
                            <b />
                          </span>
                        </span>
                        <strong>
                          {t(theme.name)}
                          {settings.interfaceTheme === theme.id && (
                            <span aria-hidden="true"> ✓</span>
                          )}
                        </strong>
                        <small>{t(theme.description)}</small>
                      </button>
                    );
                  })}
                </div>
                <p className="muted">{t("即时生效并自动保存，不改变终端配色。")}</p>
              </fieldset>
              <label>
                {t("颜色模式")}
                <select
                  value={settings.appearance}
                  onChange={(e) => change({ appearance: e.target.value as Settings["appearance"] })}
                >
                  <option value="system">{t("跟随系统")}</option>
                  <option value="dark">{t("深色")}</option>
                  <option value="light">{t("浅色")}</option>
                </select>
              </label>
              {(["darkTheme", "lightTheme"] as const).map((key) => (
                <label key={key}>
                  {key === "darkTheme" ? tx("终端深色配色") : tx("终端浅色配色")}
                  <select
                    value={settings[key]}
                    onChange={(event) => change({ [key]: event.target.value })}
                  >
                    {[...themes, ...settings.customThemes].map((theme) => (
                      <option key={theme.id} value={theme.id}>
                        {theme.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label>
                {tx("导入 Ghostty 主题")}
                <button type="button" onClick={() => themeFile.current?.click()}>
                  {tx("选择主题文件…")}
                </button>
                <input
                  ref={themeFile}
                  hidden
                  aria-label={tx("导入 Ghostty 主题")}
                  type="file"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (file.size > 32000) {
                      setMessage(tx("主题文件不能超过 32 KB。"));
                      return;
                    }
                    void file
                      .text()
                      .then((source) => {
                        const theme = importTheme(source, file.name.replace(/\.(conf|txt)$/i, ""));
                        change({
                          customThemes: [
                            ...settings.customThemes.filter((item) => item.id !== theme.id),
                            theme,
                          ],
                          darkTheme: theme.id,
                        });
                      })
                      .catch((reason) => setMessage(String(reason)));
                    event.target.value = "";
                  }}
                />
              </label>
              <label>
                {tx("界面字体")}
                <FontSelect
                  value={settings.interfaceFont}
                  options={interfaceFonts}
                  onChange={(interfaceFont) => change({ interfaceFont })}
                />
              </label>
              {(
                [
                  ["interfaceSize", tx("界面字号"), 10, 20],
                  ["rowPadding", tx("侧栏行间距"), 0, 8],
                  ["windowPadding", tx("终端内边距"), 0, 40],
                ] as const
              ).map(([key, label, min, max]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    min={min}
                    max={max}
                    key={settings[key]}
                    defaultValue={settings[key]}
                    onBlur={(event) => change({ [key]: Number(event.target.value) })}
                  />
                </label>
              ))}
              <label>
                {tx("背景不透明度")}
                <input
                  type="range"
                  onClick={(event) => event.currentTarget.focus()}
                  min="0.3"
                  max="1"
                  step="0.05"
                  value={settings.opacity}
                  onChange={(event) => change({ opacity: Number(event.target.value) })}
                />
                <output>{Math.round(settings.opacity * 100)}%</output>
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={!["macos", "windows"].includes(runtime.platform)}
                  checked={settings.blur}
                  onChange={(event) => change({ blur: event.target.checked })}
                />
                {tx("背景模糊")}
              </label>
              <label>
                {tx("终端字体")}
                <FontSelect
                  value={settings.fontFamily}
                  options={terminalFonts}
                  onChange={(fontFamily) => change({ fontFamily })}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.fontThicken}
                  onChange={(event) => change({ fontThicken: event.target.checked })}
                />
                {tx("加粗字形")}
              </label>
              <label>
                {tx("字号")}
                <input
                  type="number"
                  min="10"
                  max="32"
                  key={settings.fontSize}
                  defaultValue={settings.fontSize}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  onBlur={(e) => change({ fontSize: Number(e.target.value) })}
                />
              </label>
              <label>
                {tx("行高")}
                <input
                  type="number"
                  min="1"
                  max="2"
                  step="0.1"
                  key={settings.lineHeight}
                  defaultValue={settings.lineHeight}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  onBlur={(e) => change({ lineHeight: Number(e.target.value) })}
                />
              </label>
              <p className="muted">{tx("更改会立即应用到已有终端。")}</p>
            </>
          )}
          {tab === "终端" && (
            <>
              <label>
                {tx("光标样式")}
                <select
                  value={settings.cursorStyle}
                  onChange={(e) =>
                    change({ cursorStyle: e.target.value as Settings["cursorStyle"] })
                  }
                >
                  <option value="block">{tx("方块")}</option>
                  <option value="bar">{tx("竖线")}</option>
                  <option value="underline">{tx("下划线")}</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.cursorBlink}
                  onChange={(e) => change({ cursorBlink: e.target.checked })}
                />
                {tx("光标闪烁")}
              </label>
              <label>
                {tx("滚动历史行数")}
                <input
                  type="number"
                  min="100"
                  max="100000"
                  step="100"
                  key={settings.scrollback}
                  defaultValue={settings.scrollback}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  onBlur={(e) => change({ scrollback: Number(e.target.value) })}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.copyOnSelect}
                  onChange={(e) => change({ copyOnSelect: e.target.checked })}
                />
                {tx("选中文本时复制")}
              </label>
              <p className="muted">{tx("减少历史行数会丢弃超出上限的终端显示记录。")}</p>
            </>
          )}
          {tab === "工作区" && (
            <>
              <section className="workspace-manager" aria-label={tx("管理工作区")}>
                {workspace?.groups?.map((group) => (
                  <div className="workspace-manager-row" key={group.id}>
                    <span>
                      {group.name}
                      {group.id === workspace.selectedWorkspace ? tx("（当前）") : ""}
                    </span>
                    <button
                      onClick={() => {
                        setWorkspaceEdit({ id: group.id, name: group.name });
                        setWorkspaceDelete(null);
                      }}
                    >
                      {tx("编辑")}
                    </button>
                    <button
                      disabled={!canRemoveWorkspace(workspace, group.id)}
                      onClick={() => {
                        setWorkspaceDelete(group.id);
                        setWorkspaceEdit(null);
                      }}
                    >
                      {tx("删除")}
                    </button>
                  </div>
                ))}
                <button
                  disabled={!workspace}
                  onClick={() => {
                    setWorkspaceEdit({ id: null, name: "" });
                    setWorkspaceDelete(null);
                  }}
                >
                  {tx("新增工作区")}
                </button>
                <p className="muted">
                  {tx("仅可删除没有项目和会话的工作区，至少保留一个工作区。")}
                </p>
                {workspaceEdit && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = workspaceEdit.name.trim();
                      if (!name) return;
                      const id = workspaceEdit.id ?? crypto.randomUUID();
                      updateWorkspace((previous) => ({
                        ...previous,
                        groups:
                          workspaceEdit.id === null
                            ? [...(previous.groups ?? []), createWorkspaceGroup(id, name)]
                            : previous.groups?.map((group) =>
                                group.id === id ? { ...group, name } : group,
                              ),
                      }));
                      setWorkspaceEdit(null);
                    }}
                  >
                    <label>
                      {tx("工作区名称")}
                      <input
                        autoFocus
                        required
                        maxLength={100}
                        value={workspaceEdit.name}
                        onChange={(event) =>
                          setWorkspaceEdit({ ...workspaceEdit, name: event.target.value })
                        }
                      />
                    </label>
                    <button type="submit" disabled={!workspaceEdit.name.trim()}>
                      {tx("保存")}
                    </button>
                    <button type="button" onClick={() => setWorkspaceEdit(null)}>
                      {tx("取消")}
                    </button>
                  </form>
                )}
                {workspaceDelete && (
                  <div role="group" aria-label={tx("确认删除工作区")}>
                    <p>
                      {tx("删除工作区“{p0}”？不会删除磁盘文件。", {
                        p0:
                          workspace?.groups?.find((group) => group.id === workspaceDelete)?.name ??
                          "",
                      })}
                    </p>
                    <button
                      disabled={!workspace || !canRemoveWorkspace(workspace, workspaceDelete)}
                      onClick={() => {
                        updateWorkspace((previous) => removeWorkspace(previous, workspaceDelete));
                        setWorkspaceDelete(null);
                      }}
                    >
                      {tx("确认删除")}
                    </button>
                    <button onClick={() => setWorkspaceDelete(null)}>{tx("取消")}</button>
                  </div>
                )}
              </section>
              <label>
                {tx("项目排序")}
                <select
                  value={settings.projectOrder}
                  onChange={(e) =>
                    change({ projectOrder: e.target.value as Settings["projectOrder"] })
                  }
                >
                  <option value="manual">{tx("手动")}</option>
                  <option value="name">{tx("名称")}</option>
                </select>
              </label>
              {runtime.platform === "windows" && (
                <label>
                  {tx("新会话 Shell")}
                  <select
                    value={settings.defaultShell}
                    onChange={(e) =>
                      change({ defaultShell: e.target.value as Settings["defaultShell"] })
                    }
                  >
                    <option value="default">PowerShell</option>
                    <option value="cmd">{tx("命令提示符")}</option>
                  </select>
                </label>
              )}
              <label>
                {tx("新聊天 Agent")}
                <select
                  value={
                    enabledAgents.includes(settings.defaultAgent)
                      ? settings.defaultAgent
                      : (enabledAgents[0] ?? "")
                  }
                  disabled={!enabledAgents.length}
                  onChange={(e) => change({ defaultAgent: e.target.value })}
                >
                  {!enabledAgents.length && <option value="">{tx("请先启用 Agent")}</option>}
                  {enabledAgents.map((id) => (
                    <option key={id} value={id}>
                      {runtime.agent_definitions.find((a) => a.id === id)?.name ?? id}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">{tx("默认 Shell 和 Agent 仅用于新建会话。")}</p>
            </>
          )}
          {tab === "快捷键" && (
            <>
              <p className="muted">{tx("点击快捷键后按下新组合。Escape 取消，Backspace 清除。")}</p>
              <div className="shortcut-list">
                {commands.map(([id, title]) => (
                  <label key={id}>
                    <span>{tx(title)}</span>
                    <button
                      className={recording === id ? "recording" : ""}
                      onClick={(event) => {
                        setRecording(id);
                        event.currentTarget.focus();
                      }}
                      onKeyDown={(event) => {
                        if (recording !== id) return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.key === "Escape") {
                          setRecording(null);
                          return;
                        }
                        if (event.nativeEvent.isComposing) return;
                        const value =
                          event.key === "Backspace" ? "" : chord(event.nativeEvent, mac);
                        if (!value && event.key !== "Backspace") return;
                        change({ shortcuts: { ...settings.shortcuts, [id]: value } });
                        setRecording(null);
                      }}
                    >
                      {recording === id
                        ? tx("按下快捷键…")
                        : shortcutLabel(binding(settings, id, mac), mac) || tx("未设置")}
                    </button>
                  </label>
                ))}
              </div>
              <button onClick={() => change({ shortcuts: {} })}>{tx("恢复默认快捷键")}</button>
            </>
          )}
          {tab === "Agent" && (
            <>
              <p>{tx("配置 Agent 程序、启动参数、Hooks 和任务通知。")}</p>
              <AgentSettings runtime={runtime} reload={reloadAgents} />
            </>
          )}
          {tab === "用量" && (
            <>
              <label>
                {tx("用量查询间隔（秒）")}
                <input
                  type="number"
                  min={10}
                  max={3600}
                  step={1}
                  defaultValue={settings.usageRefreshInterval}
                  key={settings.usageRefreshInterval}
                  onBlur={(event) => {
                    const value = event.target.valueAsNumber;
                    if (Number.isInteger(value) && value >= 10 && value <= 3600)
                      change({ usageRefreshInterval: value });
                    else {
                      event.target.value = String(settings.usageRefreshInterval);
                      setMessage(tx("用量查询间隔必须为 10 至 3600 秒的整数。"));
                    }
                  }}
                />
              </label>
              <AgentUsage runtime={runtime} />
            </>
          )}
          {tab === "本地控制" && (
            <>
              <label>
                <input
                  type="checkbox"
                  disabled={!control || busy}
                  checked={control?.enabled ?? false}
                  onChange={(e) => void configure(e.target.checked)}
                />
                {tx("允许本地 CLI 控制")}
              </label>
              <p className="muted">
                {tx("允许当前用户的本地程序列出、新建、聚焦、输入和关闭会话。应用需保持运行。")}
              </p>
              {control && (
                <dl>
                  <dt>{tx("状态")}</dt>
                  <dd>
                    {control.enabled
                      ? tx("已启用 · 127.0.0.1:{p0}", { p0: control.port })
                      : tx("已关闭")}
                  </dd>
                  <dt>{tx("配置目录")}</dt>
                  <dd>{control.directory}</dd>
                </dl>
              )}
              <button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void invoke<string>("control_install")
                    .then(setLauncher)
                    .catch((reason) => setMessage(String(reason)))
                    .finally(() => setBusy(false));
                }}
              >
                {tx("创建 CLI 启动器")}
              </button>
              {launcher && (
                <>
                  <p>{tx("启动器已创建。可将其所在目录加入 PATH。")}</p>
                  <code className="settings-path">{launcher}</code>
                </>
              )}
              <p className="muted">
                {tx("会话菜单可复制 uterm:// 链接。链接只选择已有会话，不执行命令。")}
              </p>
            </>
          )}
          {tab === "软件更新" && (
            <>
              <p>uTerm {runtime.version}</p>
              {!updates.available?.enabled ? (
                <p className="muted">{tx("此构建未启用在线更新。请使用正式渠道安装包。")}</p>
              ) : (
                <>
                  <p className="muted">{tx("启动后自动检查更新。下载和安装由你决定。")}</p>
                  {!showingDownloadProgress && (
                    <p role="status" aria-live="polite">
                      {updates.phase === "checking"
                        ? tx("正在检查更新…")
                        : updates.phase === "current"
                          ? tx("已是最新版本。")
                          : updates.phase === "ready"
                            ? tx("更新已下载并通过签名校验。")
                            : updates.phase === "installing"
                              ? tx("正在安装，即将重启…")
                              : updates.available.version
                                ? tx("新版本 uTerm {p0}", { p0: updates.available.version })
                                : ""}
                    </p>
                  )}
                  {showingDownloadProgress && (
                    <>
                      <div className="update-download-progress">
                        <progress
                          aria-label={tx("下载进度")}
                          max={downloadProgressMax}
                          value={downloadProgressValue}
                        />
                        <span role="status" aria-live="polite">
                          {tx("已下载 {p0} MB", {
                            p0: (updates.progress.downloaded / 1048576).toFixed(1),
                          })}
                        </span>
                      </div>
                      {updates.phase === "ready" && (
                        <p role="status" aria-live="polite">
                          {tx("更新已下载并通过签名校验。")}
                        </p>
                      )}
                    </>
                  )}
                  {updates.available.notes && (
                    <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {updates.available.notes}
                    </p>
                  )}
                  {["idle", "current", "available"].includes(updates.phase) && (
                    <button onClick={() => void updates.check()}>{tx("检查更新")}</button>
                  )}
                  {updates.phase === "available" && (
                    <button onClick={() => void updates.download()}>{tx("下载更新")}</button>
                  )}
                  {updates.phase === "ready" && (
                    <>
                      <p>{tx("安装会关闭并重新打开应用。请先保存文件修改。")}</p>
                      <button onClick={() => void updates.install()}>{tx("安装并重启")}</button>
                    </>
                  )}
                </>
              )}
              {updates.error && (
                <p role="alert" className="settings-error">
                  {localizeMessage(updates.error)}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </dialog>
  );
}
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
