import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { localizeMessage, tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import {
  mergeRemoteReferences,
  referenceTree,
  referenceView,
  rememberReferenceView,
  visibleReferenceNodes,
  type GitReference,
  type ReferenceCatalog,
  type ReferenceNode,
} from "../lib/git-references";

type FormKind = "create" | "rename" | "upstream" | "push" | "worktree" | "update";
type ActionFields = { name?: string; remote?: string; branch?: string; path?: string };
export function GitBranchTree({
  directory,
  disabled,
  refreshRevision,
  beforeMutation,
  onChanged,
  onPreview,
  onCompare,
  onBusyChange,
  onWorktreeCreated,
}: {
  directory: string;
  disabled: boolean;
  refreshRevision: number;
  beforeMutation: (action: () => Promise<void>) => void;
  onChanged?: () => void;
  onPreview: (reference: GitReference, navigate?: boolean) => void;
  onCompare: (reference: GitReference) => void;
  onBusyChange?: (busy: boolean) => void;
  onWorktreeCreated?: (root: string) => Promise<void>;
}) {
  useUiLanguage();
  const [view, setView] = useState(() => referenceView(directory));
  const [catalog, setCatalog] = useState<ReferenceCatalog | null>(null);
  const [advertised, setAdvertised] = useState<{ remote: string; branch: string }[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [readError, setReadError] = useState("");
  const [remoteError, setRemoteError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [readingRemote, setReadingRemote] = useState(false);
  const [result, setResult] = useState("");
  const [revision, setRevision] = useState(0);
  const [menu, setMenu] = useState<{
    node: ReferenceNode;
    current: string | null;
    x: number;
    y: number;
  } | null>(null);
  const [form, setForm] = useState<{
    kind: FormKind;
    target: GitReference;
    current: string | null;
  } | null>(null);
  const [fields, setFields] = useState({ name: "", remote: "", branch: "", path: "" });
  const [focused, setFocused] = useState(view.selected);
  const popup = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const alive = useRef(true);
  const changing = useRef(false);
  const generation = useRef(0);
  const remoteGeneration = useRef(0);
  const formGeneration = useRef(0);
  const callbacks = useRef({ onChanged, onPreview, onCompare, onBusyChange, onWorktreeCreated });
  callbacks.current = { onChanged, onPreview, onCompare, onBusyChange, onWorktreeCreated };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      remoteGeneration.current++;
    };
  }, []);
  useEffect(() => rememberReferenceView(directory, view), [directory, view]);
  async function readLocal() {
    const request = ++generation.current;
    try {
      const next = await invoke<ReferenceCatalog>("git_references", { directory });
      if (alive.current && request === generation.current) {
        setCatalog((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
        setReadError("");
      }
    } catch (reason) {
      if (alive.current && request === generation.current) setReadError(String(reason));
    }
  }
  async function readRemote() {
    const request = ++remoteGeneration.current;
    setReadingRemote(true);
    try {
      const next = await invoke<{
        branches: { remote: string; branch: string }[];
        errors: string[];
      }>("git_remote_branches", { directory });
      if (alive.current && request === remoteGeneration.current) {
        setAdvertised(next.branches);
        setRemoteError(next.errors.join("\n"));
      }
    } catch (reason) {
      if (alive.current && request === remoteGeneration.current) setRemoteError(String(reason));
    } finally {
      if (alive.current && request === remoteGeneration.current) setReadingRemote(false);
    }
  }
  useEffect(() => {
    let disposed = false,
      loading = false;
    async function load() {
      if (disposed || loading || changing.current || document.hidden) return;
      loading = true;
      try {
        await readLocal();
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", load);
      generation.current++;
    };
  }, [directory, revision, refreshRevision]);
  const repository = catalog?.repository;
  useEffect(() => {
    if (!repository) return;
    try {
      const value: unknown = JSON.parse(
        window.localStorage.getItem(`uterm.git.favorites:${repository}`) ?? "[]",
      );
      setFavorites(
        new Set(
          Array.isArray(value)
            ? value.filter((item): item is string => typeof item === "string")
            : [],
        ),
      );
    } catch (reason) {
      setActionError(String(reason));
    }
    void readRemote();
  }, [repository]);
  const references = useMemo(
    () => mergeRemoteReferences(catalog?.references ?? [], advertised),
    [catalog, advertised],
  );
  const nodes = useMemo(
    () => referenceTree(references, favorites, view.search),
    [references, favorites, view.search],
  );
  const collapsed = new Set(view.collapsed);
  const rows = visibleReferenceNodes(nodes, collapsed, !!view.search);
  const selected = references.find((item) => item.full_name === view.selected);
  const previousPreview = useRef<GitReference | null>(null);
  useEffect(() => {
    if (
      selected &&
      previousPreview.current?.full_name === selected.full_name &&
      previousPreview.current.oid !== selected.oid
    )
      callbacks.current.onPreview(selected, false);
    previousPreview.current = selected ?? null;
  }, [selected]);
  function preview(reference: GitReference) {
    setView((previous) => ({ ...previous, selected: reference.full_name }));
    callbacks.current.onPreview(reference);
  }
  function toggle(node: ReferenceNode) {
    setView((previous) => ({
      ...previous,
      collapsed: previous.collapsed.includes(node.id)
        ? previous.collapsed.filter((id) => id !== node.id)
        : [...previous.collapsed, node.id],
    }));
  }
  function closeMenu(restore = false) {
    setMenu(null);
    if (restore) trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!menu || !popup.current) return;
    const rect = popup.current.getBoundingClientRect();
    popup.current.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
    popup.current.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    popup.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node)) closeMenu();
    };
    const dismiss = () => closeMenu();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    tree.current?.addEventListener("scroll", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      tree.current?.removeEventListener("scroll", dismiss);
    };
  }, [menu]);
  useEffect(() => {
    if (!form) return;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLInputElement | HTMLButtonElement>("input, button")?.focus();
    return () => dialog.current?.close();
  }, [form]);
  function openForm(kind: FormKind, target: GitReference) {
    const request = ++formGeneration.current;
    closeMenu();
    setFields({
      name: kind === "rename" ? target.name : "",
      remote: catalog?.remotes[0] ?? "",
      branch: target.name,
      path: "",
    });
    setForm({ kind, target, current: menu?.current ?? catalog?.current ?? null });
    if (kind === "worktree") {
      void invoke<{ branch: string; path: string }>("worktree_suggestion", {
        directory,
        reference: target.full_name,
      })
        .then((next) => {
          if (alive.current && request === formGeneration.current)
            setFields((previous) => ({
              ...previous,
              name: previous.name || next.branch,
              path: previous.path || next.path,
            }));
        })
        .catch((reason) => {
          if (alive.current && request === formGeneration.current) setActionError(String(reason));
        });
    }
  }
  function execute(
    action: string,
    target: GitReference | undefined,
    extra: ActionFields = {},
    expectedCurrent = menu?.current ?? catalog?.current ?? null,
  ) {
    if (disabled || changing.current) return;
    closeMenu();
    formGeneration.current++;
    setForm(null);
    const operation = async () => {
      if (!alive.current || changing.current) return;
      changing.current = true;
      generation.current++;
      remoteGeneration.current++;
      setReadingRemote(false);
      setBusy(true);
      callbacks.current.onBusyChange?.(true);
      setActionError("");
      setResult("");
      try {
        if (action === "worktree") {
          await invoke("create_worktree", {
            directory,
            reference: target?.full_name,
            oid: target?.oid,
            branch: extra.name,
            path: extra.path,
          });
          await callbacks.current.onWorktreeCreated?.(catalog?.root ?? directory);
        } else {
          await invoke("git_reference_action", {
            directory,
            target: {
              action,
              reference: target?.full_name ?? "",
              oid: target?.oid ?? null,
              current: expectedCurrent,
              remote: target?.remote ?? null,
              branch: target?.branch ?? null,
              ...extra,
            },
          });
        }
        if (alive.current) {
          setResult(
            tx("操作已完成：{p0}", { p0: extra.name || target?.name || extra.remote || "Git" }),
          );
          if (action === "create" && extra.name) {
            setView((previous) => ({
              ...previous,
              selected: `refs/heads/${extra.name}`,
              search: "",
              collapsed: previous.collapsed.filter((id) => !`local/${extra.name}`.startsWith(id)),
            }));
            if (target)
              callbacks.current.onPreview({
                ...target,
                kind: "local",
                name: extra.name,
                full_name: `refs/heads/${extra.name}`,
                current: false,
              });
          }
          if (action === "rename" && extra.name && view.selected === target?.full_name) {
            setView((previous) => ({ ...previous, selected: `refs/heads/${extra.name}` }));
            callbacks.current.onPreview({
              ...target,
              name: extra.name,
              full_name: `refs/heads/${extra.name}`,
            });
          }
          if (
            action === "rename" &&
            extra.name &&
            target &&
            repository &&
            favorites.has(target.full_name)
          ) {
            const next = new Set(favorites);
            next.delete(target.full_name);
            next.add(`refs/heads/${extra.name}`);
            window.localStorage.setItem(
              `uterm.git.favorites:${repository}`,
              JSON.stringify([...next]),
            );
            setFavorites(next);
          }
        }
      } catch (reason) {
        if (alive.current) setActionError(String(reason));
      } finally {
        changing.current = false;
        callbacks.current.onBusyChange?.(false);
        callbacks.current.onChanged?.();
        if (alive.current) {
          setBusy(false);
          setRevision((value) => value + 1);
          void readRemote();
          trigger.current?.focus();
        }
      }
    };
    if (action === "switch" || action === "update") beforeMutation(operation);
    else void operation();
  }
  function favorite(target: GitReference) {
    if (!repository) return;
    const next = new Set(favorites);
    if (next.has(target.full_name)) next.delete(target.full_name);
    else next.add(target.full_name);
    try {
      window.localStorage.setItem(`uterm.git.favorites:${repository}`, JSON.stringify([...next]));
      setFavorites(next);
      closeMenu(true);
    } catch (reason) {
      setActionError(String(reason));
    }
  }
  function focusNode(id: string) {
    setFocused(id);
    Array.from(tree.current?.querySelectorAll<HTMLButtonElement>("[role=treeitem]") ?? [])
      .find((button) => button.dataset.node === id)
      ?.focus();
  }
  function nodeLabel(node: ReferenceNode) {
    return (
      node.reference?.name ??
      (node.id === "local"
        ? tx("本地分支")
        : node.id === "remote"
          ? tx("远程分支")
          : node.id === "tag"
            ? tx("标签")
            : node.label)
    );
  }
  const formTitle =
    form?.kind === "create"
      ? tx("新建分支")
      : form?.kind === "rename"
        ? tx("重命名分支")
        : form?.kind === "upstream"
          ? tx("设置上游")
          : form?.kind === "push"
            ? tx("推送分支")
            : form?.kind === "worktree"
              ? tx("新建 Worktree")
              : tx("切换后更新…");
  const actions: { label: string; disabled?: boolean; run: () => void }[] = [];
  if (menu) {
    const target = menu.node.reference;
    if (!target) {
      actions.push({
        label: collapsed.has(menu.node.id) ? tx("展开") : tx("折叠"),
        run: () => {
          toggle(menu.node);
          closeMenu(true);
        },
      });
      actions.push({
        label: tx("刷新分支"),
        run: () => {
          closeMenu(true);
          setRevision((value) => value + 1);
          void readRemote();
        },
      });
      if (menu.node.remote)
        actions.push({
          label: tx("获取远程分支"),
          run: () => execute("fetch", undefined, { remote: menu.node.remote }),
        });
    } else {
      if (target.kind === "local" || target.kind === "remote")
        actions.push({
          label: target.kind === "local" ? tx("切换到此分支") : tx("切换并跟踪"),
          disabled: target.current || !!target.worktree,
          run: () => execute("switch", target),
        });
      if (target.kind === "tag" || target.kind === "head")
        actions.push({
          label: tx("预览历史"),
          run: () => {
            preview(target);
            closeMenu(true);
          },
        });
      actions.push({
        label: tx("新建分支"),
        disabled: !target.oid,
        run: () => openForm("create", target),
      });
      if (target.kind !== "head")
        actions.push({
          label: tx("与工作目录比较"),
          disabled: !target.oid,
          run: () => {
            preview(target);
            callbacks.current.onCompare(target);
            closeMenu(true);
          },
        });
      actions.push({
        label: tx("新建 Worktree"),
        disabled: !target.oid,
        run: () => openForm("worktree", target),
      });
      if (target.kind === "local") {
        actions.push({
          label: target.current ? tx("更新分支") : tx("切换后更新…"),
          disabled: !target.upstream || !!target.worktree,
          run: () => (target.current ? execute("update", target) : openForm("update", target)),
        });
        actions.push({
          label: tx("推送分支"),
          run: () => (target.upstream ? execute("push", target) : openForm("push", target)),
        });
        actions.push({
          label: target.upstream ? tx("更换上游") : tx("设置上游"),
          run: () => openForm("upstream", target),
        });
        if (target.upstream)
          actions.push({ label: tx("取消上游"), run: () => execute("upstream", target) });
        actions.push({
          label: tx("重命名分支"),
          disabled: !!target.worktree,
          run: () => openForm("rename", target),
        });
      }
      if (target.kind === "remote")
        actions.push({ label: tx("获取此分支"), run: () => execute("fetch", target) });
      if (target.kind === "local" || target.kind === "remote")
        actions.push({
          label: favorites.has(target.full_name) ? tx("取消收藏") : tx("收藏分支"),
          run: () => favorite(target),
        });
      if (target.kind !== "head")
        actions.push({
          label: tx("复制名称"),
          run: () => {
            closeMenu(true);
            void navigator.clipboard
              .writeText(target.name)
              .catch((reason) => setActionError(String(reason)));
          },
        });
    }
  }
  return (
    <section
      className="git-branch-tree"
      data-folded={view.folded || undefined}
      aria-label={tx("分支树")}
    >
      <header className="git-tree-tools">
        <button
          aria-label={view.folded ? tx("展开分支树") : tx("折叠分支树")}
          aria-expanded={!view.folded}
          onClick={() => setView((previous) => ({ ...previous, folded: !previous.folded }))}
        >
          {view.folded ? "▸" : "▾"} {tx("分支")}
        </button>
        <button
          disabled={disabled || busy || readingRemote}
          title={tx("刷新分支")}
          aria-label={tx("刷新分支")}
          onClick={() => {
            setRevision((value) => value + 1);
            void readRemote();
          }}
        >
          ↻
        </button>
      </header>
      {!view.folded && (
        <>
          <input
            type="search"
            aria-label={tx("搜索分支或标签")}
            placeholder={tx("搜索分支或标签")}
            value={view.search}
            onChange={(event) =>
              setView((previous) => ({ ...previous, search: event.target.value }))
            }
          />
          <div ref={tree} className="git-tree-rows" role="tree" aria-label={tx("分支和标签")}>
            {rows.map((node, index) => {
              const item = node.reference;
              const label =
                node.id === "local"
                  ? tx("本地分支")
                  : node.id === "remote"
                    ? tx("远程分支")
                    : node.id === "tag"
                      ? tx("标签")
                      : node.label;
              const title = [
                item?.name ?? label,
                item?.current ? tx("当前分支") : "",
                item?.upstream ?? "",
                item?.worktree ? tx("Worktree 占用：{p0}", { p0: item.worktree }) : "",
                item && !item.oid ? tx("获取后预览") : "",
              ]
                .filter(Boolean)
                .join("\n");
              return (
                <button
                  key={node.id}
                  data-node={node.id}
                  role="treeitem"
                  aria-level={node.level}
                  aria-expanded={!item ? !!view.search || !collapsed.has(node.id) : undefined}
                  aria-selected={item ? view.selected === node.id : undefined}
                  aria-current={item?.current || undefined}
                  aria-haspopup="menu"
                  tabIndex={
                    focused === node.id || (!rows.some((row) => row.id === focused) && index === 0)
                      ? 0
                      : -1
                  }
                  className="git-tree-row"
                  style={{ paddingLeft: 8 + (node.level - 1) * 14 }}
                  title={title}
                  onFocus={() => setFocused(node.id)}
                  onClick={() => (item ? preview(item) : toggle(node))}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    trigger.current = event.currentTarget;
                    setFocused(node.id);
                    setMenu({
                      node,
                      current: catalog?.current ?? null,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                      event.preventDefault();
                      event.stopPropagation();
                      trigger.current = event.currentTarget;
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenu({
                        node,
                        current: catalog?.current ?? null,
                        x: rect.left,
                        y: rect.bottom,
                      });
                      return;
                    }
                    if (
                      !["ArrowUp", "ArrowDown", "ArrowRight", "ArrowLeft", "Home", "End"].includes(
                        event.key,
                      )
                    )
                      return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.key === "ArrowRight") {
                      if (!item && collapsed.has(node.id)) toggle(node);
                      else if (!item && rows[index + 1]) focusNode(rows[index + 1].id);
                    } else if (event.key === "ArrowLeft") {
                      if (!item && !collapsed.has(node.id)) toggle(node);
                      else if (node.parent) focusNode(node.parent);
                    } else
                      focusNode(
                        rows[
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? rows.length - 1
                              : Math.max(
                                  0,
                                  Math.min(
                                    rows.length - 1,
                                    index + (event.key === "ArrowDown" ? 1 : -1),
                                  ),
                                )
                        ].id,
                      );
                  }}
                >
                  <span aria-hidden="true">
                    {item
                      ? item.current
                        ? "●"
                        : favorites.has(node.id)
                          ? "★"
                          : item.kind === "tag"
                            ? "◇"
                            : "⑂"
                      : view.search || !collapsed.has(node.id)
                        ? "▾"
                        : "▸"}
                  </span>
                  <span className="git-tree-name">{label}</span>
                  {item?.worktree && <span aria-label={tx("其他 Worktree 占用")}>▣</span>}
                  {!!item?.ahead && <small>↑{item.ahead}</small>}
                  {!!item?.behind && <small>↓{item.behind}</small>}
                  {item?.current && favorites.has(node.id) && <span aria-hidden="true">★</span>}
                  {item?.kind === "remote" && !item.oid && <small>{tx("获取后预览")}</small>}
                </button>
              );
            })}
          </div>
          {readingRemote && (
            <p className="inspector-message" role="status">
              {tx("正在读取远程分支…")}
            </p>
          )}
        </>
      )}
      {(readError || remoteError || actionError) && (
        <p role="alert" className="inspector-message git-tree-error">
          {localizeMessage(actionError || readError || remoteError)}
        </p>
      )}
      {(busy || result) && (
        <p role="status" className="inspector-message">
          {busy ? tx("正在执行 Git 操作…") : result}
        </p>
      )}
      {menu &&
        createPortal(
          <div
            ref={popup}
            className="context-menu git-reference-menu"
            role="menu"
            aria-label={tx("引用操作")}
            style={{ left: menu.x, top: menu.y }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape" || event.key === "Tab") {
                if (event.key === "Escape") event.preventDefault();
                closeMenu(event.key === "Escape");
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const buttons = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                ];
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
            <div className="branch-menu-heading" title={nodeLabel(menu.node)}>
              {nodeLabel(menu.node)}
            </div>
            {actions.map((action) => (
              <button
                role="menuitem"
                key={action.label}
                disabled={disabled || busy || action.disabled}
                onClick={action.run}
              >
                {action.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
      {form &&
        createPortal(
          <dialog
            ref={dialog}
            className="name-dialog git-reference-dialog"
            aria-labelledby="git-reference-title"
            onCancel={(event) => {
              event.preventDefault();
              formGeneration.current++;
              setForm(null);
              trigger.current?.focus();
            }}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                execute(
                  form.kind,
                  form.target,
                  form.kind === "upstream" || form.kind === "push"
                    ? { remote: fields.remote, branch: fields.branch }
                    : form.kind === "worktree"
                      ? { name: fields.name, path: fields.path }
                      : { name: fields.name },
                  form.current,
                );
              }}
            >
              <h2 id="git-reference-title">{formTitle}</h2>
              <p className="git-reference-target">{form.target.name}</p>
              {form.kind === "update" ? (
                <p>{tx("将切换到此分支并仅快进更新。若更新失败，将保留已完成的切换。")}</p>
              ) : (
                <>
                  {(form.kind === "create" ||
                    form.kind === "rename" ||
                    form.kind === "worktree") && (
                    <label>
                      {tx("分支名称")}
                      <input
                        required
                        aria-label={tx("分支名称")}
                        value={fields.name}
                        onChange={(event) => setFields({ ...fields, name: event.target.value })}
                      />
                    </label>
                  )}
                  {(form.kind === "upstream" || form.kind === "push") && (
                    <>
                      <label>
                        {tx("远程仓库")}
                        <select
                          required
                          aria-label={tx("远程仓库")}
                          value={fields.remote}
                          onChange={(event) => setFields({ ...fields, remote: event.target.value })}
                        >
                          <option value="">{tx("选择远程仓库")}</option>
                          {catalog?.remotes.map((remote) => (
                            <option key={remote}>{remote}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {tx("远程分支名称")}
                        <input
                          required
                          aria-label={tx("远程分支名称")}
                          list="git-upstream-branches"
                          value={fields.branch}
                          onChange={(event) => setFields({ ...fields, branch: event.target.value })}
                        />
                      </label>
                      <datalist id="git-upstream-branches">
                        {references
                          .filter((item) => item.remote === fields.remote)
                          .map((item) => (
                            <option key={item.full_name} value={item.branch ?? ""} />
                          ))}
                      </datalist>
                    </>
                  )}
                  {form.kind === "worktree" && (
                    <label>
                      {tx("Worktree 目录")}
                      <input
                        required
                        aria-label={tx("Worktree 目录")}
                        value={fields.path}
                        onChange={(event) => setFields({ ...fields, path: event.target.value })}
                      />
                    </label>
                  )}
                </>
              )}
              <div className="git-rollback-actions">
                <button
                  type="button"
                  onClick={() => {
                    formGeneration.current++;
                    setForm(null);
                    trigger.current?.focus();
                  }}
                >
                  {tx("取消")}
                </button>
                <button type="submit" disabled={disabled || busy}>
                  {formTitle}
                </button>
              </div>
            </form>
          </dialog>,
          document.body,
        )}
    </section>
  );
}
