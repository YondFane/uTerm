import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { displayLocalPath } from "../lib/file-target";
import type { JavaTask } from "../lib/java-build";
import { ToolbarIcon } from "./SidebarIcon";

export function ProjectRunButton({
  language,
  title,
  running,
  pressed,
  onClick,
  onSelect,
}: {
  language: "java" | "python";
  title: string;
  running: boolean;
  pressed: boolean;
  onClick: () => void;
  onSelect: (task: JavaTask) => void;
}) {
  useUiLanguage();
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [tasks, setTasks] = useState<JavaTask[] | null>(null);
  const [error, setError] = useState("");
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const open = !!position;
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setTasks(null);
    setError("");
    const refresh = async () => {
      try {
        const values = await invoke<JavaTask[]>("project_run_list");
        if (disposed) return;
        setTasks(
          values
            .filter(
              (task) =>
                task.running &&
                (language === "java"
                  ? task.task.action === "run"
                  : task.task.action === "python:run" ||
                    task.task.action.startsWith("python:run|")),
            )
            .sort((a, b) => b.task.created - a.task.created),
        );
        setError("");
      } catch {
        if (!disposed) setError(tx("无法读取启动列表，请稍后重试。"));
      } finally {
        if (!disposed) timer = setTimeout(refresh, 1500);
      }
    };
    void refresh();
    const outside = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !button.current?.contains(event.target as Node)
      )
        setPosition(null);
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPosition(null);
        button.current?.focus();
      }
    };
    menu.current?.focus();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", dismiss, true);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", dismiss, true);
    };
  }, [open, language]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="toolbar-icon-button"
        aria-label={title}
        title={title}
        aria-pressed={pressed}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setPosition(null);
          onClick();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setPosition({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setPosition({ x: rect.left, y: rect.bottom });
          }
        }}
      >
        <ToolbarIcon name={language} running={running} />
      </button>
      {position &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            tabIndex={-1}
            aria-label={language === "java" ? tx("Java 启动列表") : tx("Python 启动列表")}
            className="context-menu project-run-menu"
            style={{
              left: Math.max(8, Math.min(position.x, window.innerWidth - 368)),
              top: Math.max(8, Math.min(position.y, window.innerHeight - 308)),
            }}
            onKeyDown={(event) => {
              if (event.key === "Tab") {
                setPosition(null);
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
              );
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : index < 0
                      ? event.key === "ArrowUp"
                        ? buttons.length - 1
                        : 0
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                        buttons.length
              ]?.focus();
            }}
          >
            <p className="project-run-menu-heading">
              {language === "java" ? tx("Java 启动列表") : tx("Python 启动列表")}
            </p>
            {error ? (
              <p role="alert">{error}</p>
            ) : tasks === null ? (
              <p role="status">{tx("正在读取…")}</p>
            ) : !tasks.length ? (
              <p role="status">{tx("暂无运行项目")}</p>
            ) : null}
            {tasks?.map((task) => (
              <button
                key={task.spec.id}
                role="menuitem"
                title={displayLocalPath(task.task.root)}
                onClick={() => {
                  setPosition(null);
                  onSelect(task);
                }}
              >
                <span className="project-run-menu-name">
                  <span className="status-dot" aria-hidden="true" />
                  {task.task.name}
                </span>
                <small>{displayLocalPath(task.task.root)}</small>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
