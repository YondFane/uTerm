import { useEffect, useRef } from "react";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import type { Updates } from "../lib/useUpdates";

export function UpdateInstallDialog({ updates }: { updates: Updates }) {
  useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="name-dialog update-install-dialog"
      aria-labelledby="update-install-title"
      onCancel={(event) => {
        event.preventDefault();
        updates.cancelInstall();
      }}
    >
      <h2 id="update-install-title">{tx("确认安装更新")}</h2>
      <p role="status" aria-live="polite">
        {tx("将在 {p0} 秒后安装更新并重启。", { p0: updates.confirmation ?? 0 })}
      </p>
      <p>{tx("取消将停止本次安装，可稍后在软件更新中手动安装。")}</p>
      <div className="update-install-actions">
        <button ref={cancel} onClick={updates.cancelInstall}>
          {tx("取消")}
        </button>
        <button onClick={() => void updates.confirmInstall()}>{tx("立即安装")}</button>
      </div>
    </dialog>
  );
}
