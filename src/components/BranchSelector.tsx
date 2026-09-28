import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { localizeMessage, tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { SidebarIcon } from "./SidebarIcon";

type Branches = { current: string | null; local: string[]; upstream?: string | null };
type RemoteBranch = { remote: string; branch: string };
type RemoteBranches = { branches: RemoteBranch[]; errors: string[] };

export function BranchSelector({
  directory,
  disabled,
  beforeSwitch,
  onChanged,
  onError,
}: {
  directory: string;
  disabled: boolean;
  beforeSwitch: (action: () => Promise<void>) => void;
  onChanged: () => void;
  onError: (error: string) => void;
}) {
  useUiLanguage();
  const [branches, setBranches] = useState<Branches | null>(null);
  const [remote, setRemote] = useState<RemoteBranches>({ branches: [], errors: [] });
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState("");
  const [menu, setMenu] = useState<{ kind: "branches" | "actions"; x: number; y: number } | null>(
    null,
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const alive = useRef(false);
  const changing = useRef(false);
  const revision = useRef(0);
  const remoteRequest = useRef(0);

  async function readBranches() {
    const request = revision.current;
    const next = await invoke<Branches>("git_branches", { directory });
    if (alive.current && request === revision.current) {
      setBranches((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
      setError("");
    }
  }
  async function readRemote() {
    if (loadingRemote) return;
    const request = ++remoteRequest.current;
    setLoadingRemote(true);
    try {
      const next = await invoke<RemoteBranches>("git_remote_branches", { directory });
      if (alive.current && request === remoteRequest.current) setRemote(next);
    } catch (reason) {
      if (alive.current && request === remoteRequest.current)
        setRemote({ branches: [], errors: [String(reason)] });
    } finally {
      if (alive.current && request === remoteRequest.current) setLoadingRemote(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    let loading = false;
    let disposed = false;
    async function refresh() {
      if (loading || changing.current || document.hidden || disposed) return;
      loading = true;
      const request = revision.current;
      try {
        await readBranches();
      } catch (reason) {
        if (!disposed && request === revision.current) setError(String(reason));
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive.current = false;
      disposed = true;
      revision.current += 1;
      remoteRequest.current += 1;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [directory]);

  function closeMenu(focus = false) {
    setMenu(null);
    if (focus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!menu) return;
    (
      popup.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? popup.current
    )?.focus();
    function outside(event: PointerEvent) {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        closeMenu();
    }
    function dismiss() {
      closeMenu();
    }
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu]);

  function openMenu(kind: "branches" | "actions", x?: number, y?: number) {
    if (disabled || changing.current) return;
    const rect = trigger.current?.getBoundingClientRect();
    setMenu({
      kind,
      x: Math.max(4, Math.min(x ?? rect?.left ?? 4, window.innerWidth - 304)),
      y: Math.max(4, Math.min(y ?? rect?.bottom ?? 4, window.innerHeight - 304)),
    });
    if (kind === "branches") void readRemote();
  }
  function execute(label: string, command: string, args: Record<string, string>) {
    const expected = branches?.current;
    if (disabled || changing.current || !expected) return;
    closeMenu(true);
    beforeSwitch(async () => {
      // Deferred editor saves must not operate on an unmounted repository selector.
      // 编辑器延迟保存后，不能操作已卸载选择器对应的仓库。
      if (!alive.current || changing.current) return;
      changing.current = true;
      revision.current += 1;
      remoteRequest.current += 1;
      setLoadingRemote(false);
      setBusy(label);
      setResult("");
      let succeeded = false;
      try {
        await invoke<void>(command, { directory, expected, ...args });
        succeeded = true;
        if (alive.current) setResult(tx("{p0} 已完成", { p0: label }));
      } catch (reason) {
        if (alive.current) {
          setError(String(reason));
          onError(String(reason));
        }
      } finally {
        if (alive.current) {
          // Refresh even after partial failure, since fetch or switch may already have succeeded.
          // 即使部分失败也刷新，因为获取或切换可能已经成功。
          onChanged();
          try {
            await readBranches();
          } catch (reason) {
            if (succeeded) onError(String(reason));
          }
        }
        changing.current = false;
        if (alive.current) setBusy("");
      }
    });
  }
  if (!branches?.current && !error) return null;
  const current = branches?.current ?? "";
  const attached = !!branches?.local.includes(current);
  return (
    <>
      <span
        className="workspace-branch"
        title={error ? localizeMessage(error) : result || tx("当前分支：{p0}", { p0: current })}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu("actions", event.clientX, event.clientY);
        }}
      >
        <SidebarIcon name="branch" />
        <button
          ref={trigger}
          className="branch-trigger"
          aria-label={tx("切换分支")}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          aria-busy={!!busy}
          disabled={disabled || !!busy || !current}
          onClick={() => (menu ? closeMenu() : openMenu("branches"))}
          onKeyDown={(event) => {
            if (
              event.key === "ArrowDown" ||
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              event.preventDefault();
              openMenu(event.key === "ArrowDown" ? "branches" : "actions");
            }
          }}
        >
          {busy ? tx("正在执行 {p0}…", { p0: busy }) : current || tx("分支读取失败")}{" "}
          <span aria-hidden="true">⌄</span>
        </button>
        <span className="branch-announcement" role="status">
          {busy ? tx("正在执行 {p0}…", { p0: busy }) : result}
        </span>
      </span>
      {menu &&
        createPortal(
          <div
            ref={popup}
            className="context-menu branch-menu"
            role="menu"
            tabIndex={-1}
            onContextMenu={(event) => event.preventDefault()}
            aria-label={menu.kind === "branches" ? tx("切换分支") : tx("Git 操作")}
            style={{
              left: menu.x,
              top: menu.y,
              maxHeight: Math.max(100, window.innerHeight - menu.y - 8),
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Tab") {
                if (event.key === "Escape") event.preventDefault();
                event.stopPropagation();
                closeMenu(event.key === "Escape");
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
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
            }}
          >
            {menu.kind === "branches" ? (
              <>
                <div className="branch-menu-heading">{tx("Local")}</div>
                {branches?.local.map((branch) => (
                  <button
                    key={branch}
                    role="menuitemradio"
                    aria-checked={branch === current}
                    disabled={disabled || !!busy}
                    onClick={() =>
                      branch === current
                        ? closeMenu(true)
                        : execute(tx("切换分支"), "git_switch_branch", { branch })
                    }
                  >
                    <span aria-hidden="true">{branch === current ? "✓ " : ""}</span>
                    {branch}
                  </button>
                ))}
                {!branches?.local.length && (
                  <div className="branch-menu-note">{tx("没有本地分支")}</div>
                )}
                <div className="branch-menu-heading">{tx("Remote")}</div>
                {loadingRemote && (
                  <div className="branch-menu-note" role="status">
                    {tx("正在读取远程分支…")}
                  </div>
                )}
                {!loadingRemote &&
                  remote.branches.map(({ remote, branch }) => (
                    <button
                      key={JSON.stringify([remote, branch])}
                      role="menuitem"
                      disabled={disabled || !!busy}
                      onClick={() =>
                        execute(tx("切换分支"), "git_switch_remote_branch", { remote, branch })
                      }
                    >
                      {remote}/{branch}
                    </button>
                  ))}
                {!loadingRemote && !remote.branches.length && !remote.errors.length && (
                  <div className="branch-menu-note">{tx("没有远程分支")}</div>
                )}
                {!loadingRemote &&
                  remote.errors.map((message, index) => (
                    <div key={index} className="branch-menu-error" role="alert">
                      {localizeMessage(message)}
                    </div>
                  ))}
              </>
            ) : (
              <>
                <div className="branch-menu-heading">{current}</div>
                <div className="branch-menu-note">{branches?.upstream || tx("未设置上游分支")}</div>
                {(["push", "pull", "fetch"] as const).map((action) => (
                  <button
                    key={action}
                    role="menuitem"
                    disabled={
                      disabled ||
                      !!busy ||
                      (action !== "fetch" && (!attached || !branches?.upstream))
                    }
                    title={
                      action !== "fetch" && !branches?.upstream
                        ? tx("请先在终端中设置上游分支")
                        : undefined
                    }
                    onClick={() =>
                      execute(
                        action === "push" ? "Push" : action === "pull" ? "Pull" : "Fetch",
                        "git_branch_action",
                        { action },
                      )
                    }
                  >
                    {action === "push"
                      ? tx("推送 Push")
                      : action === "pull"
                        ? tx("拉取 Pull（仅快进）")
                        : tx("获取 Fetch")}
                  </button>
                ))}
                <button
                  role="menuitem"
                  onClick={() => {
                    openMenu("branches");
                    void readBranches().catch((reason) => {
                      if (alive.current) onError(String(reason));
                    });
                  }}
                >
                  {tx("刷新分支列表")}
                </button>
                {result && (
                  <div className="branch-menu-note" role="status">
                    {result}
                  </div>
                )}
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
