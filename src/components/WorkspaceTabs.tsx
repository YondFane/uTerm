import { useEffect, useRef } from "react";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { isDirty, type OpenFile } from "../lib/file-document";
import type { SessionConfig } from "../lib/workspace";
import { SessionIcon } from "./SidebarIcon";

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
            ×
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
          >
            <button
              role="tab"
              id={`workspace-file-${file.id}`}
              aria-controls="workspace-content"
              aria-selected={active}
              tabIndex={
                active || (!hasActiveTab && !visibleSessions.length && index === 0) ? 0 : -1
              }
              title={`${file.directory}/${file.path}`}
              disabled={disabled}
              onClick={() => selectFile(file)}
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
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
