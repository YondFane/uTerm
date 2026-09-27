import { localizeMessage } from "../lib/i18n";
import { githubStatus } from "../lib/github-i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { tx } from "../lib/i18n";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
const markdown = new MarkdownIt({ html: false, linkify: false });
markdown.renderer.rules.image = (tokens, index) =>
  tx("[图片：{p0}]", { p0: markdown.utils.escapeHtml(tokens[index].content) });
interface Item {
  number: number;
  title: string;
  url: string;
  state: string;
  author?: { login: string };
  labels?: { name: string }[];
  body?: string;
  comments?: { id: string; author?: { login: string }; body: string }[];
  headRefName?: string;
  baseRefName?: string;
  reviewDecision?: string;
  mergeable?: string;
  files?: { path: string; additions: number; deletions: number }[];
  statusCheckRollup?: {
    name?: string;
    context?: string;
    conclusion?: string;
    state?: string;
    status?: string;
  }[];
}
export function GitHubPanel({
  resizeHandle,
  headerActions,
  directory,
  associate,
  canAssociate,
  insert,
  canInsert,
  createSession,
}: {
  resizeHandle: ReactNode;
  headerActions: ReactNode;
  directory: string;
  associate: (item: Item) => void;
  canAssociate: boolean;
  insert: (url: string) => Promise<void>;
  canInsert: boolean;
  createSession: (item: Item) => void;
}) {
  const uiLanguage = useUiLanguage();

  const [repositories, setRepositories] = useState<string[]>([]);
  const [repository, setRepository] = useState("");
  const [kind, setKind] = useState<"issue" | "pr">("issue");
  const [state, setState] = useState("open");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<Item | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, refresh] = useState(0);
  const [form, setForm] = useState<{
    title: string;
    body: string;
    base: string;
    head: string;
    draft: boolean;
  } | null>(null);
  const [posting, setPosting] = useState(false);
  const [formError, setFormError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let disposed = false;
    void invoke<string[]>("github_repositories", { directory })
      .then((value) => {
        if (!disposed) {
          setRepositories(value);
          setRepository((current) => (value.includes(current) ? current : (value[0] ?? "")));
        }
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [directory, revision]);
  useEffect(() => {
    setSelected(null);
    setDetail(null);
    setDiff(null);
    setShowDiff(false);
    setItems([]);
    setNotice("");
    setLimit(50);
  }, [repository, kind, state, query]);
  useEffect(() => {
    if (!repository) return;
    let disposed = false;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void invoke<Item[]>("github_read", { directory, repository, kind, state, query, limit })
        .then((value) => {
          if (!disposed) setItems(value);
        })
        .catch((reason) => {
          if (!disposed) setError(String(reason));
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    }, 300);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [directory, repository, kind, state, query, limit, revision]);
  useEffect(() => {
    if (!selected) return;
    let disposed = false;
    setDetail(null);
    setDiff(null);
    setShowDiff(false);
    setLoading(true);
    setError("");
    void invoke<Item>("github_read", { directory, repository, kind, number: selected })
      .then((value) => {
        if (!disposed) setDetail(value);
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
  }, [directory, repository, selected, kind, revision]);
  useEffect(() => {
    if (!showDiff || !selected || kind !== "pr") return;
    let disposed = false;
    void invoke<{ text: string }>("github_read", {
      directory,
      repository,
      kind,
      number: selected,
      diff: true,
    })
      .then((value) => {
        if (!disposed) setDiff(value.text);
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [showDiff, selected, directory, repository, kind, revision]);
  useEffect(() => {
    if (form) dialog.current?.showModal();
    else dialog.current?.close();
  }, [!!form]);
  const html = useMemo(
    () =>
      DOMPurify.sanitize(markdown.render(detail?.body ?? ""), {
        FORBID_TAGS: ["img", "iframe", "form", "style"],
        FORBID_ATTR: ["style"],
      }),
    [detail?.body, uiLanguage],
  );
  async function prepare() {
    setFormError("");
    setLoading(true);
    try {
      const value = await invoke<{ base: string; head: string; title: string }>(
        "github_prepare_pr",
        { directory, repository },
      );
      setForm({
        ...value,
        body: tx("## 摘要\n\n\n## 验证\n\n\nRelease Notes:\n\n"),
        draft: true,
      });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }
  function open(url: string) {
    void invoke("open_external", { url }).catch((reason) => setError(String(reason)));
  }
  return (
    <aside className="git-panel github-panel" aria-label={tx("GitHub 面板")}>
      {resizeHandle}
      <header className="inspector-header">{headerActions}</header>
      {repositories.length > 0 && (
        <label className="compare-picker">
          {tx("仓库")}
          <select
            aria-label={tx("GitHub 仓库")}
            disabled={loading}
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
          >
            {repositories.map((repo) => (
              <option key={repo}>{repo}</option>
            ))}
          </select>
        </label>
      )}
      <div className="inspector-tabs">
        <button aria-pressed={kind === "issue"} onClick={() => setKind("issue")}>
          {tx("议题")}
        </button>
        <button aria-pressed={kind === "pr"} onClick={() => setKind("pr")}>
          {tx("合并请求")}
        </button>
        {kind === "pr" && (
          <button disabled={!repository || loading} onClick={() => void prepare()}>
            {tx("新建 PR")}
          </button>
        )}
      </div>
      {error && (
        <p className="inspector-message" role="alert">
          {localizeMessage(error)}
        </p>
      )}
      {notice && (
        <p className="inspector-message" role="status">
          {localizeMessage(notice)}
        </p>
      )}
      {!selected && (
        <>
          <div className="github-filters">
            <select
              aria-label={tx("条目状态")}
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              <option value="open">{tx("开放")}</option>
              <option value="closed">{tx("已关闭条目")}</option>
              <option value="all">{tx("全部")}</option>
            </select>
            <input
              aria-label={tx("搜索 GitHub")}
              placeholder={tx("搜索，或输入 assignee:@me、label:bug")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="github-items">
            {items.map((item) => (
              <button
                key={item.number}
                className="git-commit"
                onClick={() => setSelected(item.number)}
              >
                <span>
                  #{item.number} {item.title}
                </span>
                <small>
                  {githubStatus(item.state)} · {item.author?.login}
                  {item.labels?.map((label) => ` · ${label.name}`).join("")}
                </small>
              </button>
            ))}
            {!loading && !items.length && !error && (
              <p className="inspector-message">{tx("没有匹配的条目。")}</p>
            )}
            {items.length >= limit && limit < 500 && (
              <button disabled={loading} onClick={() => setLimit((value) => value + 50)}>
                {tx("加载更多")}
              </button>
            )}
            {limit === 500 && items.length >= 500 && <p>{tx("已显示 500 条，请缩小搜索范围。")}</p>}
          </div>
        </>
      )}
      {selected && (
        <div className="github-detail">
          <button
            onClick={() => {
              setSelected(null);
              setDetail(null);
              setDiff(null);
            }}
          >
            {tx("‹ 返回列表")}
          </button>
          {detail && (
            <>
              <h3>
                #{detail.number} {detail.title}
              </h3>
              <p>
                {githubStatus(detail.state)} · {detail.author?.login}
              </p>
              <div className="agent-buttons">
                <button onClick={() => open(detail.url)}>{tx("在 GitHub 打开")}</button>
                <button
                  disabled={!canAssociate}
                  onClick={() => {
                    associate(detail);
                    setNotice(tx("已关联当前会话。"));
                  }}
                >
                  {tx("关联当前会话")}
                </button>
                <button
                  disabled={!canInsert}
                  onClick={() =>
                    void insert(detail.url)
                      .then(() => setNotice(tx("链接已插入 Agent 输入，尚未发送。")))
                      .catch((reason) => setError(String(reason)))
                  }
                >
                  {tx("插入 Agent 输入")}
                </button>
                <button onClick={() => createSession(detail)}>{tx("新建关联会话")}</button>
              </div>
              {kind === "pr" && (
                <>
                  <p>
                    {detail.headRefName} → {detail.baseRefName} · {githubStatus(detail.mergeable)} ·{" "}
                    {githubStatus(detail.reviewDecision)}
                  </p>
                  {detail.statusCheckRollup?.map((check, index) => (
                    <p key={index}>
                      {check.name ?? check.context}：
                      {githubStatus(check.conclusion ?? check.state ?? check.status)}
                    </p>
                  ))}
                  <div className="agent-buttons">
                    <button
                      onClick={() => {
                        setShowDiff(false);
                        setDiff(null);
                      }}
                    >
                      {tx("讨论")}
                    </button>
                    <button disabled={loading} onClick={() => setShowDiff(true)}>
                      {tx("查看 Diff")}
                    </button>
                  </div>
                  <details>
                    <summary>{tx("更改文件（{p0}）", { p0: detail.files?.length ?? 0 })}</summary>
                    {detail.files?.map((file) => (
                      <p key={file.path}>
                        {file.path} +{file.additions} −{file.deletions}
                      </p>
                    ))}
                  </details>
                </>
              )}
              {diff !== null ? (
                <pre className="github-diff">{diff}</pre>
              ) : (
                <>
                  <article
                    className="markdown-preview"
                    onClick={(event) => {
                      const link = (event.target as HTMLElement).closest("a");
                      if (link) {
                        event.preventDefault();
                        const url = link.getAttribute("href");
                        if (url && /^https?:\/\//.test(url)) open(url);
                      }
                    }}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                  {detail.comments?.map((comment, index) => (
                    <section className="github-comment" key={comment.id ?? index}>
                      <strong>{comment.author?.login}</strong>
                      <pre>{comment.body}</pre>
                    </section>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
      {loading && (
        <p className="inspector-message" role="status">
          {tx("正在读取…")}
        </p>
      )}
      <dialog
        ref={dialog}
        className="name-dialog pr-dialog"
        aria-label={tx("新建 Pull Request")}
        onCancel={(event) => {
          if (posting) event.preventDefault();
          else setForm(null);
        }}
      >
        {form && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setPosting(true);
              setFormError("");
              void invoke<{ html_url: string; number: number }>("github_create_pr", {
                directory,
                repository,
                ...form,
              })
                .then((value) => {
                  setForm(null);
                  setSelected(value.number);
                  refresh((v) => v + 1);
                  setNotice(tx("已创建 PR #{p0}", { p0: value.number }));
                })
                .catch((reason) =>
                  setFormError(
                    tx("{p0}；请先刷新列表确认是否已创建，再决定是否重试。", {
                      p0: String(reason),
                    }),
                  ),
                )
                .finally(() => setPosting(false));
            }}
          >
            <h2>{tx("新建 Pull Request")}</h2>
            <p>{tx("{p0} · 分支需事先推送到 GitHub。", { p0: repository })}</p>
            {formError && <p role="alert">{localizeMessage(formError)}</p>}
            {(["title", "base", "head"] as const).map((key) => (
              <label key={key}>
                {{ title: tx("标题"), base: tx("目标分支"), head: tx("来源分支") }[key]}
                <input
                  required
                  disabled={posting}
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              </label>
            ))}
            <label>
              {tx("说明")}
              <textarea
                disabled={posting}
                rows={9}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
              />
            </label>
            <label>
              <input
                type="checkbox"
                disabled={posting}
                checked={form.draft}
                onChange={(e) => setForm({ ...form, draft: e.target.checked })}
              />
              {tx("创建草稿")}
            </label>
            <div>
              <button type="button" disabled={posting} onClick={() => setForm(null)}>
                {tx("取消")}
              </button>
              <button disabled={posting}>{posting ? tx("正在创建…") : tx("在 GitHub 创建")}</button>
            </div>
          </form>
        )}
      </dialog>
    </aside>
  );
}
