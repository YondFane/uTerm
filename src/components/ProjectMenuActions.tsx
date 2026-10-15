import { useLayoutEffect, useRef, useState } from "react";
import { clipboardPath } from "../lib/file-document";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";

export function ProjectMenuActions({
  directory,
  workspaces,
  creatingWorktree,
  createWorktree,
  move,
  close,
  onError,
}: {
  directory: string;
  workspaces: { id: string; name: string }[];
  creatingWorktree: boolean;
  createWorktree: () => void;
  move: (target: string) => void;
  close: () => void;
  onError: (error: string) => void;
}) {
  useUiLanguage();
  const trigger = useRef<HTMLButtonElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const keyboardOpen = useRef(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  function open(keyboard = false) {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect || !workspaces.length) return;
    keyboardOpen.current = keyboard;
    setPosition({
      left: Math.max(
        8,
        rect.right + 220 <= window.innerWidth - 8 ? rect.right - 1 : rect.left - 219,
      ),
      top: Math.max(
        8,
        Math.min(rect.top, window.innerHeight - Math.min(300, workspaces.length * 40 + 12) - 8),
      ),
    });
  }
  function collapse() {
    setPosition(null);
    trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (position && keyboardOpen.current) submenu.current?.querySelector("button")?.focus();
  }, [position]);
  return (
    <>
      <button
        role="menuitem"
        onClick={() => {
          void navigator.clipboard
            .writeText(clipboardPath(directory))
            .catch((reason) => onError(String(reason)));
          close();
        }}
      >
        {tx("复制项目地址")}
      </button>
      <button
        role="menuitem"
        disabled={creatingWorktree}
        onClick={() => {
          close();
          createWorktree();
        }}
      >
        {creatingWorktree ? tx("正在创建 Worktree") : tx("新建 Worktree")}
      </button>
      <div
        onPointerEnter={() => open()}
        onPointerLeave={() => setPosition(null)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPosition(null);
        }}
      >
        <button
          ref={trigger}
          role="menuitem"
          className="workspace-submenu-trigger"
          aria-haspopup="menu"
          aria-expanded={!!position}
          disabled={!workspaces.length}
          title={!workspaces.length ? tx("没有其他工作空间") : undefined}
          onClick={() => open(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              event.stopPropagation();
              open(true);
            }
          }}
        >
          {tx("移动到工作空间")}
          <span aria-hidden="true">›</span>
        </button>
        {position && (
          <div
            ref={submenu}
            role="menu"
            aria-label={tx("移动到工作空间")}
            className="context-menu workspace-submenu"
            style={position}
            onKeyDown={(event) => {
              if (["Escape", "ArrowLeft"].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                collapse();
              } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
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
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                role="menuitem"
                onClick={() => {
                  move(workspace.id);
                  close();
                }}
              >
                {workspace.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
