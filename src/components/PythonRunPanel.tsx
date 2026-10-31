import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { displayLocalPath } from "../lib/file-target";
import {
  pythonDraft,
  pythonError,
  pythonTaskUrl,
  formatPythonArguments,
  parsePythonArguments,
  parsePythonEnvironment,
  type PythonConfiguration,
  type PythonInterpreter,
  type PythonProject,
  type PythonRunConfig,
  type PythonTask,
  type PythonMode,
} from "../lib/python-run";
import { TerminalView } from "./TerminalView";
import { ToolbarIcon } from "./SidebarIcon";

const modes: PythonMode[] = ["script", "module", "fastapi", "flask", "django"];
const modeLabel = (mode: PythonMode) =>
  ({
    script: tx("Python 脚本"),
    module: tx("Python 模块"),
    fastapi: "FastAPI",
    flask: "Flask",
    django: "Django",
  })[mode];

export function PythonRunPanel({
  directory,
  visible = true,
  close,
  registerClose,
}: {
  directory: string;
  visible?: boolean;
  close: () => void;
  registerClose: (prepare: (() => Promise<boolean>) | null) => void;
}) {
  useUiLanguage();
  const [configuration, setConfiguration] = useState<PythonConfiguration | null>(null);
  const [draft, setDraft] = useState<PythonRunConfig | null>(null);
  const [info, setInfo] = useState<PythonProject>({ candidates: [], truncated: false });
  const [interpreters, setInterpreters] = useState<PythonInterpreter[]>([]);
  const [argumentsText, setArgumentsText] = useState("");
  const [environmentText, setEnvironmentText] = useState("");
  const [tasks, setTasks] = useState<PythonTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const pending = useRef(true);
  const requests = useRef(0);
  const lifecycle = useRef(0);
  const prepare = useRef<() => Promise<boolean>>(async () => false);
  const panel = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ height: 470, minimum: 240, maximum: 700 });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const drag = useRef<{ y: number; height: number; next: number } | null>(null);
  const frame = useRef<number | undefined>(undefined);
  function clamp(value: number) {
    return Math.round(Math.max(sizeRef.current.minimum, Math.min(sizeRef.current.maximum, value)));
  }
  function finishDrag(commit: boolean) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    panel.current?.removeAttribute("data-resizing");
    const height = commit ? clamp(current.next) : sizeRef.current.height;
    panel.current?.style.setProperty("--java-panel-height", `${height}px`);
    if (commit) setSize((previous) => ({ ...previous, height }));
  }
  function moveDrag(y: number) {
    const current = drag.current;
    if (!current) return;
    current.next = clamp(current.height + current.y - y);
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      if (drag.current)
        panel.current?.style.setProperty("--java-panel-height", `${drag.current.next}px`);
    });
  }
  useEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      if (!parent.clientHeight) return;
      finishDrag(false);
      const maximum = Math.max(0, parent.clientHeight - 88);
      const minimum = Math.min(240, maximum);
      setSize((previous) => ({
        height: Math.max(minimum, Math.min(maximum, previous.height)),
        minimum,
        maximum,
      }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    measure();
    return () => {
      observer.disconnect();
      finishDrag(false);
    };
  }, []);
  useEffect(() => {
    if (!visible || expanded) finishDrag(false);
  }, [visible, expanded]);
  useEffect(() => {
    registerClose(() => prepare.current());
    return () => registerClose(null);
  }, [registerClose]);
  function markBusy(value: boolean) {
    pending.current = value;
    if (mounted.current) setBusy(value);
  }
  async function operation(action: () => Promise<void>) {
    if (pending.current) return;
    markBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      if (mounted.current) setError(pythonError(reason));
    } finally {
      markBusy(false);
    }
  }
  async function load(replace: boolean) {
    const generation = lifecycle.current;
    const [config, project] = await Promise.all([
      invoke<PythonConfiguration>("python_configuration", { directory }),
      invoke<PythonProject>("python_project", { directory }),
    ]);
    const detected = await invoke<PythonInterpreter[]>("python_detect_interpreters", {
      directory,
      selected: config.project.interpreter,
    });
    if (!mounted.current || generation !== lifecycle.current) return;
    setInfo(project);
    setInterpreters(detected);
    if (replace || !draft) {
      const value = pythonDraft(config, project, detected);
      setConfiguration(config);
      setDraft(value);
      setArgumentsText(formatPythonArguments(value.arguments));
    }
  }
  useEffect(() => {
    const generation = ++lifecycle.current;
    mounted.current = true;
    markBusy(true);
    void load(true)
      .catch((reason) => {
        if (mounted.current && generation === lifecycle.current) setError(pythonError(reason));
      })
      .finally(() => {
        if (mounted.current && generation === lifecycle.current) markBusy(false);
      });
    return () => {
      mounted.current = false;
      lifecycle.current++;
      requests.current++;
    };
  }, [directory]);
  const refreshTasks = useCallback(async () => {
    const request = ++requests.current;
    try {
      const values = await invoke<PythonTask[]>("python_tasks", { directory });
      if (!mounted.current || request !== requests.current) return;
      values.sort((a, b) => b.task.created - a.task.created);
      setTasks(values);
      setSelectedId((previous) =>
        previous && values.some((task) => task.spec.id === previous)
          ? previous
          : (values[0]?.spec.id ?? null),
      );
    } catch (reason) {
      if (mounted.current && request === requests.current) setError(pythonError(reason));
    }
  }, [directory]);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      await refreshTasks();
      if (!cancelled) timer = window.setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [visible, refreshTasks]);
  const selected = tasks.find((task) => task.spec.id === selectedId);
  const running = tasks.find((task) => task.running);
  const update = (value: Partial<PythonRunConfig>) =>
    setDraft((previous) => previous && { ...previous, ...value });
  async function saveDraft() {
    if (!draft || !configuration) throw new Error("PYTHON_CONFIG_INVALID");
    const config = {
      ...draft,
      target: draft.target.trim(),
      arguments: parsePythonArguments(argumentsText),
    };
    const next = await invoke<PythonConfiguration>("python_save_configuration", {
      directory,
      revision: configuration.revision,
      config,
    });
    if (mounted.current) {
      setConfiguration(next);
      setDraft(next.project);
    }
    return config;
  }
  prepare.current = async () => {
    if (pending.current) return false;
    markBusy(true);
    setError("");
    try {
      if (draft) await saveDraft();
      return mounted.current;
    } catch (reason) {
      if (mounted.current) setError(pythonError(reason));
      return false;
    } finally {
      markBusy(false);
    }
  };
  async function choose(kind: "interpreter" | "script" | "directory") {
    await operation(async () => {
      const value = await invoke<string | null>("python_select_path", { directory, kind });
      if (value === null || !mounted.current) return;
      update(
        kind === "interpreter"
          ? { interpreter: value }
          : kind === "script"
            ? { target: value }
            : { working_directory: value || "." },
      );
    });
  }
  async function stop(force = false) {
    if (!running) return;
    await operation(async () => {
      setStopping(true);
      await invoke("python_stop", { id: running.spec.id, generation: running.generation, force });
      if (!mounted.current) return;
      setNotice(tx("已请求停止；进程仍在运行时可强制停止。"));
      await refreshTasks();
    });
  }
  async function start() {
    await operation(async () => {
      setNotice("");
      const environment = parsePythonEnvironment(environmentText);
      const config = await saveDraft();
      if (!mounted.current) return;
      if (running) {
        setStopping(true);
        await invoke("python_stop", {
          id: running.spec.id,
          generation: running.generation,
          force: false,
        });
        const deadline = Date.now() + 8000;
        let exited = false;
        while (Date.now() < deadline && mounted.current) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const snapshot = await invoke<PythonTask[]>("python_tasks", { directory });
          if (!snapshot.some((task) => task.spec.id === running.spec.id && task.running)) {
            exited = true;
            break;
          }
        }
        if (!exited) throw new Error(tx("任务尚未退出，请先强制停止后再运行。"));
      }
      if (!mounted.current) return;
      const task = await invoke<PythonTask>("python_start", { directory, config, environment });
      if (!mounted.current) return;
      requests.current++;
      setTasks((previous) => [task, ...previous.filter((value) => value.spec.id !== task.spec.id)]);
      setSelectedId(task.spec.id);
      setStopping(false);
    });
  }
  function changeMode(mode: PythonMode) {
    const candidates = info.candidates.filter((candidate) => candidate.mode === mode);
    update({
      mode,
      target: candidates.length === 1 ? candidates[0].target : "",
      working_directory: candidates.length === 1 ? candidates[0].working_directory : ".",
      port: mode === "flask" ? 5000 : 8000,
    });
  }
  const web = draft && ["fastapi", "flask", "django"].includes(draft.mode);
  const fileTarget = draft && ["script", "django"].includes(draft.mode);
  const url = running ? pythonTaskUrl(running) : null;
  return (
    <section
      ref={panel}
      className={`java-build-panel python-run-panel${expanded ? " java-panel-expanded" : ""}`}
      aria-label={tx("Python 运行")}
      hidden={!visible}
      inert={!visible}
      style={
        {
          "--java-panel-height": `${size.height}px`,
          display: visible ? undefined : "none",
        } as CSSProperties
      }
    >
      {!expanded && (
        <div
          className="java-panel-resizer"
          role="separator"
          tabIndex={0}
          aria-label={tx("调整运行面板高度")}
          aria-orientation="horizontal"
          aria-valuemin={size.minimum}
          aria-valuemax={size.maximum}
          aria-valuenow={size.height}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            const height = panel.current?.getBoundingClientRect().height ?? size.height;
            drag.current = { y: event.clientY, height, next: height };
            panel.current?.setAttribute("data-resizing", "");
          }}
          onPointerMove={(event) => moveDrag(event.clientY)}
          onPointerUp={(event) => {
            moveDrag(event.clientY);
            finishDrag(true);
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => finishDrag(false)}
          onLostPointerCapture={() => finishDrag(false)}
          onDoubleClick={() => setSize((previous) => ({ ...previous, height: clamp(470) }))}
          onKeyDown={(event) => {
            const value =
              event.key === "Home"
                ? size.minimum
                : event.key === "End"
                  ? size.maximum
                  : event.key === "ArrowUp"
                    ? size.height + 24
                    : event.key === "ArrowDown"
                      ? size.height - 24
                      : null;
            if (value !== null) {
              event.preventDefault();
              setSize((previous) => ({ ...previous, height: clamp(value) }));
            }
          }}
        />
      )}
      <header className="java-panel-header">
        <ToolbarIcon name="python" />
        <strong>{tx("Python 运行")}</strong>
        <span className="java-project-path" title={displayLocalPath(directory)}>
          {displayLocalPath(directory)}
        </span>
        <button type="button" disabled={busy} onClick={() => void operation(() => load(false))}>
          {tx("重新检测")}
        </button>
        <button
          type="button"
          className="toolbar-icon-button"
          aria-label={expanded ? tx("还原运行面板") : tx("展开运行面板")}
          onClick={() => setExpanded((value) => !value)}
        >
          <ToolbarIcon name={expanded ? "restore" : "maximize"} />
        </button>
        <button
          type="button"
          disabled={busy}
          className="toolbar-icon-button"
          aria-label={tx("隐藏运行面板")}
          onClick={() =>
            void prepare.current().then((ready) => {
              if (ready) close();
            })
          }
        >
          <ToolbarIcon name="close" />
        </button>
      </header>
      {draft && (
        <details className="java-run-configuration python-configuration" open>
          <summary>{tx("运行配置")}</summary>
          <fieldset disabled={busy}>
            <div className="java-fields python-fields">
              <label>
                {tx("Python 解释器")}
                <span className="java-path-input">
                  <input
                    aria-label={tx("Python 解释器")}
                    list="python-interpreters"
                    value={draft.interpreter}
                    placeholder={tx("选择或填写解释器路径")}
                    onChange={(event) => update({ interpreter: event.target.value })}
                  />
                  <button
                    type="button"
                    aria-label={tx("选择 Python 解释器")}
                    onClick={() => void choose("interpreter")}
                  >
                    <ToolbarIcon name="folder" />
                  </button>
                </span>
                <datalist id="python-interpreters">
                  {interpreters.map((value) => (
                    <option
                      key={value.path}
                      value={value.path}
                    >{`Python ${value.version}${value.virtual_environment ? ` · ${tx("虚拟环境")}` : ""}`}</option>
                  ))}
                </datalist>
                <span className="java-local-path">
                  {interpreters.find((value) => value.path === draft.interpreter)?.version ??
                    tx("使用已有 Python 3 环境")}
                </span>
              </label>
              <label>
                {tx("启动方式")}
                <select
                  value={draft.mode}
                  onChange={(event) => changeMode(event.target.value as PythonMode)}
                >
                  {modes.map((mode) => (
                    <option key={mode} value={mode}>
                      {modeLabel(mode)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {fileTarget ? tx("启动脚本") : tx("应用入口")}
                <span className="java-path-input">
                  <input
                    aria-label={fileTarget ? tx("启动脚本") : tx("应用入口")}
                    list="python-targets"
                    value={draft.target}
                    placeholder={
                      fileTarget
                        ? "main.py"
                        : draft.mode === "module"
                          ? "package.main"
                          : "app.main:app"
                    }
                    onChange={(event) => update({ target: event.target.value })}
                  />
                  {fileTarget && (
                    <button
                      type="button"
                      aria-label={tx("选择 Python 脚本")}
                      onClick={() => void choose("script")}
                    >
                      <ToolbarIcon name="folder" />
                    </button>
                  )}
                </span>
                <datalist id="python-targets">
                  {info.candidates
                    .filter((candidate) => candidate.mode === draft.mode)
                    .map((candidate) => (
                      <option key={candidate.target} value={candidate.target} />
                    ))}
                </datalist>
              </label>
              <label>
                {tx("工作目录")}
                <span className="java-path-input">
                  <input
                    value={draft.working_directory}
                    onChange={(event) => update({ working_directory: event.target.value })}
                  />
                  <button
                    type="button"
                    aria-label={tx("选择 Python 工作目录")}
                    onClick={() => void choose("directory")}
                  >
                    <ToolbarIcon name="folder" />
                  </button>
                </span>
              </label>
              {web && (
                <>
                  <label>
                    {tx("监听地址")}
                    <input
                      value={draft.host}
                      onChange={(event) => update({ host: event.target.value })}
                    />
                  </label>
                  <div className="python-web-options">
                    <label>
                      {tx("端口")}
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={draft.port}
                        onChange={(event) => update({ port: Number(event.target.value) })}
                      />
                    </label>
                    <label className="java-checkbox">
                      <input
                        type="checkbox"
                        checked={draft.reload}
                        onChange={(event) => update({ reload: event.target.checked })}
                      />
                      {tx("自动重载")}
                    </label>
                  </div>
                </>
              )}
            </div>
            <details className="java-advanced">
              <summary>{tx("高级设置")}</summary>
              <div className="java-fields">
                <label>
                  {tx("应用参数")}
                  <textarea
                    value={argumentsText}
                    rows={2}
                    onChange={(event) => setArgumentsText(event.target.value)}
                  />
                </label>
                <label>
                  {tx("环境变量")}
                  <textarea
                    value={environmentText}
                    rows={2}
                    placeholder={tx("例如 KEY=value")}
                    onChange={(event) => setEnvironmentText(event.target.value)}
                  />
                  <span>{tx("仅用于本次运行，不保存环境变量。")}</span>
                </label>
                <button
                  type="button"
                  onClick={() =>
                    void operation(async () => {
                      await saveDraft();
                      if (mounted.current) setNotice(tx("配置已保存，下次运行生效。"));
                    })
                  }
                >
                  {tx("保存配置")}
                </button>
              </div>
            </details>
          </fieldset>
          {info.truncated && (
            <p className="java-help">{tx("项目超过入口检测上限，请手动填写入口。")}</p>
          )}
        </details>
      )}
      <div className="java-task-toolbar python-task-toolbar">
        <span className={`java-task-state${running ? " running" : ""}`} role="status">
          {running
            ? tx("进程运行中")
            : busy
              ? tx("正在读取…")
              : selected
                ? tx("已退出，退出码 {code}", { code: selected.code ?? tx("未知") })
                : tx("未运行")}
        </span>
        {url && (
          <button
            type="button"
            className="python-service-url"
            title={tx("打开服务地址")}
            onClick={() =>
              void invoke("open_external", { url }).catch((reason) => setError(pythonError(reason)))
            }
          >
            {url}
            <ToolbarIcon name="link" />
          </button>
        )}
        <span className="java-toolbar-spacer" />
        <button
          type="button"
          className="primary python-run-button"
          disabled={busy || !draft?.interpreter || !draft.target}
          onClick={() => void start()}
        >
          <ToolbarIcon name={running ? "restart" : "python"} />
          {running ? tx("重新运行") : tx("运行")}
        </button>
        <button type="button" disabled={busy || !running} onClick={() => void stop()}>
          {tx("停止")}
        </button>
        {stopping && running && (
          <button type="button" className="danger" disabled={busy} onClick={() => void stop(true)}>
            {tx("强制停止")}
          </button>
        )}
      </div>
      {error && (
        <div className="java-error" role="alert">
          {error}
          <button type="button" disabled={busy} onClick={() => void operation(() => load(true))}>
            {tx("重新读取已保存的配置")}
          </button>
        </div>
      )}
      {notice && (
        <p className="java-panel-notice" role="status">
          {notice}
        </p>
      )}
      {tasks.length > 1 && (
        <div className="java-task-history">
          <label>
            {tx("任务日志")}
            <select
              value={selectedId ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {tasks.map((task) => (
                <option key={task.spec.id} value={task.spec.id}>
                  {task.task.name} · {new Date(task.task.created).toLocaleTimeString()}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="java-task-output">
        {selected ? (
          <TerminalView
            key={selected.spec.id}
            existingOnly
            logView
            directory={selected.spec.directory}
            session={{ id: selected.spec.id, name: selected.task.name, shell: "default" }}
            active={visible}
            visible={visible}
            frame={{ x: 0, y: 0, width: 1, height: 1 }}
            focusRequest=""
            closeRequest={0}
            onFocus={() => {}}
            onClosed={() => void refreshTasks()}
            onAgentState={() => {}}
            onDetectedAgent={() => {}}
            onPaneDragStart={() => {}}
            onDragOver={() => {}}
            onDragLeave={() => {}}
            onDrop={() => {}}
          />
        ) : (
          <p className="java-help">
            {busy ? tx("正在读取…") : tx("选择 Python 环境和入口后运行，日志显示在这里。")}
          </p>
        )}
      </div>
    </section>
  );
}
