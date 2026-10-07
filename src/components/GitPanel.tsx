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
import { sameGitSnapshot } from "../lib/git-snapshot";
import type { GitChange, GitSnapshot } from "../lib/git-snapshot";
type Change = GitChange;
type Snapshot = GitSnapshot;
interface Commit {
  id: string;
  parents: string[];
  subject: string;
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
  onExpandedChange,
}: {
  resizeHandle: ReactNode;
  headerActions: ReactNode;
  directory: string;
  expanded: boolean;
  diffTarget?: HTMLElement | null;
  onDiffPathChange?: (path: string | null) => void;
  onExpandedChange: (expanded: boolean) => void;
}) {
  useUiLanguage();

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<"changes" | "compare" | "history">("changes");
  const [base, setBase] = useState("");
  const historyPager = useRef(new HistoryPager<Commit>());
  const [history, setHistory] = useState(historyPager.current.state);
  const commits = history.items;
  const [showGraph, setShowGraph] = useState(false);
  const graph = useMemo(() => (showGraph ? commitGraph(commits) : []), [commits, showGraph]);
  const graphWidth = Math.max(1, ...graph.map((row) => row.width)) * 16 + 8;
  const graphColors = ["#78b85b", "#d6a04a", "#728ee5", "#b778cf", "#54b7af", "#d87878"];
  const [commit, setCommit] = useState<string | null>(null);
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
  const [loading, setLoading] = useState(false);
  const [diffRevision, setDiffRevision] = useState(0);
  const [revision, setRevision] = useState(0);
  const request = useRef(0);
  const selectedChange = useRef(false);
  const refresh = () => setRevision((value) => value + 1);
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
      if (busy || document.hidden) return;
      busy = true;
      try {
        const next = await invoke<Snapshot>("git_snapshot", { directory });
        if (!disposed) {
          setSnapshot((previous) => (sameGitSnapshot(previous, next) ? previous : next));
          setError("");
          if (selectedChange.current) setDiffRevision((value) => value + 1);
        }
      } catch (reason) {
        if (!disposed) setError(String(reason));
      } finally {
        busy = false;
      }
    }
    void load();
    const timer = tab === "changes" ? window.setInterval(() => void load(), 4000) : undefined;
    const visible = () => {
      if (!document.hidden) {
        void load();
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
  }, [directory, revision, tab]);
  useEffect(() => {
    setSelection(null);
    setDiff(null);
    setError("");
  }, [tab, base, commit]);
  useEffect(() => {
    if (tab !== "history") return;
    const pager = historyPager.current;
    void pager.load(
      (skip) => invoke<Commit[]>("git_history", { directory, skip }),
      setHistory,
      true,
    );
    return () => pager.invalidate();
  }, [directory, tab, revision]);
  useEffect(() => {
    if (tab === "changes" || (tab === "compare" ? !base : !commit)) {
      setFiles([]);
      setLoading(false);
      return;
    }
    let disposed = false;
    setFiles([]);
    setLoading(true);
    invoke<Change[]>("git_files", {
      directory,
      reference: tab === "compare" ? base : commit,
      compare: tab === "compare",
    })
      .then((result) => {
        if (!disposed) {
          setFiles(result);
          setError("");
        }
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [directory, tab, base, commit, snapshot, revision]);
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
      reference: tab === "compare" ? base : tab === "history" ? commit : null,
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
        setError(String(reason));
      });
    return () => {
      request.current++;
    };
  }, [directory, selection, base, commit, tab, snapshot, revision, diffRevision]);
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
          mode: tab === "compare" ? "compare" : "commit",
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
            onClick={() => {
              setDiff(null);
              setSelection({ path: change.path, mode });
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
                  .catch((reason) => setError(String(reason)));
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
      {(error || (tab === "history" && history.error)) && (
        <p role="alert" className="inspector-message">
          {localizeMessage(error || history.error)}
        </p>
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
              {snapshot.changes.some((change) => change.index !== " " && change.index !== "?") && (
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
          {tab === "history" && (
            <>
              {commit ? (
                <button className="history-back" onClick={() => setCommit(null)}>
                  {tx("‹ 返回历史 · {p0}", { p0: commit.slice(0, 8) })}
                </button>
              ) : (
                <>
                  {commits.map((item, index) => (
                    <button
                      key={item.id}
                      className="git-commit"
                      title={item.id}
                      onClick={() => setCommit(item.id)}
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
                  {!commits.length && !error && !history.error && !history.loading && (
                    <p className="inspector-message">{tx("还没有提交。")}</p>
                  )}
                  {history.more && commits.length > 0 && (
                    <button
                      disabled={history.loading}
                      onClick={() =>
                        void historyPager.current.load(
                          (skip) => invoke<Commit[]>("git_history", { directory, skip }),
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
            </>
          )}
          {(loading || (tab === "history" && history.loading)) && (
            <p className="inspector-message">{tx("正在读取…")}</p>
          )}
        </div>
        {expanded && diffTarget ? createPortal(diffView, diffTarget) : diffView}
      </div>
    </aside>
  );
}
