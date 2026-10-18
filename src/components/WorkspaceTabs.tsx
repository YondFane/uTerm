import { displayDirectory, isRemoteDirectory } from "../lib/file-target";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { clipboardPath, isDirty, type OpenFile } from "../lib/file-document";
import { setFileClipboard } from "../lib/file-clipboard";
import type { SessionConfig } from "../lib/workspace";
import { SessionIcon, ToolbarIcon } from "./SidebarIcon";
import { TransientError } from "./TransientError";

const filePath = (file: OpenFile) =>
  clipboardPath(`${displayDirectory(file.directory).replace(/[\\/]+$/, "")}/${file.path}`);

export function WorkspaceTabs({
  sessions,
  documents,
  activeFile,
  activeSession,
  detectedAgents,
  disabled,
  selectSession,
  selectFile,
  closeFile,
  diff,
  selectDiff,
  closeDiff,
}: {
  diff?: { path: string; active: boolean };
  selectDiff?: () => void;
  closeDiff?: () => void;
  sessions: SessionConfig[];
  documents: OpenFile[];
  activeFile: number | null;
  activeSession: string | null;
  detectedAgents: Record<string, string>;
  disabled: boolean;
  selectSession: (id: string) => void;
  selectFile: (file: OpenFile) => void;
  closeFile: (id: number) => void;
}) {
  useUiLanguage();
  const list = useRef<HTMLDivElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ file: OpenFile; x: number; y: number } | null>(null);
  const [error, setError] = useState("");
  const openMenu = (file: OpenFile, x: number, y: number) => {
    if (disabled) return;
    setError("");
    setMenu({ file, x, y });
  };
  useLayoutEffect(() => {
    const popup = menuElement.current;
    if (!menu || !popup) return;
    const bounds = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`;
  });
  useEffect(() => {
    setMenu(null);
  }, [activeFile, activeSession, diff?.active, disabled]);
  useEffect(() => {
    if (
      menu &&
      !documents.some(
        (file) =>
          file.id === menu.file.id &&
          file.directory === menu.file.directory &&
          file.path === menu.file.path,
      )
    )
      setMenu(null);
  }, [documents, menu]);
  useEffect(() => {
    if (!menu) return;
    menuElement.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = () => setMenu(null);
    const outside = (event: Event) => {
      if (!menuElement.current?.contains(event.target as Node)) dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
      document.getElementById(`workspace-file-${menu.file.id}`)?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("contextmenu", outside);
    document.addEventListener("scroll", outside, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("contextmenu", outside);
      document.removeEventListener("scroll", outside, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu]);
  async function copyText(file: OpenFile, path: boolean) {
    setMenu(null);
    try {
      await navigator.clipboard.writeText(path ? filePath(file) : file.path.split(/[\\/]/).at(-1)!);
    } catch (reason) {
      setError(tx("复制失败：{p0}", { p0: String(reason) }));
    }
  }
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.parentElement?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
  }, [activeFile, activeSession, diff?.active]);
  const visibleSessions = sessions.filter((session) => session.id === activeSession);
  if (!documents.length && !diff) return null;
  const hasActiveTab =
    !!diff?.active ||
    documents.some((file) => file.id === activeFile) ||
    (activeFile === null && visibleSessions.some((session) => session.id === activeSession));
  return (
    <>
      <div
        ref={list}
        className="workspace-tabs"
        role="tablist"
        aria-label={tx("工作区标签")}
        onKeyDown={(event) => {
          if (disabled || !(event.target instanceof HTMLElement) || event.target.role !== "tab")
            return;
          const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
          const index = tabs.indexOf(event.target as HTMLButtonElement);
          const next =
            event.key === "ArrowRight"
              ? (index + 1) % tabs.length
              : event.key === "ArrowLeft"
                ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : -1;
          if (next < 0) return;
          event.preventDefault();
          event.stopPropagation();
          tabs[next]?.focus();
          tabs[next]?.click();
        }}
      >
        {visibleSessions.map((session, index) => {
          const active = !diff?.active && activeFile === null && activeSession === session.id;
          return (
            <div className="workspace-tab" data-active={active || undefined} key={session.id}>
              <button
                role="tab"
                id={`workspace-session-${session.id}`}
                aria-controls="workspace-content"
                aria-selected={active}
                tabIndex={active || (!hasActiveTab && index === 0) ? 0 : -1}
                title={session.name}
                disabled={disabled}
                onClick={() => selectSession(session.id)}
              >
                <SessionIcon agent={session.agent ?? detectedAgents[session.id]} />
                <span>{session.name}</span>
              </button>
            </div>
          );
        })}
        {diff && (
          <div
            className="workspace-tab"
            data-active={diff.active || undefined}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              if (!disabled) closeDiff?.();
            }}
          >
            <button
              role="tab"
              id="workspace-git-diff"
              aria-controls="workspace-content"
              aria-selected={diff.active}
              tabIndex={diff.active ? 0 : -1}
              title={diff.path}
              disabled={disabled}
              onClick={selectDiff}
            >
              <span>
                {tx("Git 差异 · {p0}", { p0: diff.path.split(/[\\/]/).at(-1) ?? diff.path })}
              </span>
            </button>
            <button
              className="workspace-tab-close"
              title={tx("关闭差异")}
              aria-label={tx("关闭差异")}
              disabled={disabled}
              onClick={closeDiff}
            >
              <ToolbarIcon name="close" />
            </button>
          </div>
        )}
        {documents.map((file, index) => {
          const active = !diff?.active && activeFile === file.id;
          return (
            <div
              className="workspace-tab"
              data-active={active || undefined}
              key={file.id}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                if (!disabled) closeFile(file.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openMenu(file, event.clientX, event.clientY);
              }}
            >
              <button
                role="tab"
                id={`workspace-file-${file.id}`}
                aria-controls="workspace-content"
                aria-selected={active}
                tabIndex={
                  active || (!hasActiveTab && !visibleSessions.length && index === 0) ? 0 : -1
                }
                title={filePath(file)}
                aria-haspopup="menu"
                disabled={disabled}
                onClick={() => selectFile(file)}
                onKeyDown={(event) => {
                  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  openMenu(file, bounds.left, bounds.bottom);
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M6 3h8l4 4v14H6zM14 3v5h4" />
                </svg>
                <span>{file.path.split(/[\\/]/).at(-1)}</span>
                {isDirty(file) && (
                  <span className="workspace-tab-dirty" aria-label={tx("未保存")}>
                    ●
                  </span>
                )}
              </button>
              <button
                className="workspace-tab-close"
                title={tx("关闭文件 {p0}", { p0: file.path })}
                aria-label={tx("关闭文件 {p0}", { p0: file.path })}
                disabled={disabled}
                onClick={() => closeFile(file.id)}
              >
                <ToolbarIcon name="close" />
              </button>
            </div>
          );
        })}
      </div>
      {error && <TransientError key={error} message={error} />}
      {menu &&
        createPortal(
          <div
            ref={menuElement}
            className="context-menu workspace-file-menu"
            role="menu"
            aria-label={tx("文件操作")}
            style={{
              left: menu.x,
              top: menu.y,
              maxWidth: "calc(100vw - 16px)",
              maxHeight: "calc(100vh - 16px)",
            }}
            onKeyDown={(event) => {
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              ];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === "ArrowDown"
                  ? (index + 1) % buttons.length
                  : event.key === "ArrowUp"
                    ? (index + buttons.length - 1) % buttons.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : -1;
              if (next >= 0) {
                event.preventDefault();
                event.stopPropagation();
                buttons[next]?.focus();
              }
              if (event.key === "Tab") setMenu(null);
            }}
          >
            <button
              role="menuitem"
              disabled={isRemoteDirectory(menu.file.directory)}
              onClick={() => {
                setFileClipboard({ directory: menu.file.directory, path: menu.file.path });
                setMenu(null);
              }}
            >
              {tx("复制")}
            </button>
            <button role="menuitem" onClick={() => void copyText(menu.file, false)}>
              {tx("复制文件名")}
            </button>
            <button role="menuitem" onClick={() => void copyText(menu.file, true)}>
              {tx("复制文件路径")}
            </button>
            <button
              role="menuitem"
              disabled={isRemoteDirectory(menu.file.directory)}
              onClick={() => {
                const { directory, path } = menu.file;
                setMenu(null);
                void invoke("file_reveal", { directory, path }).catch((reason) =>
                  setError(String(reason)),
                );
              }}
            >
              {tx("在文件管理器中打开")}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
