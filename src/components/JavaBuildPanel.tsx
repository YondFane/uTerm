import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
import {
  javaError,
  formatJavaArguments,
  parseJavaArguments,
  parseJavaEnvironment,
  type JavaConfiguration,
  type JavaModule,
  type JavaProjectConfig,
  type JavaTask,
} from "../lib/java-build";
import { TerminalView } from "./TerminalView";
import { ToolbarIcon } from "./SidebarIcon";
import { MavenSettings } from "./MavenSettings";
import { JavaComponents } from "./JavaComponents";
import { displayLocalPath } from "../lib/file-target";

const supportedJavaVersions = [8, 11, 17, 21];

function projectDraftFrom(
  configuration: JavaConfiguration,
  modules: JavaModule[],
): JavaProjectConfig {
  if (configuration.configured) return configuration.project;
  const preferredModule =
    modules.find((module) => module.boot && module.packaging !== "pom") ??
    modules.find((module) => module.packaging !== "pom") ??
    modules[0];
  return {
    ...configuration.project,
    module: preferredModule?.path ?? ".",
    java_version:
      preferredModule?.java_version && supportedJavaVersions.includes(preferredModule.java_version)
        ? preferredModule.java_version
        : 21,
  };
}

export function JavaBuildPanel({
  directory,
  close,
  registerClose,
  visible = true,
}: {
  directory: string;
  close: () => void;
  registerClose?: (prepare: (() => Promise<boolean>) | null) => void;
  visible?: boolean;
}) {
  useUiLanguage();
  const [savedConfiguration, setSavedConfiguration] = useState<JavaConfiguration | null>(null),
    [projectDraft, setProjectDraft] = useState<JavaProjectConfig | null>(null),
    [modules, setModules] = useState<JavaModule[]>([]);
  const [tasks, setTasks] = useState<JavaTask[]>([]),
    [selectedTaskId, setSelectedTaskId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [mavenOpen, setMavenOpen] = useState(false),
    [componentsOpen, setComponentsOpen] = useState(false),
    [stopping, setStopping] = useState(false),
    [expanded, setExpanded] = useState(false);
  const [buildGoal, setBuildGoal] = useState("build"),
    [jvmArgumentsText, setJvmArgumentsText] = useState(""),
    [applicationArgumentsText, setApplicationArgumentsText] = useState(""),
    [environmentText, setEnvironmentText] = useState("");
  const [manualMainClass, setManualMainClass] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const [panelSize, setPanelSize] = useState({ height: 380, minimum: 240, maximum: 600 });
  const sizeRef = useRef(panelSize);
  sizeRef.current = panelSize;
  const heightDrag = useRef<{ y: number; height: number; next: number } | null>(null);
  const heightFrame = useRef<number | undefined>(undefined);
  function clampHeight(value: number) {
    return Math.round(Math.max(sizeRef.current.minimum, Math.min(sizeRef.current.maximum, value)));
  }
  function finishHeightDrag(commit: boolean) {
    const drag = heightDrag.current;
    if (!drag) return;
    heightDrag.current = null;
    if (heightFrame.current !== undefined) cancelAnimationFrame(heightFrame.current);
    heightFrame.current = undefined;
    panel.current?.removeAttribute("data-resizing");
    const height = commit ? clampHeight(drag.next) : sizeRef.current.height;
    panel.current?.style.setProperty("--java-panel-height", `${height}px`);
    if (commit) setPanelSize((previous) => ({ ...previous, height }));
  }
  function moveHeightDrag(y: number) {
    const drag = heightDrag.current;
    if (!drag) return;
    drag.next = clampHeight(drag.height + drag.y - y);
    if (heightFrame.current !== undefined) return;
    // Preview once per frame without rerendering task configuration or reconnecting its terminal.
    // 每帧只预览一次高度，不重新渲染任务配置或重连终端。
    heightFrame.current = requestAnimationFrame(() => {
      heightFrame.current = undefined;
      if (heightDrag.current)
        panel.current?.style.setProperty("--java-panel-height", `${heightDrag.current.next}px`);
    });
  }
  useEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      if (!parent.clientHeight) return;
      finishHeightDrag(false);
      const maximum = Math.max(0, parent.clientHeight - 88);
      const minimum = Math.min(window.innerHeight <= 550 ? 200 : 240, maximum);
      setPanelSize((previous) => {
        const height = Math.max(minimum, Math.min(maximum, previous.height));
        return height === previous.height &&
          minimum === previous.minimum &&
          maximum === previous.maximum
          ? previous
          : { height, minimum, maximum };
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    measure();
    return () => {
      observer.disconnect();
      finishHeightDrag(false);
    };
  }, []);
  useEffect(() => {
    if (!visible || expanded) finishHeightDrag(false);
  }, [visible, expanded]);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  // Block a second action before React renders the disabled controls.
  // 在 React 渲染禁用控件之前，就阻止第二个操作进入。
  const operationPending = useRef(false);
  const setOperationBusy = useCallback((value: boolean) => {
    operationPending.current = value;
    if (mounted.current) setBusy(value);
  }, []);
  // Old host replies must not replace a newer snapshot or a newly created task.
  // 旧宿主响应不能覆盖更新的快照或刚创建的任务。
  const taskRequestVersion = useRef(0);
  const prepareCloseRef = useRef<() => Promise<boolean>>(async () => true);
  const closePending = useRef(false);
  useEffect(() => {
    registerClose?.(() => prepareCloseRef.current());
    return () => registerClose?.(null);
  }, [registerClose]);
  function dismissDialog() {
    if (operationPending.current) return;
    setMavenOpen(false);
    setComponentsOpen(false);
  }
  const backdrop = useDialogBackdrop(dismissDialog);
  function applyLoadedConfiguration(
    configuration: JavaConfiguration,
    detectedModules: JavaModule[],
  ) {
    const draft = projectDraftFrom(configuration, detectedModules);
    setManualMainClass(false);
    setSavedConfiguration({ ...configuration, project: draft });
    setProjectDraft(draft);
    setModules(detectedModules);
    setJvmArgumentsText(formatJavaArguments(draft.vm_arguments));
    setApplicationArgumentsText(formatJavaArguments(draft.arguments));
  }
  async function runPanelOperation(operation: () => Promise<void>) {
    if (operationPending.current) return;
    setOperationBusy(true);
    setError("");
    try {
      await operation();
    } catch (reason) {
      if (mounted.current) setError(javaError(reason));
    } finally {
      setOperationBusy(false);
    }
  }
  const refreshTasks = useCallback(async () => {
    const request = ++taskRequestVersion.current;
    try {
      const values = await invoke<JavaTask[]>("java_tasks", { directory });
      if (mounted.current && request === taskRequestVersion.current) {
        values.sort((a, b) => b.task.created - a.task.created);
        setTasks(values);
        setSelectedTaskId((previous) =>
          previous && values.some((value) => value.spec.id === previous)
            ? previous
            : (values[0]?.spec.id ?? null),
        );
      }
    } catch (reason) {
      if (mounted.current && request === taskRequestVersion.current) setError(javaError(reason));
    }
  }, [directory]);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => {
      setOperationBusy(true);
      try {
        const [config, info] = await Promise.all([
          invoke<JavaConfiguration>("java_configuration", { directory }),
          invoke<{ modules: JavaModule[] }>("java_project", { directory }),
        ]);
        if (cancelled) return;
        applyLoadedConfiguration(config, info.modules);
      } catch (reason) {
        if (!cancelled) setError(javaError(reason));
      } finally {
        if (!cancelled) setOperationBusy(false);
      }
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
      taskRequestVersion.current++;
    };
  }, [directory, setOperationBusy]);
  useEffect(() => {
    if (visible && (mavenOpen || componentsOpen)) dialog.current?.showModal();
    else dialog.current?.close();
  }, [mavenOpen, componentsOpen, visible]);
  const selectedTask = tasks.find((value) => value.spec.id === selectedTaskId);
  const runningTask = tasks.find((value) => value.running);
  useEffect(() => {
    if (visible) void refreshTasks();
  }, [visible, refreshTasks]);
  useEffect(() => {
    if (!runningTask || !visible) return;
    let cancelled = false;
    let timer: number;
    // Slow snapshots must finish before another poll can supersede their request version.
    // 慢快照请求必须完成后再发起下一轮，避免每个响应都因版本过期而失效。
    const poll = async () => {
      await refreshTasks();
      if (!cancelled) timer = window.setTimeout(poll, 1500);
    };
    timer = window.setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [!!runningTask, refreshTasks, visible]);
  useEffect(() => {
    if (runningTask || !selectedTask) return;
    let cancelled = false;
    void invoke<{ modules: JavaModule[] }>("java_project", { directory })
      .then((info) => {
        if (!cancelled) setModules(info.modules);
      })
      .catch((reason) => {
        if (!cancelled) setError(javaError(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [!!runningTask, selectedTask?.spec.id, directory]);
  const updateProjectDraft = (values: Partial<JavaProjectConfig>) =>
    setProjectDraft((previous) => previous && { ...previous, ...values });
  function readProjectDraft(): JavaProjectConfig {
    if (!projectDraft) throw new Error("JAVA_CONFIG_INVALID");
    return {
      ...projectDraft,
      main_class: projectDraft.main_class?.trim() ?? "",
      vm_arguments: parseJavaArguments(jvmArgumentsText),
      arguments: parseJavaArguments(applicationArgumentsText),
    };
  }
  function applySavedConfiguration(next: JavaConfiguration) {
    if (!mounted.current) return;
    setSavedConfiguration((previous) => ({
      ...next,
      jdks: next.jdks.length ? next.jdks : (previous?.jdks ?? []),
    }));
    setProjectDraft(next.project);
  }
  async function persistProjectDraft() {
    if (!savedConfiguration) throw new Error("JAVA_CONFIG_INVALID");
    const value = readProjectDraft();
    const next = await invoke<JavaConfiguration>("java_save_configuration", {
      directory,
      revision: savedConfiguration.revision,
      global: null,
      project: value,
    });
    applySavedConfiguration(next);
    return value;
  }
  async function refreshProjectDetection(replaceDraft = false) {
    await runPanelOperation(async () => {
      const [next, info] = await Promise.all([
        invoke<JavaConfiguration>("java_configuration", { directory }),
        invoke<{ modules: JavaModule[] }>("java_project", { directory }),
      ]);
      if (!mounted.current) return;
      if (replaceDraft || !projectDraft) applyLoadedConfiguration(next, info.modules);
      else {
        setModules(info.modules);
        // Tool detection must not rebase a draft onto an unreviewed configuration revision.
        // 环境检测不能把草稿更新为尚未确认的配置修订号，避免绕过保存冲突检查。
        setSavedConfiguration(
          (previous) =>
            previous && {
              ...previous,
              jdks: next.jdks,
              maven_home: next.maven_home,
            },
        );
      }
    });
  }
  async function chooseJavaHome() {
    if (operationPending.current) return;
    setOperationBusy(true);
    try {
      const paths = await invoke<string[] | null>("select_project_directory", {
        directory: projectDraft?.java_home || directory,
        title: tx("选择完整 JDK 主目录"),
      });
      if (mounted.current && paths?.[0]) updateProjectDraft({ java_home: paths[0] });
    } catch (reason) {
      if (mounted.current) setError(javaError(reason));
    } finally {
      setOperationBusy(false);
    }
  }
  async function stopTask(force = false) {
    if (!runningTask) return;
    await runPanelOperation(async () => {
      setStopping(true);
      await invoke("java_stop", {
        id: runningTask.spec.id,
        generation: runningTask.generation,
        force,
      });
      if (!mounted.current) return;
      setNotice(tx("已请求停止；进程仍在运行时可强制停止。"));
      await refreshTasks();
    });
  }
  async function stopBeforeRerun(task: JavaTask) {
    setStopping(true);
    await invoke("java_stop", {
      id: task.spec.id,
      generation: task.generation,
      force: false,
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const snapshot = await invoke<JavaTask[]>("java_tasks", { directory });
      if (!snapshot.some((current) => current.spec.id === task.spec.id && current.running)) return;
    }
    throw new Error(tx("任务尚未退出，请先强制停止后再运行。"));
  }
  async function startTask(action: string) {
    await runPanelOperation(async () => {
      setNotice("");
      if (action === "run" && projectDraft?.mode === "development") {
        if (manualMainClass && !projectDraft.main_class?.trim())
          throw new Error("JAVA_MAIN_CLASS_INVALID");
        if (!projectDraft.main_class?.trim() && preferredMainClasses.length > 1)
          throw new Error("JAVA_MAIN_CLASS_AMBIGUOUS");
      }
      const env = parseJavaEnvironment(environmentText);
      const value = await persistProjectDraft();
      if (!mounted.current) return;
      if (runningTask) await stopBeforeRerun(runningTask);
      if (!mounted.current) return;
      const task = await invoke<JavaTask>("java_start", {
        directory,
        config: value,
        action,
        environment: env,
      });
      if (!mounted.current) return;
      taskRequestVersion.current++;
      setTasks((previous) => [task, ...previous.filter((value) => value.spec.id !== task.spec.id)]);
      setSelectedTaskId(task.spec.id);
      setStopping(false);
    });
  }
  async function prepareClose() {
    if (closePending.current || operationPending.current) return false;
    closePending.current = true;
    setError("");
    setOperationBusy(true);
    try {
      if (projectDraft) await persistProjectDraft();
      return mounted.current;
    } catch (reason) {
      if (mounted.current) setError(javaError(reason));
      return false;
    } finally {
      closePending.current = false;
      setOperationBusy(false);
    }
  }
  prepareCloseRef.current = prepareClose;
  async function hidePanel() {
    if (await prepareClose()) close();
  }
  async function saveProjectDraft() {
    await runPanelOperation(async () => {
      await persistProjectDraft();
      if (mounted.current) setNotice(tx("配置已保存，下次构建和运行生效。"));
    });
  }
  const selectedModule = modules.find((value) => value.path === projectDraft?.module);
  const mainClasses = selectedModule?.main_classes ?? [];
  const bootMainClasses = mainClasses.filter((value) => value.spring_boot);
  const preferredMainClasses = bootMainClasses.length ? bootMainClasses : mainClasses;
  const customMainClass =
    manualMainClass ||
    (!!projectDraft?.main_class &&
      !mainClasses.some((value) => value.name === projectDraft.main_class));
  const selectedJavaHome =
    projectDraft?.java_home ||
    savedConfiguration?.jdks.find(
      (jdk) => jdk.available !== false && jdk.version === projectDraft?.java_version,
    )?.home ||
    "";
  return (
    <section
      ref={panel}
      className={`java-build-panel${expanded ? " java-panel-expanded" : ""}`}
      aria-label={tx("Java 构建与运行")}
      hidden={!visible}
      inert={!visible}
      style={
        {
          "--java-panel-height": `${panelSize.height}px`,
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
          aria-valuemin={panelSize.minimum}
          aria-valuemax={panelSize.maximum}
          aria-valuenow={panelSize.height}
          title={tx("拖动调整运行面板高度，双击恢复默认高度")}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            const height = panel.current?.getBoundingClientRect().height ?? panelSize.height;
            heightDrag.current = { y: event.clientY, height, next: height };
            panel.current?.setAttribute("data-resizing", "");
          }}
          onPointerMove={(event) => moveHeightDrag(event.clientY)}
          onPointerUp={(event) => {
            moveHeightDrag(event.clientY);
            finishHeightDrag(true);
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => finishHeightDrag(false)}
          onLostPointerCapture={() => finishHeightDrag(false)}
          onDoubleClick={() =>
            setPanelSize((previous) => ({ ...previous, height: clampHeight(380) }))
          }
          onKeyDown={(event) => {
            const height =
              event.key === "Home"
                ? panelSize.minimum
                : event.key === "End"
                  ? panelSize.maximum
                  : event.key === "ArrowUp"
                    ? panelSize.height + 24
                    : event.key === "ArrowDown"
                      ? panelSize.height - 24
                      : null;
            if (height === null) return;
            event.preventDefault();
            setPanelSize((previous) => ({ ...previous, height: clampHeight(height) }));
          }}
        />
      )}
      <header className="java-panel-header">
        <strong>{tx("构建与运行")}</strong>
        <span className="java-project-path" title={displayLocalPath(directory)}>
          {displayLocalPath(directory)}
        </span>
        <button type="button" disabled={busy} onClick={() => setComponentsOpen(true)}>
          {tx("管理环境")}
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
          onClick={() => void hidePanel()}
        >
          <ToolbarIcon name="close" />
        </button>
      </header>
      {projectDraft && savedConfiguration && (
        <details className="java-run-configuration" open>
          <summary>{tx("运行配置")}</summary>
          <div className="java-fields">
            <label>
              {tx("目标模块")}
              <select
                value={projectDraft.module}
                disabled={busy}
                onChange={(event) => {
                  setManualMainClass(false);
                  updateProjectDraft({ module: event.target.value, jar: "", main_class: "" });
                }}
              >
                {modules.map((value) => (
                  <option key={value.path} value={value.path}>
                    {value.name}
                    {value.packaging === "pom" ? " (pom)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tx("启动方式")}
              <select
                value={projectDraft.mode}
                disabled={busy}
                onChange={(event) =>
                  updateProjectDraft({ mode: event.target.value as JavaProjectConfig["mode"] })
                }
              >
                <option value="development">{tx("开发启动")}</option>
                <option value="jar">{tx("JAR 启动")}</option>
              </select>
            </label>
            <label>
              {tx("JDK 版本")}
              <select
                value={
                  savedConfiguration.jdks.some(
                    (jdk) => jdk.registered && jdk.home === projectDraft.java_home,
                  )
                    ? `home:${projectDraft.java_home}`
                    : projectDraft.java_version
                }
                disabled={busy}
                onChange={(event) => {
                  const jdk = savedConfiguration.jdks.find(
                    (jdk) => `home:${jdk.home}` === event.target.value,
                  );
                  updateProjectDraft({
                    java_version: jdk?.version ?? Number(event.target.value),
                    java_home: jdk?.home ?? "",
                  });
                }}
              >
                {supportedJavaVersions.map((version) => (
                  <option key={version} value={version}>
                    {`Java ${version}`} ·{" "}
                    {savedConfiguration.jdks.some(
                      (value) => value.available !== false && value.version === version,
                    )
                      ? tx("已检测到")
                      : tx("需选择或安装")}
                  </option>
                ))}
                {savedConfiguration.jdks.some((jdk) => jdk.registered) && (
                  <optgroup label={tx("手动添加的 JDK")}>
                    {savedConfiguration.jdks
                      .filter((jdk) => jdk.registered)
                      .map((jdk) => (
                        <option
                          key={jdk.home}
                          value={`home:${jdk.home}`}
                          disabled={jdk.available === false}
                        >
                          {`Java ${jdk.version} · ${displayLocalPath(jdk.home)}`}
                          {jdk.available === false ? ` · ${tx("当前不可用")}` : ""}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
              {selectedJavaHome && (
                <small className="java-local-path" title={displayLocalPath(selectedJavaHome)}>
                  {displayLocalPath(selectedJavaHome)}
                </small>
              )}
            </label>
            {projectDraft.mode === "development" && (
              <div className="java-main-class-field">
                <button
                  type="button"
                  className="java-main-class-refresh"
                  disabled={busy}
                  onClick={() => void refreshProjectDetection()}
                >
                  {tx("重新检测")}
                </button>
                <label>
                  {tx("启动主类")}
                  <select
                    aria-label={tx("启动主类")}
                    value={customMainClass ? "custom" : projectDraft.main_class || ""}
                    disabled={busy}
                    onChange={(event) => {
                      const manual = event.target.value === "custom";
                      setManualMainClass(manual);
                      if (!manual) updateProjectDraft({ main_class: event.target.value });
                    }}
                  >
                    <option value="">
                      {tx("自动识别")}
                      {preferredMainClasses.length === 1
                        ? ` · ${preferredMainClasses[0].name}`
                        : ""}
                    </option>
                    {mainClasses.map((value) => (
                      <option key={value.name} value={value.name}>
                        {value.name}
                        {value.spring_boot ? " · Spring Boot" : ""}
                      </option>
                    ))}
                    <option value="custom">{tx("手动填写")}</option>
                  </select>
                </label>
                {customMainClass && (
                  <label>
                    {tx("完整主类名")}
                    <input
                      aria-label={tx("完整主类名")}
                      value={projectDraft.main_class ?? ""}
                      disabled={busy}
                      placeholder={tx("例如 com.example.Application")}
                      onChange={(event) => {
                        setManualMainClass(true);
                        updateProjectDraft({ main_class: event.target.value });
                      }}
                    />
                  </label>
                )}
                {!projectDraft.main_class && !customMainClass && (
                  <p className="java-help">
                    {preferredMainClasses.length > 1
                      ? tx("检测到多个启动主类，请选择一个或手动填写。")
                      : preferredMainClasses.length === 0
                        ? tx("未检测到启动主类，可手动填写；留空时由 Maven 插件查找。")
                        : tx("优先使用带 @SpringBootApplication 的主类。")}
                  </p>
                )}
              </div>
            )}
            <div className="java-maven-field">
              <div>
                <label>{tx("Maven 配置")}</label>
                <button type="button" disabled={busy} onClick={() => setMavenOpen(true)}>
                  {tx("设置")}
                </button>
              </div>
              <select
                aria-label={tx("Maven 配置来源")}
                value={projectDraft.maven_scope}
                disabled={busy}
                onChange={(event) =>
                  updateProjectDraft({
                    maven_scope: event.target.value as JavaProjectConfig["maven_scope"],
                    maven:
                      event.target.value === "project" && !projectDraft.maven_configured
                        ? structuredClone(savedConfiguration.global)
                        : projectDraft.maven,
                    maven_configured:
                      event.target.value === "project" || projectDraft.maven_configured,
                  })
                }
              >
                <option value="global">{tx("系统全局配置")}</option>
                <option value="project">{tx("项目独立配置")}</option>
              </select>
            </div>
            <label>
              {tx("Maven Profile")}
              <input
                value={projectDraft.maven_profiles}
                disabled={busy}
                onChange={(event) => updateProjectDraft({ maven_profiles: event.target.value })}
              />
            </label>
            <label>
              {tx("Spring Profile")}
              <input
                value={projectDraft.spring_profiles}
                disabled={busy}
                onChange={(event) => updateProjectDraft({ spring_profiles: event.target.value })}
              />
            </label>
            {projectDraft.mode === "jar" && (
              <label>
                {tx("可执行 JAR")}
                <select
                  value={projectDraft.jar}
                  disabled={busy}
                  onChange={(event) => updateProjectDraft({ jar: event.target.value })}
                >
                  <option value="">{tx("先构建，再选择唯一 JAR")}</option>
                  {selectedModule?.jars.map((path) => (
                    <option key={path} value={path}>
                      {path}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <details className="java-advanced">
            <summary>{tx("高级设置")}</summary>
            <div className="java-fields">
              <label>
                {tx("完整 JDK 主目录")}
                <div className="java-path-input">
                  <input
                    value={displayLocalPath(projectDraft.java_home)}
                    disabled={busy}
                    placeholder={tx("留空自动检测所选版本")}
                    onChange={(event) => updateProjectDraft({ java_home: event.target.value })}
                  />
                  <button type="button" disabled={busy} onClick={() => void chooseJavaHome()}>
                    {tx("选择")}
                  </button>
                </div>
              </label>
              <label>
                {tx("JVM 参数")}
                <input
                  value={jvmArgumentsText}
                  disabled={busy}
                  onChange={(event) => setJvmArgumentsText(event.target.value)}
                />
              </label>
              <label>
                {tx("应用参数")}
                <input
                  value={applicationArgumentsText}
                  disabled={busy}
                  onChange={(event) => setApplicationArgumentsText(event.target.value)}
                />
              </label>
              <label>
                {tx("环境变量 · 仅本次运行")}
                <textarea
                  value={environmentText}
                  disabled={busy}
                  rows={2}
                  placeholder={tx("逐行填写 KEY=value")}
                  onChange={(event) => setEnvironmentText(event.target.value)}
                />
              </label>
            </div>
            <div className="java-options">
              <label className="java-checkbox">
                <input
                  type="checkbox"
                  checked={projectDraft.skip_tests}
                  disabled={busy}
                  onChange={(event) => updateProjectDraft({ skip_tests: event.target.checked })}
                />
                {tx("跳过测试")}
              </label>
              <label className="java-checkbox">
                <input
                  type="checkbox"
                  checked={projectDraft.offline}
                  disabled={busy}
                  onChange={(event) => updateProjectDraft({ offline: event.target.checked })}
                />
                {tx("Maven 离线模式")}
              </label>
              <button type="button" disabled={busy} onClick={() => void saveProjectDraft()}>
                {tx("保存配置")}
              </button>
            </div>
          </details>
        </details>
      )}
      <div className="java-task-toolbar">
        <span className={`java-task-state${runningTask ? " running" : ""}`}>
          {runningTask
            ? tx("进程运行中")
            : selectedTask
              ? selectedTask.code === 0
                ? tx("任务成功")
                : tx("已退出，退出码 {code}", { code: selectedTask.code ?? tx("未知") })
              : busy
                ? tx("正在读取…")
                : tx("未运行")}
        </span>
        <span className="java-toolbar-spacer" />
        <select
          aria-label={tx("Maven 构建目标")}
          value={buildGoal}
          disabled={busy || !!runningTask}
          onChange={(event) => setBuildGoal(event.target.value)}
        >
          <option value="build">{tx("打包 package")}</option>
          <option value="test">{tx("测试 test")}</option>
          <option value="install">{tx("安装 install")}</option>
        </select>
        <button
          type="button"
          disabled={busy || !!runningTask || !modules.length}
          onClick={() => void startTask(buildGoal)}
        >
          {tx("构建")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !selectedModule || selectedModule.packaging === "pom"}
          onClick={() => void startTask("run")}
        >
          {runningTask ? tx("重新运行") : tx("运行")}
        </button>
        <button type="button" disabled={!runningTask || busy} onClick={() => void stopTask()}>
          {tx("停止")}
        </button>
        {stopping && runningTask && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void stopTask(true)}
          >
            {tx("强制停止")}
          </button>
        )}
      </div>
      {error && (
        <div className="java-error" role="alert">
          {error}
          <button type="button" disabled={busy} onClick={() => void refreshProjectDetection()}>
            {tx("重新检测")}
          </button>
          {projectDraft && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void refreshProjectDetection(true)}
            >
              {tx("重新读取已保存的配置")}
            </button>
          )}
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
              value={selectedTaskId ?? ""}
              onChange={(event) => setSelectedTaskId(event.target.value)}
            >
              {tasks.map((task) => (
                <option key={task.spec.id} value={task.spec.id}>
                  {task.task.name} · {task.task.action} ·{" "}
                  {new Date(task.task.created).toLocaleTimeString()}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="java-task-output">
        {selectedTask ? (
          <TerminalView
            key={selectedTask.spec.id}
            existingOnly
            directory={selectedTask.spec.directory}
            session={{ id: selectedTask.spec.id, name: selectedTask.task.name, shell: "default" }}
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
          <p className="java-help">{tx("选择模块后构建或运行，输出显示在这里。")}</p>
        )}
      </div>
      {(mavenOpen || componentsOpen) && (
        <dialog
          ref={dialog}
          className="java-settings-dialog"
          aria-label={mavenOpen ? tx("Maven 设置") : tx("Java 开发环境")}
          onCancel={(event) => {
            if (operationPending.current) {
              event.preventDefault();
              return;
            }
            dismissDialog();
          }}
          {...backdrop}
        >
          <header>
            <h2>{mavenOpen ? tx("Maven 设置") : tx("Java 开发环境")}</h2>
            <button type="button" aria-label={tx("关闭")} disabled={busy} onClick={dismissDialog}>
              <ToolbarIcon name="close" />
            </button>
          </header>
          {mavenOpen && savedConfiguration ? (
            <MavenSettings
              directory={directory}
              initial={{
                ...savedConfiguration,
                project: projectDraft ?? savedConfiguration.project,
              }}
              initialScope={projectDraft?.maven_scope}
              busyChanged={setOperationBusy}
              saved={(next) => {
                applySavedConfiguration(next);
                setNotice(tx("配置已保存，下次构建和运行生效。"));
              }}
              close={() => setMavenOpen(false)}
            />
          ) : (
            <JavaComponents changed={() => void refreshProjectDetection()} />
          )}
        </dialog>
      )}
    </section>
  );
}
