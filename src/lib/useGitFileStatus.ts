import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { gitFileStates, type GitTreeSnapshot } from "./git-file-status";
import { gitReadError } from "./git-snapshot";

interface GitFileStatusResult {
  directory: string;
  snapshot: GitTreeSnapshot | null;
  error: string;
}

const refreshDelay = 4000;

export function useGitFileStatus(directory: string, enabled: boolean, revision: number) {
  const [result, setResult] = useState<GitFileStatusResult | null>(null);
  const pendingReads = useRef(new Map<string, Promise<GitTreeSnapshot | null>>());
  const current = enabled && result?.directory === directory ? result : null;
  const states = useMemo(
    () => gitFileStates(directory, current?.snapshot ?? null),
    [directory, current?.snapshot],
  );

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout>;

    async function refresh(force = false) {
      if (disposed || busy) return;
      clearTimeout(timer);
      if (document.hidden && !force) {
        timer = setTimeout(() => void refresh(), refreshDelay);
        return;
      }

      busy = true;
      let pending: Promise<GitTreeSnapshot | null> | undefined;
      try {
        // Reads outlive effect cleanup, so refreshes wait only for the same root's pending read.
        // 读取会延续到副作用清理之后，因此刷新仅等待同一根目录的未完成读取。
        const previous = pendingReads.current.get(directory);
        if (previous) await previous.catch(() => null);
        if (disposed) return;
        pending = invoke<GitTreeSnapshot | null>("git_file_status", { directory });
        pendingReads.current.set(directory, pending);
        const snapshot = (await pending) ?? null;
        if (!disposed)
          setResult((previous) =>
            previous?.directory === directory &&
            !previous.error &&
            JSON.stringify(previous.snapshot) === JSON.stringify(snapshot)
              ? previous
              : { directory, snapshot, error: "" },
          );
      } catch (reason) {
        if (!disposed) setResult({ directory, snapshot: null, error: gitReadError(reason) });
      } finally {
        if (pending && pendingReads.current.get(directory) === pending)
          pendingReads.current.delete(directory);
        busy = false;
        if (!disposed) timer = setTimeout(() => void refresh(), refreshDelay);
      }
    }

    const refreshWhenVisible = () => {
      if (!document.hidden) void refresh(true);
    };
    void refresh(true);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      // IPC reads cannot be canceled; disposal blocks stale updates and rescheduling.
      // IPC 读取无法取消；清理标记用于阻止旧结果更新和重新安排定时器。
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [directory, enabled, revision]);

  return { states, error: current?.error ?? "", truncated: current?.snapshot?.truncated ?? false };
}
