import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { javaError, type JavaConfiguration, type MavenConfig } from "../lib/java-build";
import { displayLocalPath } from "../lib/file-target";

type MavenScope = "global" | "project";

function projectMavenDraft(configuration: JavaConfiguration): MavenConfig {
  const project = configuration.project;
  return structuredClone(
    project.maven_configured || project.maven_scope === "project"
      ? project.maven
      : configuration.global,
  );
}

function mergeMavenSave(
  previous: JavaConfiguration,
  next: JavaConfiguration,
  projectWasSaved: boolean,
): JavaConfiguration {
  // Save replies skip JDK probing; global-only updates must also preserve the parent run draft.
  // 保存响应不会重新探测 JDK；仅更新全局设置时还需保留父面板的运行草稿。
  return {
    ...next,
    jdks: previous.jdks,
    ...(projectWasSaved ? {} : { project: previous.project, configured: previous.configured }),
  };
}

export function MavenSettings({
  directory,
  initial,
  initialScope = "global",
  saved,
  close,
  busyChanged,
}: {
  directory?: string;
  initial?: JavaConfiguration;
  initialScope?: MavenScope;
  saved?: (value: JavaConfiguration) => void;
  close?: () => void;
  busyChanged?: (value: boolean) => void;
}) {
  useUiLanguage();
  const [savedConfiguration, setSavedConfiguration] = useState<JavaConfiguration | null>(
    initial ?? null,
  );
  const [activeScope, setActiveScope] = useState<MavenScope>(directory ? initialScope : "global");
  const [globalDraft, setGlobalDraft] = useState<MavenConfig | null>(initial?.global ?? null);
  const [projectDraft, setProjectDraft] = useState<MavenConfig | null>(
    initial ? projectMavenDraft(initial) : null,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const mounted = useRef(true);
  const operationPending = useRef(false);
  const parentActionPending = useRef(false);
  const dirtyScopes = useRef({ global: false, project: false });
  const busyChangedRef = useRef(busyChanged);
  busyChangedRef.current = busyChanged;
  function setOperationBusy(value: boolean) {
    operationPending.current = value;
    if (!mounted.current) return;
    setBusy(value);
  }
  function applyLoadedSettings(configuration: JavaConfiguration, preserve?: MavenScope) {
    setSavedConfiguration(configuration);
    // Saving one scope leaves the other scope's unsaved form intact.
    // 保存一个层级时，保留另一层级尚未保存的表单草稿。
    if (preserve !== "global" || !dirtyScopes.current.global) {
      setGlobalDraft(structuredClone(configuration.global));
      dirtyScopes.current.global = false;
    }
    if (preserve !== "project" || !dirtyScopes.current.project) {
      setProjectDraft(projectMavenDraft(configuration));
      dirtyScopes.current.project = false;
    }
  }
  async function reloadSettings() {
    if (operationPending.current) return;
    setOperationBusy(true);
    setError("");
    try {
      const value = await invoke<JavaConfiguration>("java_configuration", {
        directory: directory ?? null,
      });
      if (mounted.current) applyLoadedSettings(value);
    } catch (reason) {
      if (mounted.current) setError(javaError(reason));
    } finally {
      setOperationBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (!initial) void reloadSettings();
    return () => {
      mounted.current = false;
      if (parentActionPending.current) busyChangedRef.current?.(false);
    };
  }, []);
  const activeDraft = activeScope === "global" ? globalDraft : projectDraft;
  const updateActiveDraft = (patch: Partial<MavenConfig>) => {
    dirtyScopes.current[activeScope] = true;
    return activeScope === "global"
      ? setGlobalDraft((previous) => previous && { ...previous, ...patch })
      : setProjectDraft((previous) => previous && { ...previous, ...patch });
  };
  async function choosePath(kind: "home" | "settings" | "repository") {
    if (!activeDraft || operationPending.current) return;
    setOperationBusy(true);
    parentActionPending.current = true;
    busyChangedRef.current?.(true);
    setError("");
    try {
      const path = await invoke<string | null>("java_select_path", {
        kind,
        directory: activeDraft[kind] || directory || "",
      });
      if (mounted.current && path) updateActiveDraft({ [kind]: displayLocalPath(path) });
    } catch (reason) {
      if (mounted.current) setError(javaError(reason));
    } finally {
      setOperationBusy(false);
      parentActionPending.current = false;
      if (mounted.current) busyChangedRef.current?.(false);
    }
  }
  async function saveSettings(inherit = false) {
    if (!savedConfiguration || !activeDraft || operationPending.current) return;
    setOperationBusy(true);
    // Keep the draft's scope fixed until a write or native path selection finishes.
    // 写入或原生路径选择完成前固定草稿所属层级，避免结果落到另一份配置。
    parentActionPending.current = true;
    busyChangedRef.current?.(true);
    setError("");
    setMessage("");
    try {
      const projectWasSaved = activeScope === "project" || inherit;
      const projectUpdate = projectWasSaved
        ? {
            ...savedConfiguration.project,
            maven_scope: inherit ? "global" : "project",
            maven_configured: true,
            maven: inherit ? savedConfiguration.project.maven : projectDraft,
          }
        : null;
      const next = await invoke<JavaConfiguration>("java_save_configuration", {
        directory: directory ?? null,
        revision: savedConfiguration.revision,
        global: projectWasSaved ? null : activeDraft,
        project: projectUpdate,
      });
      if (!mounted.current) return;
      const merged = mergeMavenSave(savedConfiguration, next, projectWasSaved);
      applyLoadedSettings(merged, projectWasSaved ? "global" : "project");
      saved?.(merged);
      setMessage(tx("配置已保存，下次构建和运行生效。"));
    } catch (reason) {
      if (mounted.current) setError(javaError(reason));
    } finally {
      setOperationBusy(false);
      parentActionPending.current = false;
      if (mounted.current) busyChangedRef.current?.(false);
    }
  }
  return (
    <section className="maven-settings" aria-label={tx("Maven 设置")}>
      <div className="java-scope-tabs" role="group" aria-label={tx("Maven 配置层级")}>
        <button
          type="button"
          disabled={busy}
          aria-pressed={activeScope === "global"}
          onClick={() => setActiveScope("global")}
        >
          {tx("系统全局配置")}
        </button>
        {directory && (
          <button
            type="button"
            disabled={busy}
            aria-pressed={activeScope === "project"}
            onClick={() => setActiveScope("project")}
          >
            {tx("项目独立配置")}
          </button>
        )}
      </div>
      <p className="java-help">
        {activeScope === "global"
          ? tx("所有继承全局配置的项目共用以下设置。")
          : tx("仅影响当前项目，保存后启用项目独立配置。")}
      </p>
      {activeDraft && (
        <div className="maven-setting-fields">
          <label>
            {tx("Maven 来源")}
            <select
              value={activeDraft.distribution}
              disabled={busy}
              onChange={(event) =>
                updateActiveDraft({
                  distribution: event.target.value as MavenConfig["distribution"],
                })
              }
            >
              <option value="local">{tx("本机 Maven")}</option>
              <option value="managed">{tx("托管 Maven")}</option>
            </select>
          </label>
          <label>
            {tx("Maven 主目录")}
            <div className="java-path-input">
              <input
                aria-label={tx("Maven 主目录")}
                value={displayLocalPath(activeDraft.home)}
                disabled={busy || activeDraft.distribution !== "local"}
                placeholder={tx("留空自动检测本机 Maven")}
                onChange={(event) => updateActiveDraft({ home: event.target.value })}
              />
              <button
                type="button"
                aria-label={tx("选择 Maven 主目录")}
                disabled={busy || activeDraft.distribution !== "local"}
                onClick={() => void choosePath("home")}
              >
                {tx("选择")}
              </button>
            </div>
          </label>
          <label>
            {tx("用户设置文件 · settings.xml")}
            <div className="java-path-input">
              <input
                aria-label={tx("用户设置文件 · settings.xml")}
                value={displayLocalPath(activeDraft.settings)}
                disabled={busy}
                placeholder={tx("留空使用 Maven 默认设置文件")}
                onChange={(event) => updateActiveDraft({ settings: event.target.value })}
              />
              <button
                type="button"
                aria-label={tx("选择 Maven 设置文件")}
                disabled={busy}
                onClick={() => void choosePath("settings")}
              >
                {tx("选择")}
              </button>
            </div>
          </label>
          <label>
            {tx("Maven 本地仓库")}
            <div className="java-path-input">
              <input
                aria-label={tx("Maven 本地仓库")}
                value={displayLocalPath(activeDraft.repository)}
                disabled={busy}
                placeholder={tx("留空由 settings.xml 或 Maven 默认值决定")}
                onChange={(event) => updateActiveDraft({ repository: event.target.value })}
              />
              <button
                type="button"
                aria-label={tx("选择 Maven 本地仓库")}
                disabled={busy}
                onClick={() => void choosePath("repository")}
              >
                {tx("选择")}
              </button>
            </div>
          </label>
          <label className="java-checkbox">
            <input
              type="checkbox"
              checked={activeDraft.wrapper}
              disabled={busy}
              onChange={(event) => updateActiveDraft({ wrapper: event.target.checked })}
            />
            {tx("优先使用项目 Maven Wrapper")}
          </label>
          <p className="java-help">
            {tx("没有 Wrapper 时使用所选 Maven。项目独立配置不会修改系统环境变量或项目 POM。")}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="java-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="java-form-actions">
        <button type="button" disabled={busy} onClick={() => void reloadSettings()}>
          {tx("重新读取")}
        </button>
        {activeScope === "project" && (
          <button
            type="button"
            disabled={busy || !globalDraft}
            onClick={() => {
              dirtyScopes.current.project = true;
              setProjectDraft(globalDraft && structuredClone(globalDraft));
            }}
          >
            {tx("从全局复制")}
          </button>
        )}
        {activeScope === "project" && savedConfiguration?.project.maven_scope === "project" && (
          <button type="button" disabled={busy} onClick={() => void saveSettings(true)}>
            {tx("恢复继承全局")}
          </button>
        )}
        {close && (
          <button type="button" disabled={busy} onClick={close}>
            {tx("取消")}
          </button>
        )}
        <button
          type="button"
          className="primary"
          disabled={busy || !activeDraft}
          onClick={() => void saveSettings()}
        >
          {activeScope === "global" ? tx("保存全局配置") : tx("保存项目配置")}
        </button>
      </div>
    </section>
  );
}
