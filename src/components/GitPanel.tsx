import { localizeMessage } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { tx, getUiLanguage } from "../lib/i18n";
import type { ReactNode } from "react";
import { HistoryPager, commitGraph, formatCommitTimestamp } from "../lib/git-history";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToolbarIcon } from "./SidebarIcon";
import { hasCurrentWorkingDiff, isStaleWorkingDiffError, sideBySideDiff } from "../lib/git-diff";
import { gitFilePath, gitReadError, sameGitSnapshot } from "../lib/git-snapshot";
import type { GitChange, GitSnapshot } from "../lib/git-snapshot";
import { GitBranchTree } from "./GitBranchTree";
import { referenceView, type GitReference } from "../lib/git-references";
type Change = GitChange;
type Snapshot = GitSnapshot;
interface Commit {
  id: string;
  parents: string[];
  subject: string;
  message?: string;
  author: string;
  timestamp: string;
}
export function GitPanel({
  resizeHandle,
  headerActions,
  directory,
  expanded,
  diffTarget,
  onDiffPathChange,
  onOpenFile,
  onExpandedChange,
  disabled = false,
  beforeMutation = (action) => void action(),
  onChanged,
  refreshRevision = 0,
  onBusyChange,
  onWorktreeCreated,
}: {
  resizeHandle: ReactNode;
  headerActions: ReactNode;
  directory: string;
  expanded: boolean;
  diffTarget?: HTMLElement | null;
  onDiffPathChange?: (path: string | null) => void;
  onOpenFile?: (path: string) => void;
  onExpandedChange: (expanded: boolean) => void;
  disabled?: boolean;
  beforeMutation?: (action: () => Promise<void>) => void;
  onChanged?: () => void;
  refreshRevision?: number;
  onBusyChange?: (busy: boolean) => void;
  onWorktreeCreated?: (root: string) => Promise<void>;
}) {
  useUiLanguage();

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<"changes" | "compare" | "history" | "working">("changes");
  const [preview, setPreview] = useState<{ full_name: string; name: string; oid?: string | null }>(
    () => ({
      full_name: referenceView(directory).selected,
      name: referenceView(directory).selected,
    }),
  );
  const [workingReference, setWorkingReference] = useState<GitReference | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [base, setBase] = useState("");
  const historyPager = useRef(new HistoryPager<Commit>());
  const [history, setHistory] = useState(historyPager.current.state);
  const commits = history.items;
  const [showGraph, setShowGraph] = useState(true);
  const graph = useMemo(() => (showGraph ? commitGraph(commits) : []), [commits, showGraph]);
  const graphWidth = Math.max(1, ...graph.map((row) => row.width)) * 16 + 8;
  const graphColors = ["#78b85b", "#d6a04a", "#728ee5", "#b778cf", "#54b7af", "#d87878"];
  const [selectedCommit, setCommit] = useState<(Commit & { directory: string }) | null>(null);
  const commit = selectedCommit?.directory === directory ? selectedCommit : null;
  useEffect(() => setCommit(null), [directory]);
  const [files, setFiles] = useState<Change[]>([]);
  const [selection, setSelection] = useState<{ path: string; mode: string } | null>(null);
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | null>(null);
  const [sideBySide, setSideBySide] = useState(false);
  const diffRows = useMemo(
    () => (sideBySide && diff ? sideBySideDiff(diff.text) : []),
    [sideBySide, diff],
  );
  const [diffFocused, setDiffFocused] = useState(false);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [mutating, setMutating] = useState(false);
  const [menu, setMenu] = useState<{
    change: Change;
    head: string | null;
    path: string | null;
    x: number;
    y: number;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{ change: Change; head: string | null } | null>(
    null,
  );
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const alive = useRef(false);
  const changing = useRef(false);
  const [loading, setLoading] = useState(false);
  const [diffRevision, setDiffRevision] = useState(0);
  const [revision, setRevision] = useState(0);
  const request = useRef(0);
  const selectedChange = useRef(false);
  // Refresh working diffs after the snapshot succeeds, avoiding duplicate reads.
  // 工作目录差异在快照成功后再刷新，避免重复读取。
  const diffRefresh = tab === "changes" ? diffRevision : revision;
  const refresh = () => setRevision((value) => value + 1);
  function previewReference(reference: GitReference, navigate = true) {
    setPreview(reference);
    if (!navigate) return;
    setCommit(null);
    setSelection(null);
    setDiff(null);
    setShowGraph(true);
    setTab("history");
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, [directory]);
  function closeMenu(focus = false) {
    setMenu(null);
    if (focus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!menu) return;
    popup.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node)) closeMenu();
    };
    const dismiss = () => closeMenu();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu]);
  useEffect(() => {
    closeMenu();
    setConfirmation(null);
  }, [tab, directory]);
  useEffect(() => {
    if (!confirmation) return;
    const current = dialog.current;
    current?.showModal();
    cancel.current?.focus();
    return () => {
      current?.close();
    };
  }, [confirmation]);
  function openMenu(change: Change, button: HTMLButtonElement, x: number, y: number) {
    if (disabled || changing.current || confirmation || tab !== "changes") return;
    trigger.current = button;
    setMenu({
      change,
      head: snapshot?.head ?? null,
      path: snapshot ? gitFilePath(directory, snapshot.root, change.path) : null,
      x: Math.max(4, Math.min(x, window.innerWidth - 224)),
      y: Math.max(4, Math.min(y, window.innerHeight - 96)),
    });
  }
  function closeConfirmation() {
    dialog.current?.close();
    setConfirmation(null);
    trigger.current?.focus();
  }
  function rollback() {
    if (!confirmation || disabled || changing.current) return;
    const target = confirmation;
    closeConfirmation();
    beforeMutation(async () => {
      // A delayed save must not roll back a repository the user has left.
      // 延迟保存后，不能回滚用户已经离开的仓库。
      if (!alive.current || changing.current) return;
      changing.current = true;
      setMutating(true);
      setMutationError("");
      try {
        await invoke("git_rollback_file", {
          directory,
          expected: target.change,
          head: target.head,
        });
        if (alive.current) {
          setSelection(null);
          setDiff(null);
        }
      } catch (reason) {
        if (alive.current) setMutationError(String(reason));
      } finally {
        changing.current = false;
        if (alive.current) {
          setMutating(false);
          refresh();
          onChanged?.();
          trigger.current?.focus();
        }
      }
    });
  }
  useEffect(() => {
    onDiffPathChange?.(selection?.path ?? null);
    return () => onDiffPathChange?.(null);
  }, [selection?.path, onDiffPathChange]);
  useEffect(() => {
    if (!selection) {
      onExpandedChange(false);
      setDiffFocused(false);
    }
  }, [selection, onExpandedChange]);
  useEffect(() => () => onExpandedChange(false), [onExpandedChange]);
  useEffect(() => {
    selectedChange.current = tab === "changes" && selection !== null;
  }, [tab, selection]);
  useEffect(() => {
    let disposed = false,
      busy = false;
    async function load() {
      if (busy || changing.current || branchBusy || document.hidden) return;
      busy = true;
      try {
        const next = await invoke<Snapshot>("git_snapshot", { directory });
        if (!disposed) {
          setSnapshot((previous) => (sameGitSnapshot(previous, next) ? previous : next));
          setError("");
          if (selectedChange.current) setDiffRevision((value) => value + 1);
        }
      } catch (reason) {
        if (!disposed) {
          const message = gitReadError(reason);
          setError(message);
          if (!message) {
            setSnapshot(null);
            setSelection(null);
            setDiff(null);
            setFiles([]);
            setCommit(null);
            setWorkingReference(null);
            setBase("");
            setPreview({ full_name: "HEAD", name: "HEAD" });
            historyPager.current.invalidate();
            setHistory({ items: [], loading: false, more: false, error: "" });
          }
        }
      } finally {
        busy = false;
      }
    }
    void load();
    const timer = tab === "changes" ? window.setInterval(() => void load(), 4000) : undefined;
    const visible = () => {
      if (!document.hidden) {
        // The revision effect performs the read; starting one here duplicates it.
        // revision 对应的副作用会执行读取，此处再次启动会产生重复请求。
        refresh();
      }
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [directory, revision, tab, refreshRevision, branchBusy]);
  useEffect(() => {
    setSelection(null);
    setDiff(null);
    setError("");
  }, [tab, base, commit, preview.full_name, workingReference]);
  useEffect(() => {
    if (tab !== "history") return;
    const pager = historyPager.current;
    if (preview.oid === null) {
      pager.invalidate();
      setHistory({ items: [], loading: false, more: false, error: "" });
      return;
    }
    void pager.load(
      (skip) => invoke<Commit[]>("git_history", { directory, skip, reference: preview.full_name }),
      setHistory,
      true,
    );
    return () => pager.invalidate();
  }, [directory, tab, revision, refreshRevision, preview.full_name, preview.oid]);
  useEffect(() => {
    if (
      tab === "changes" ||
      (tab === "compare" ? !base : tab === "working" ? !workingReference : !commit)
    ) {
      setFiles([]);
      setLoading(false);
      return;
    }
    let disposed = false;
    setFiles([]);
    setLoading(true);
    (tab === "working"
      ? invoke<Change[]>("git_working_comparison", {
          directory,
          reference: workingReference?.full_name,
        })
      : invoke<Change[]>("git_files", {
          directory,
          reference: tab === "compare" ? base : commit?.id,
          compare: tab === "compare",
        })
    )
      .then((result) => {
        if (!disposed) {
          setFiles(result);
          setError("");
        }
      })
      .catch((reason) => {
        if (!disposed) setError(gitReadError(reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [directory, tab, base, commit, snapshot, revision, refreshRevision, workingReference]);
  useEffect(() => {
    const current = ++request.current;
    if (!selection) setDiff(null);
    if (!selection) return;
    if (
      tab === "changes" &&
      !hasCurrentWorkingDiff(snapshot?.changes ?? [], selection.path, selection.mode)
    ) {
      setSelection(null);
      setDiff(null);
      return;
    }
    invoke<{ text: string; truncated: boolean }>("git_diff", {
      directory,
      ...selection,
      reference:
        tab === "compare"
          ? base
          : tab === "history"
            ? commit?.id
            : tab === "working"
              ? workingReference?.full_name
              : null,
    })
      .then((result) => {
        if (current === request.current) {
          setDiff(result);
          setError("");
        }
      })
      .catch((reason) => {
        if (current !== request.current) return;
        if (isStaleWorkingDiffError(reason)) {
          setSelection(null);
          setDiff(null);
          setError("");
          setRevision((value) => value + 1);
          return;
        }
        setError(gitReadError(reason));
      });
    return () => {
      request.current++;
    };
  }, [directory, selection, base, commit, tab, snapshot, diffRefresh, workingReference]);
  const navigableFiles =
    tab === "changes"
      ? [
          ...(snapshot?.changes ?? [])
            .filter((change) => change.index !== " " && change.index !== "?")
            .map((change) => ({ path: change.path, mode: "staged" })),
          ...(snapshot?.changes ?? [])
            .filter((change) => change.working !== " ")
            .map((change) => ({ path: change.path, mode: "working" })),
        ]
      : files.map((change) => ({
          path: change.path,
          mode:
            tab === "compare"
              ? "compare"
              : tab === "working"
                ? change.index === "?"
                  ? "working"
                  : "reference-working"
                : "commit",
        }));
  const selectedFileIndex = navigableFiles.findIndex(
    (file) => file.path === selection?.path && file.mode === selection.mode,
  );
  function navigateFile(offset: number) {
    if (selectedFileIndex < 0) return;
    const next = navigableFiles[selectedFileIndex + offset];
    if (!next) return;
    setDiff(null);
    setSelection(next);
  }
  function fileList(changes: Change[], mode: string) {
    return (
      <div className="git-files">
        {changes.map((change) => (
          <button
            key={change.path}
            className={`git-file${selection?.path === change.path && selection.mode === mode ? " selected" : ""}`}
            title={change.original ? `${change.original} → ${change.path}` : change.path}
            aria-haspopup={tab === "changes" ? "menu" : undefined}
            disabled={mutating || branchBusy}
            onContextMenu={(event) => {
              if (tab !== "changes") return;
              event.preventDefault();
              openMenu(change, event.currentTarget, event.clientX, event.clientY);
            }}
            onKeyDown={(event) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu(change, event.currentTarget, rect.left, rect.bottom);
              }
            }}
            onClick={() => {
              setDiff(null);
              setSelection({ path: change.path, mode });
              onExpandedChange(true);
            }}
          >
            <span
              className={`git-status status-${change.index === "?" ? "A" : mode === "working" ? change.working.trim() || change.index : change.index}`}
            >
              {change.index === "?"
                ? "U"
                : mode === "working"
                  ? change.working.trim() || change.index
                  : change.index}
            </span>
            <span>{change.path}</span>
          </button>
        ))}
      </div>
    );
  }
  const diffView = selection && (
    <section className="git-diff" aria-label={tx("{p0} 的差异", { p0: selection.path })}>
      <header>
        <span className="git-diff-path" title={selection.path}>
          {selection.path}
        </span>
        <div className="git-diff-actions">
          <button
            disabled={!diff}
            onClick={() => {
              if (diff)
                void navigator.clipboard
                  .writeText(diff.text)
                  .catch((reason) => setError(gitReadError(reason)));
            }}
          >
            {tx("复制 Diff")}
          </button>
          <button
            className="icon-button"
            title={sideBySide ? tx("切换统一 Diff") : tx("切换左右对比")}
            aria-label={sideBySide ? tx("切换统一 Diff") : tx("切换左右对比")}
            aria-pressed={sideBySide}
            onClick={() => setSideBySide((value) => !value)}
          >
            <ToolbarIcon name="compare" />
          </button>
          <button
            className="icon-button"
            title={tx("上一个文件")}
            aria-label={tx("上一个文件")}
            disabled={loading || selectedFileIndex <= 0}
            onClick={() => navigateFile(-1)}
          >
            <ToolbarIcon name="previous" />
          </button>
          <button
            className="icon-button"
            title={tx("下一个文件")}
            aria-label={tx("下一个文件")}
            disabled={
              loading || selectedFileIndex < 0 || selectedFileIndex >= navigableFiles.length - 1
            }
            onClick={() => navigateFile(1)}
          >
            <ToolbarIcon name="next" />
          </button>
          <button
            className="icon-button"
            title={tx("全展示")}
            aria-label={tx("全展示：在中栏显示差异，保留工具面板")}
            aria-pressed={expanded}
            onClick={() => {
              setDiffFocused(true);
              onExpandedChange(true);
            }}
          >
            <ToolbarIcon name="maximize" />
          </button>
          <button
            className="icon-button"
            title={tx("工具面板全展示")}
            aria-label={tx("工具面板全展示：保留主工作区，差异铺满工具面板")}
            aria-pressed={diffFocused && !expanded}
            onClick={() => {
              setDiffFocused(true);
              onExpandedChange(false);
            }}
          >
            <ToolbarIcon name="splitRight" />
          </button>
          <button
            className="icon-button"
            title={tx("关闭差异")}
            aria-label={tx("关闭差异")}
            onClick={() => {
              setSelection(null);
              setDiff(null);
              setDiffFocused(false);
              onExpandedChange(false);
            }}
          >
            <ToolbarIcon name="close" />
          </button>
        </div>
      </header>
      {diff ? (
        <>
          {diff.truncated && (
            <p className="inspector-message">{tx("Diff 较大，仅显示前 2 MB 或 10,000 行。")}</p>
          )}
          {sideBySide && diff.text ? (
            <div className="git-side-diff" role="region" aria-label={tx("左右对比")} tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th>{tx("修改前")}</th>
                    <th>{tx("修改后")}</th>
                  </tr>
                </thead>
                <tbody>
                  {diffRows.map((row, index) =>
                    row.header !== undefined ? (
                      <tr key={index}>
                        <td colSpan={2} className="diff-hunk">
                          {row.header || " "}
                        </td>
                      </tr>
                    ) : (
                      <tr key={index}>
                        {[row.left, row.right].map((cell, side) => (
                          <td key={side} className={cell ? `diff-${cell.kind}` : "diff-empty"}>
                            {cell && (
                              <>
                                <span className="diff-line-number">{cell.line}</span>
                                {cell.text || " "}
                              </>
                            )}
                          </td>
                        ))}
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <pre>
              {diff.text
                ? diff.text.split("\n").map((line, index) => (
                    <div
                      key={index}
                      className={
                        line.startsWith("+") && !line.startsWith("+++")
                          ? "diff-added"
                          : line.startsWith("-") && !line.startsWith("---")
                            ? "diff-removed"
                            : line.startsWith("@@")
                              ? "diff-hunk"
                              : ""
                      }
                    >
                      {line || " "}
                    </div>
                  ))
                : tx("没有差异。")}
            </pre>
          )}
        </>
      ) : (
        !error && <p className="inspector-message">{tx("正在读取 Diff…")}</p>
      )}
    </section>
  );
  return (
    <aside
      className="git-panel"
      data-diff-focused={(!!selection && diffFocused && !expanded) || undefined}
      aria-label={tx("Git 面板")}
    >
      {resizeHandle}
      <header className="inspector-header">{headerActions}</header>
      <div className="git-reference-layout">
        <GitBranchTree
          key={directory}
          directory={directory}
          disabled={disabled || mutating}
          refreshRevision={refreshRevision + revision}
          beforeMutation={beforeMutation}
          onChanged={onChanged}
          onWorktreeCreated={onWorktreeCreated}
          onPreview={previewReference}
          onCompare={(reference) => {
            setWorkingReference(reference);
            setCommit(null);
            setTab("working");
          }}
          onBusyChange={(value) => {
            setBranchBusy(value);
            onBusyChange?.(value);
          }}
        />
        <div className="git-reference-content">
          <div className="git-navigation">
            <div className="inspector-tabs" role="tablist" aria-label={tx("Git 视图")}>
              {(
                [
                  ["changes", tx("变更")],
                  ["compare", tx("对比")],
                  ["history", tx("历史")],
                ] as const
              ).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
              {workingReference && (
                <button
                  role="tab"
                  aria-selected={tab === "working"}
                  onClick={() => setTab("working")}
                >
                  {tx("工作目录比较")}
                </button>
              )}
            </div>
            {tab === "history" && !commit && (
              <button
                className="icon-button"
                title={showGraph ? tx("隐藏历史提交图") : tx("显示历史提交图")}
                aria-label={showGraph ? tx("隐藏历史提交图") : tx("显示历史提交图")}
                aria-pressed={showGraph}
                onClick={() => setShowGraph((value) => !value)}
              >
                <ToolbarIcon name="git" />
              </button>
            )}
          </div>
          {(mutationError || error || (tab === "history" && gitReadError(history.error))) && (
            <p role="alert" className="inspector-message">
              {localizeMessage(mutationError || error || gitReadError(history.error))}
            </p>
          )}
          {mutating && (
            <p role="status" className="inspector-message">
              {tx("正在回滚文件…")}
            </p>
          )}
          {tab === "history" && (
            <h3 className="git-history-target" title={preview.name}>
              {preview.name}
            </h3>
          )}
          <div className="git-content">
            <div className="git-list-area">
              {tab === "changes" && snapshot && (
                <>
                  {snapshot.truncated && (
                    <p className="inspector-message">{tx("仅显示前 2,000 个文件。")}</p>
                  )}
                  {!snapshot.changes.length && (
                    <p className="inspector-message">{tx("没有未提交的变更。")}</p>
                  )}
                  {snapshot.changes.some(
                    (change) => change.index !== " " && change.index !== "?",
                  ) && (
                    <>
                      <h3>{tx("已暂存")}</h3>
                      {fileList(
                        snapshot.changes.filter(
                          (change) => change.index !== " " && change.index !== "?",
                        ),
                        "staged",
                      )}
                    </>
                  )}
                  {snapshot.changes.some((change) => change.working !== " ") && (
                    <>
                      <h3>{tx("工作目录")}</h3>
                      {fileList(
                        snapshot.changes.filter((change) => change.working !== " "),
                        "working",
                      )}
                    </>
                  )}
                </>
              )}
              {tab === "compare" && (
                <>
                  <label className="compare-picker">
                    {tx("对比分支")}
                    <select
                      aria-label={tx("对比分支")}
                      value={base}
                      onChange={(event) => setBase(event.target.value)}
                    >
                      <option value="">{tx("选择分支")}</option>
                      {snapshot?.references
                        .filter((reference) => reference !== snapshot.branch)
                        .map((reference) => (
                          <option key={reference}>{reference}</option>
                        ))}
                    </select>
                  </label>
                  {base && !loading && !files.length && !error && (
                    <p className="inspector-message">{tx("与所选分支没有差异。")}</p>
                  )}
                  {fileList(files, "compare")}
                </>
              )}
              {tab === "working" && workingReference && (
                <>
                  <h3 title={workingReference.name}>
                    {tx("与工作目录比较：{p0}", { p0: workingReference.name })}
                  </h3>
                  {!loading && !files.length && !error && (
                    <p className="inspector-message">{tx("没有差异。")}</p>
                  )}
                  {fileList(
                    files.filter((change) => change.index !== "?"),
                    "reference-working",
                  )}
                  {files.some((change) => change.index === "?") && (
                    <>
                      <h3>{tx("未跟踪文件")}</h3>
                      {fileList(
                        files.filter((change) => change.index === "?"),
                        "working",
                      )}
                    </>
                  )}
                </>
              )}
              {tab === "history" && (
                <>
                  {preview.oid === null && preview.full_name !== "HEAD" && (
                    <p className="inspector-message">{tx("获取后预览")}</p>
                  )}
                  {commit ? (
                    <>
                      <button className="history-back" onClick={() => setCommit(null)}>
                        {tx("‹ 返回历史 · {p0}", { p0: commit.id.slice(0, 8) })}
                      </button>
                      <section className="git-commit-details" aria-label={tx("提交详情")}>
                        <h3>{tx("提交信息")}</h3>
                        <dl className="git-commit-meta">
                          <dt>{tx("作者")}</dt>
                          <dd>{commit.author}</dd>
                          <dt>{tx("提交时间")}</dt>
                          <dd>{formatCommitTimestamp(commit.timestamp, getUiLanguage())}</dd>
                          <dt>{tx("提交哈希")}</dt>
                          <dd>
                            <code>{commit.id}</code>
                          </dd>
                        </dl>
                        <pre className="git-commit-message">{commit.message || commit.subject}</pre>
                      </section>
                      {!loading && !error && (
                        <h3>{tx("变动文件（{p0}）", { p0: files.length })}</h3>
                      )}
                    </>
                  ) : (
                    <>
                      {commits.map((item, index) => (
                        <button
                          key={item.id}
                          className="git-commit"
                          title={`${item.message || item.subject}\n\n${item.id}\n${item.author} · ${formatCommitTimestamp(item.timestamp, getUiLanguage())}`}
                          onClick={() => setCommit({ ...item, directory })}
                        >
                          {showGraph && (
                            <svg
                              className="commit-graph"
                              width={graphWidth}
                              height={48}
                              aria-hidden="true"
                            >
                              {graph[index].continuations.map((edge) => (
                                <path
                                  key={`lane-${edge.from}`}
                                  d={`M ${edge.from * 16 + 12} 0 L ${edge.from * 16 + 12} 24 L ${edge.to * 16 + 12} 48`}
                                  fill="none"
                                  stroke={graphColors[edge.color % graphColors.length]}
                                />
                              ))}
                              {graph[index].incoming && (
                                <path
                                  d={`M ${graph[index].lane * 16 + 12} 0 V 24`}
                                  stroke={graphColors[graph[index].color % graphColors.length]}
                                />
                              )}
                              {graph[index].parents.map((edge) => (
                                <path
                                  key={`parent-${edge.lane}`}
                                  d={`M ${graph[index].lane * 16 + 12} 24 L ${edge.lane * 16 + 12} 48`}
                                  stroke={graphColors[edge.color % graphColors.length]}
                                />
                              ))}
                              <circle
                                cx={graph[index].lane * 16 + 12}
                                cy={24}
                                r={item.parents.length > 1 ? 4 : 3}
                                fill={graphColors[graph[index].color % graphColors.length]}
                              />
                            </svg>
                          )}
                          <div className="commit-summary">
                            <span>{item.subject}</span>
                            <small>
                              {item.id.slice(0, 8)} · {item.author} ·{" "}
                              {formatCommitTimestamp(item.timestamp, getUiLanguage())}
                            </small>
                          </div>
                        </button>
                      ))}
                      {(preview.oid !== null || preview.full_name === "HEAD") &&
                        !commits.length &&
                        !error &&
                        !gitReadError(history.error) &&
                        !history.loading && (
                          <p className="inspector-message">{tx("还没有提交。")}</p>
                        )}
                      {history.more && commits.length > 0 && (
                        <button
                          disabled={history.loading}
                          onClick={() =>
                            void historyPager.current.load(
                              (skip) =>
                                invoke<Commit[]>("git_history", {
                                  directory,
                                  skip,
                                  reference: preview.full_name,
                                }),
                              setHistory,
                            )
                          }
                        >
                          {tx("加载更早的提交")}
                        </button>
                      )}
                    </>
                  )}
                  {commit && fileList(files, "commit")}
                  {commit && !loading && !files.length && !error && (
                    <p className="inspector-message">{tx("此提交没有变动文件。")}</p>
                  )}
                </>
              )}
              {(loading || (tab === "history" && history.loading)) && (
                <p className="inspector-message">{tx("正在读取…")}</p>
              )}
            </div>
            {expanded && diffTarget ? createPortal(diffView, diffTarget) : diffView}
          </div>
        </div>
      </div>
      {menu &&
        createPortal(
          <div
            ref={popup}
            className="context-menu git-file-menu"
            role="menu"
            aria-label={tx("Git 文件操作")}
            style={{ left: menu.x, top: menu.y }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape" || event.key === "Tab") {
                if (event.key === "Escape") event.preventDefault();
                closeMenu(event.key === "Escape");
              } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
                );
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                buttons[
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                        buttons.length
                ]?.focus();
              }
            }}
          >
            <button
              role="menuitem"
              disabled={disabled || mutating || !onOpenFile || menu.path === null}
              onClick={() => {
                const path = menu.path;
                closeMenu();
                if (path !== null) onOpenFile?.(path);
              }}
            >
              {tx("打开文件")}
            </button>
            <button
              role="menuitem"
              className="danger"
              disabled={disabled || mutating}
              onClick={() => {
                setConfirmation({ change: menu.change, head: menu.head });
                closeMenu();
              }}
            >
              {tx("回滚文件")}
            </button>
          </div>,
          document.body,
        )}
      {confirmation &&
        createPortal(
          <dialog
            ref={dialog}
            className="name-dialog git-rollback-dialog"
            aria-labelledby="git-rollback-title"
            onCancel={(event) => {
              event.preventDefault();
              closeConfirmation();
            }}
          >
            <h2 id="git-rollback-title">{tx("回滚文件")}</h2>
            <p className="git-rollback-path">
              {confirmation.change.original
                ? `${confirmation.change.original} → ${confirmation.change.path}`
                : confirmation.change.path}
            </p>
            <p>
              {confirmation.change.index === "?" ||
              confirmation.change.index === "A" ||
              confirmation.change.index === "C"
                ? tx("将删除此新增文件及其暂存记录，此操作无法撤销。")
                : tx("将此文件的暂存和工作目录改动恢复到 HEAD，此操作无法撤销。")}
            </p>
            <div className="git-rollback-actions">
              <button ref={cancel} onClick={closeConfirmation}>
                {tx("取消")}
              </button>
              <button className="danger" disabled={disabled || mutating} onClick={rollback}>
                {tx("确认回滚")}
              </button>
            </div>
          </dialog>,
          document.body,
        )}
    </aside>
  );
}
