import { useEffect, useRef } from "react";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { displayLocalPath } from "../lib/file-target";

export function WorktreeDeleteDialog({
  name,
  directory,
  path,
  onCancel,
  onConfirm,
}: {
  name: string;
  directory: string;
  path: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      if (element?.open) element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="name-dialog worktree-delete-dialog"
      aria-labelledby="worktree-delete-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <h2 id="worktree-delete-title">{tx("删除 Worktree")}</h2>
        <p>
          {tx("删除 Worktree “{p0}”及其文件夹？未提交或未跟踪的文件会阻止删除。", { p0: name })}
        </p>
        <p>
          {tx("工作目录")}
          <code>{displayLocalPath(directory)}</code>
        </p>
        <p>
          {tx("Worktree 目录")}
          <code>{displayLocalPath(path)}</code>
        </p>
        <div>
          <button type="button" ref={cancel} autoFocus onClick={onCancel}>
            {tx("取消")}
          </button>
          <button type="submit" className="danger">
            {tx("删除 Worktree")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
