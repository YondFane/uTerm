import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { tx } from "./i18n";
import { displayLocalPath } from "./file-target";
import type { Workspace } from "./workspace";

export function projectRunRootKey(path: string) {
  const display = displayLocalPath(path);
  const value = display.replace(/[\\/]+$/, "");
  return /^[a-z]:[\\/]|^\\\\/i.test(display) ? value.toLowerCase() : value;
}

export function findRunProject(workspace: Workspace, directory: string) {
  const target = projectRunRootKey(directory);
  for (const project of workspace.projects) {
    if (projectRunRootKey(project.directory) === target) return { project, worktree: null };
    const worktree = project.worktrees?.find((item) => projectRunRootKey(item.path) === target);
    if (worktree) return { project, worktree };
  }
  return null;
}

export interface ProjectRunSummary {
  java: number;
  python: number;
  java_roots?: string[];
  python_roots?: string[];
}

export interface ProjectRunStatus {
  summary: ProjectRunSummary | null;
  stale: boolean;
}

export function runningProjectRoots(summary: ProjectRunSummary | null | undefined) {
  const roots = new Map<string, "java" | "python">();
  for (const language of ["java", "python"] as const)
    for (const directory of summary?.[`${language}_roots`] ?? [])
      roots.set(projectRunRootKey(directory), language);
  return roots;
}

function sameRoots(previous: string[] = [], next: string[] = []) {
  return previous.length === next.length && previous.every((root, index) => root === next[index]);
}

export function projectRunTitle(language: "java" | "python", status: ProjectRunStatus) {
  const label = language === "java" ? tx("Java 构建与运行") : tx("Python 运行");
  const count = status.summary?.[language];
  if (status.stale)
    return `${label} · ${tx("运行状态暂不可用")}${count === undefined ? "" : ` · ${tx("上次确认：{count} 个项目运行中", { count })}`}`;
  if (count === undefined) return `${label} · ${tx("正在读取运行状态…")}`;
  return `${label} · ${count ? tx("运行中：{count} 个项目", { count }) : tx("暂无运行项目")}`;
}

export function useProjectRunSummary(enabled: boolean) {
  const [status, setStatus] = useState<ProjectRunStatus>({ summary: null, stale: false });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let pending = false;
    let refreshAgain = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (disposed) return;
      if (pending) {
        refreshAgain = true;
        return;
      }
      clearTimeout(timer);
      pending = true;
      try {
        const summary = await invoke<ProjectRunSummary>("project_run_summary");
        if (!disposed)
          setStatus((previous) =>
            !previous.stale &&
            previous.summary?.java === summary.java &&
            previous.summary?.python === summary.python &&
            sameRoots(previous.summary?.java_roots, summary.java_roots) &&
            sameRoots(previous.summary?.python_roots, summary.python_roots)
              ? previous
              : { summary, stale: false },
          );
      } catch {
        if (!disposed)
          setStatus((previous) => (previous.stale ? previous : { ...previous, stale: true }));
      } finally {
        pending = false;
        if (!disposed) {
          if (refreshAgain) {
            refreshAgain = false;
            void refresh();
          } else timer = setTimeout(refresh, 1500);
        }
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
  return status;
}
