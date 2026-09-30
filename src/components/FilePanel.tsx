import { localizeMessage } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { tx } from "../lib/i18n";
import type { ReactNode } from "react";
import { ToolbarIcon } from "./SidebarIcon";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { clipboardPath } from "../lib/file-document";
import { setFileClipboard, useFileClipboard } from "../lib/file-clipboard";
interface Entry {
  path: string;
  name: string;
  directory: boolean;
  symlink: boolean;
}
interface Listing {
  entries: Entry[];
  partial: boolean;
  skipped: number;
}
interface Matches {
  matches: { path: string; line: number; text: string }[];
  partial: boolean;
  skipped: number;
}
export type FileMode = "tree" | "quick" | "search";
function Folder({
  directory,
  path,
  depth,
  hidden,
  open,
  manage,
  select,
  edit,
  revision,
}: {
  directory: string;
  path: string;
  depth: number;
  hidden: boolean;
  open: (path: string) => void;
  manage: (entry: Entry, x: number, y: number) => void;
  select: (entry: Entry) => void;
  edit: { path: string; rename: boolean; node: ReactNode } | null;
  revision: number;
}) {
  useUiLanguage();

  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await invoke<Listing>("files_list", { directory, path, hidden });
        if (!disposed) {
          setListing(result);
          setError("");
        }
      } catch (reason) {
        if (!disposed) setError(String(reason));
      } finally {
        // Schedule after completion so slow directory reads cannot overlap.
        // 读取完成后再安排下一次刷新，避免慢目录读取请求重叠。
        if (!disposed) timer = setTimeout(refresh, 5000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [directory, path, hidden, revision]);
  useEffect(() => {
    if (!edit || edit.rename) return;
    setExpanded(
      (previous) =>
        new Set([
          ...previous,
          ...edit.path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/")),
        ]),
    );
  }, [edit?.path, edit?.rename]);
  return (
    <ul className="file-tree" aria-label={path || tx("项目文件")}>
      {error && <li role="alert">{localizeMessage(error)}</li>}
      {!listing && !error && <li className="muted">{tx("正在读取…")}</li>}
      {edit && !edit.rename && edit.path === path && (
        <li style={{ paddingLeft: 12 + depth * 15 }}>{edit.node}</li>
      )}
      {listing?.entries.map((entry) => (
        <li key={entry.path}>
          {edit?.rename && edit.path === entry.path ? (
            <div style={{ paddingLeft: 12 + depth * 15 }}>{edit.node}</div>
          ) : (
            <button
              className="file-row"
              style={{ paddingLeft: 12 + depth * 15 }}
              title={entry.path}
              onFocus={() => select(entry)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                select(entry);
                manage(entry, event.clientX, event.clientY);
              }}
              aria-expanded={entry.directory ? expanded.has(entry.path) : undefined}
              onClick={() => {
                if (entry.directory)
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(entry.path)) next.delete(entry.path);
                    else next.add(entry.path);
                    return next;
                  });
                else open(entry.path);
              }}
            >
              <span className="file-chevron">
                {entry.directory ? (expanded.has(entry.path) ? "⌄" : "›") : ""}
              </span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                {entry.directory ? (
                  <path d="M3 7V5h6l2 2h10v13H3z" />
                ) : (
                  <path d="M6 3h8l4 4v14H6zM14 3v5h4" />
                )}
              </svg>
              <span>
                {entry.name}
                {entry.symlink ? " ↗" : ""}
              </span>
            </button>
          )}
          {entry.directory &&
            expanded.has(entry.path) &&
            (depth < 30 ? (
              <Folder
                directory={directory}
                path={entry.path}
                depth={depth + 1}
                hidden={hidden}
                open={open}
                manage={manage}
                select={select}
                edit={edit}
                revision={revision}
              />
            ) : (
              <p className="inspector-message">{tx("目录层级过深。")}</p>
            ))}
        </li>
      ))}
      {listing && !listing.entries.length && (
        <li className="inspector-message">{tx("此目录没有可显示的文件。")}</li>
      )}
      {listing?.partial && <li className="inspector-message">{tx("仅显示前 2,000 项。")}</li>}
      {!!listing?.skipped && (
        <li className="inspector-message">{tx("{p0} 项无法读取。", { p0: listing.skipped })}</li>
      )}
    </ul>
  );
}
export function FilePanel({
  resizeHandle,
  headerActions,
  directory,
  mode,
  request,
  setMode,
  open,
  beforeMutation,
}: {
  resizeHandle: ReactNode;
  headerActions: ReactNode;
  directory: string;
  mode: FileMode;
  request: number;
  setMode: (mode: FileMode) => void;
  open: (path: string, line?: number) => void;
  beforeMutation: (action: () => void) => void;
}) {
  useUiLanguage();

  const hidden = true;
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<Entry | null>(null);
  const [action, setAction] = useState("file");
  const [name, setName] = useState("");
  const [mutating, setMutating] = useState(false);
  const [menu, setMenu] = useState<{ entry: Entry; x: number; y: number } | null>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const fileClipboard = useFileClipboard();
  const [focusedEntry, setFocusedEntry] = useState<Entry | null>(null);
  const copying = useRef(false);
  const currentDirectory = useRef(directory);
  currentDirectory.current = directory;
  useEffect(() => {
    // A draft belongs to its selected root and must not follow a project switch.
    // 输入草稿属于所选根目录，不能随项目切换应用到另一个目录。
    setTarget(null);
    setMenu(null);
    setName("");
    setFocusedEntry(null);
    setError("");
  }, [directory]);
  const rootEntry: Entry = { path: "", name: tx("项目根目录"), directory: true, symlink: false };
  const copyFile = (entry: Entry) => {
    if (!entry.path || entry.symlink || mutating) return;
    setFileClipboard({ directory, path: entry.path });
    setMenu(null);
    results.current?.focus();
  };
  const pasteFile = async (entry: Entry) => {
    if (!fileClipboard || entry.symlink || mutating || copying.current) return;
    copying.current = true;
    setMutating(true);
    setMenu(null);
    setError("");
    const destination = entry.directory ? entry.path : entry.path.split("/").slice(0, -1).join("/");
    try {
      await invoke("file_copy", {
        directory,
        sourceDirectory: fileClipboard.directory,
        path: fileClipboard.path,
        destination,
      });
      if (currentDirectory.current === directory) setRevision((value) => value + 1);
    } catch (reason) {
      if (currentDirectory.current === directory) {
        setError(
          tx("粘贴失败，请检查目标目录（可能有未完成的副本）：{p0}", {
            p0: localizeMessage(String(reason)),
          }),
          true,
        );
        setRevision((value) => value + 1);
      }
    } finally {
      copying.current = false;
      setMutating(false);
    }
  };
  const manage = (entry: Entry, operation: string) => {
    setMenu(null);
    if (mutating) return;
    if ((operation === "file" || operation === "directory") && !entry.directory) {
      const parent = entry.path.split("/").slice(0, -1).join("/");
      entry = { path: parent, name: parent || tx("项目根目录"), directory: true, symlink: false };
    }
    setMode("tree");
    setTarget(entry);
    setAction(operation);
    setName(operation === "rename" ? entry.name : "");
    setError("");
  };
  useEffect(() => {
    if (!menu) return;
    menuElement.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menuElement.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
      }
    };
    const scroll = () => setMenu(null);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", scroll);
    results.current?.addEventListener("scroll", scroll);
    const area = results.current;
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", scroll);
      area?.removeEventListener("scroll", scroll);
    };
  }, [menu]);
  async function copyEntry(entry: Entry, fullPath: boolean) {
    setMenu(null);
    try {
      const path = `${directory.replace(/[\\/]+$/, "")}/${entry.path}`;
      await navigator.clipboard.writeText(fullPath ? clipboardPath(path) : entry.name);
    } catch (reason) {
      setError(tx("复制失败：{p0}", { p0: String(reason) }), true);
    }
  }
  const [query, setQuery] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [result, setResult] = useState<Matches | null>(null);
  const [notice, setNotice] = useState({ message: "", transient: false });
  const error = notice.message;
  const setError = (message: string, transient = false) => setNotice({ message, transient });
  useEffect(() => {
    if (!notice.message || !notice.transient) return;
    // Each failed action gets a fresh timer, including repeated identical errors.
    // 每次操作失败都重新计时，包括重复出现的相同错误。
    const timer = setTimeout(() => setNotice({ message: "", transient: false }), 3000);
    return () => clearTimeout(timer);
  }, [notice, directory]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const searching = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (mode !== "tree") input.current?.focus();
  }, [mode, request]);
  useEffect(() => {
    results.current?.querySelector(".file-hit.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  useEffect(() => {
    if (mode === "tree") return;
    let disposed = false;
    setLoading(true);
    setError("");
    setResult(null);
    setSelected(0);
    const timer = setTimeout(() => {
      searching.current = searching.current.then(async () => {
        if (disposed) return;
        await invoke<Matches>("files_search", {
          directory,
          query,
          content: mode === "search",
          sensitive,
          hidden,
        })
          .then((value) => {
            if (!disposed) setResult(value);
          })
          .catch((reason) => {
            if (!disposed) setError(String(reason));
          })
          .finally(() => {
            if (!disposed) setLoading(false);
          });
      });
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [directory, query, mode, sensitive, hidden, revision]);
  const mutationForm = target && (
    <form
      className={action === "delete" ? "file-management" : "file-inline-edit"}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !mutating) {
          event.preventDefault();
          setTarget(null);
        }
        if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (mutating || target.symlink || (action !== "delete" && !name.trim())) return;
        beforeMutation(() => {
          setMutating(true);
          setError("");
          void invoke("file_mutate", { directory, path: target.path, action, name })
            .then(() => {
              setTarget(null);
              setRevision((value) => value + 1);
            })
            .catch((reason) => setError(String(reason), true))
            .finally(() => setMutating(false));
        });
      }}
    >
      {action === "delete" ? (
        <p>{tx("永久删除“{p0}”？目录必须为空，此操作无法撤销。", { p0: target.name })}</p>
      ) : (
        <input
          autoFocus
          key={`${action}:${target.path}`}
          onFocus={(event) => event.currentTarget.select()}
          disabled={mutating}
          aria-label={tx("文件或目录名称")}
          required
          maxLength={255}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
        />
      )}
      <button disabled={mutating || target.symlink || (action !== "delete" && !name.trim())}>
        {action === "delete" ? tx("确认删除") : tx("确定")}
      </button>
      <button type="button" disabled={mutating} onClick={() => setTarget(null)}>
        {tx("取消")}
      </button>
      {target.symlink && <p>{tx("链接不能在此修改。")}</p>}
    </form>
  );
  return (
    <aside className="file-panel" aria-label={tx("文件面板")}>
      {resizeHandle}
      <header className="inspector-header">{headerActions}</header>
      <div role="tablist" aria-label={tx("文件视图")} className="inspector-tabs">
        {(
          [
            ["tree", tx("文件树")],
            ["quick", tx("快速打开")],
            ["search", tx("项目搜索")],
          ] as const
        ).map(([value, label]) => (
          <button
            className="toolbar-icon-button"
            title={label}
            aria-label={label}
            key={value}
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
          >
            <ToolbarIcon
              name={value === "tree" ? "tree" : value === "quick" ? "quick" : "search"}
            />
          </button>
        ))}
      </div>
      <div className="file-options">
        <button
          className="toolbar-icon-button"
          title={tx("新建文件")}
          aria-label={tx("新建文件")}
          disabled={mutating}
          onClick={() => manage(rootEntry, "file")}
        >
          <ToolbarIcon name="newFile" />
        </button>
        <button
          className="toolbar-icon-button"
          title={tx("新建目录")}
          aria-label={tx("新建目录")}
          disabled={mutating}
          onClick={() => manage(rootEntry, "directory")}
        >
          <ToolbarIcon name="newFolder" />
        </button>
        <button
          className="toolbar-icon-button"
          title={tx("刷新文件列表")}
          aria-label={tx("刷新文件列表")}
          disabled={mutating}
          onClick={() => setRevision((value) => value + 1)}
        >
          <ToolbarIcon name="restart" />
        </button>
        {mode === "search" && (
          <label>
            <input
              type="checkbox"
              checked={sensitive}
              onChange={(event) => setSensitive(event.target.checked)}
            />
            {tx("区分大小写")}
          </label>
        )}
      </div>
      {action === "delete" && mutationForm}
      {error && mode === "tree" && <p role="alert">{localizeMessage(error)}</p>}
      {mode !== "tree" && (
        <input
          ref={input}
          className="file-query"
          aria-label={mode === "quick" ? tx("搜索文件路径") : tx("搜索项目内容")}
          placeholder={mode === "quick" ? tx("输入文件名或路径") : tx("输入要查找的文本")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((value) =>
                Math.max(
                  0,
                  Math.min(
                    (result?.matches.length ?? 1) - 1,
                    value + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const hit = result?.matches[selected];
              if (hit) open(hit.path, hit.line || undefined);
            }
          }}
        />
      )}
      <div
        className="file-results"
        ref={results}
        tabIndex={0}
        onContextMenu={(event) => {
          if (
            mode !== "tree" ||
            mutating ||
            (event.target as HTMLElement).closest("input,textarea")
          )
            return;
          event.preventDefault();
          setFocusedEntry(null);
          setMenu({ entry: rootEntry, x: event.clientX, y: event.clientY });
        }}
        onPointerDown={(event) => {
          if (!(event.target as HTMLElement).closest("button,input,textarea"))
            setFocusedEntry(null);
        }}
        onKeyDown={(event) => {
          if (
            mode !== "tree" ||
            event.altKey ||
            event.nativeEvent.isComposing ||
            !(event.ctrlKey || event.metaKey) ||
            (event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")
          )
            return;
          const key = event.key.toLowerCase();
          if (key !== "c" && key !== "v") return;
          event.preventDefault();
          event.stopPropagation();
          if (key === "c" && focusedEntry) copyFile(focusedEntry);
          if (key === "v") void pasteFile(focusedEntry || rootEntry);
        }}
      >
        {mode === "tree" ? (
          <Folder
            key={directory}
            directory={directory}
            path=""
            depth={0}
            hidden={hidden}
            revision={revision}
            edit={
              target && action !== "delete"
                ? { path: target.path, rename: action === "rename", node: mutationForm }
                : null
            }
            open={open}
            manage={(entry, x, y) => {
              if (!mutating) setMenu({ entry, x, y });
            }}
            select={setFocusedEntry}
          />
        ) : (
          <>
            {loading && <p className="inspector-message">{tx("正在搜索…")}</p>}
            {error && (
              <p role="alert" className="inspector-message">
                {localizeMessage(error)}
              </p>
            )}
            {result?.matches.map((hit, index) => (
              <button
                className={`file-hit${index === selected ? " selected" : ""}`}
                key={`${hit.path}:${hit.line}`}
                title={hit.path}
                onFocus={() => setSelected(index)}
                onClick={() => open(hit.path, hit.line || undefined)}
              >
                <span>
                  {hit.path}
                  {hit.line ? `:${hit.line}` : ""}
                </span>
                {hit.text && <small>{hit.text}</small>}
              </button>
            ))}
            {result && !result.matches.length && (
              <p className="inspector-message">
                {mode === "search" && !query ? tx("输入文本以搜索项目。") : tx("没有匹配的文件。")}
              </p>
            )}
            {result?.partial && (
              <p className="inspector-message">{tx("已达到搜索上限，请缩小搜索范围。")}</p>
            )}
            {!!result?.skipped && (
              <p className="inspector-message">
                {tx("已跳过 {p0} 个过大或无法读取的文件。", { p0: result.skipped })}
              </p>
            )}
          </>
        )}
      </div>
      <footer className="file-panel-footer" title={clipboardPath(directory)}>
        {clipboardPath(directory)}
      </footer>
      {menu && (
        <div
          ref={menuElement}
          className="context-menu"
          role="menu"
          aria-label={tx("文件操作")}
          style={{
            left: Math.max(0, Math.min(menu.x, window.innerWidth - 220)),
            top: Math.max(0, Math.min(menu.y, window.innerHeight - 390)),
          }}
          onKeyDown={(event) => {
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
            );
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              buttons[
                (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length
              ]?.focus();
            }
            if (event.key === "Tab") setMenu(null);
          }}
        >
          <button
            role="menuitem"
            disabled={!menu.entry.path || menu.entry.symlink || mutating}
            onClick={() => copyFile(menu.entry)}
          >
            {tx("复制")}
          </button>
          <button
            role="menuitem"
            disabled={!fileClipboard || menu.entry.symlink || mutating}
            onClick={() => void pasteFile(menu.entry)}
          >
            {tx("粘贴")}
          </button>
          <button
            role="menuitem"
            disabled={!menu.entry.path || menu.entry.symlink || mutating}
            onClick={() => manage(menu.entry, "rename")}
          >
            {tx("重命名")}
          </button>
          <button
            role="menuitem"
            disabled={!menu.entry.path || menu.entry.symlink || mutating}
            onClick={() => manage(menu.entry, "delete")}
          >
            {tx("删除")}
          </button>
          <button
            role="menuitem"
            disabled={menu.entry.directory && menu.entry.symlink}
            onClick={() => manage(menu.entry, "file")}
          >
            {tx("新建文件")}
          </button>
          <button
            role="menuitem"
            disabled={menu.entry.directory && menu.entry.symlink}
            onClick={() => manage(menu.entry, "directory")}
          >
            {tx("新建目录")}
          </button>
          <button role="menuitem" onClick={() => void copyEntry(menu.entry, true)}>
            {tx("复制路径")}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const path = menu.entry.path;
              setMenu(null);
              void invoke("file_reveal", { directory, path }).catch((reason) =>
                setError(String(reason), true),
              );
            }}
          >
            {tx("在文件管理器中打开")}
          </button>
          <button role="menuitem" onClick={() => void copyEntry(menu.entry, false)}>
            {tx("复制文件名")}
          </button>
        </div>
      )}
    </aside>
  );
}
