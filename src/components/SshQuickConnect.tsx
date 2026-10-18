import { useEffect, useRef, useState } from "react";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
import { parseQuickSsh } from "../lib/ssh";
import type { SshConnection } from "../lib/workspace";

export function SshQuickConnect({
  connect,
  close,
}: {
  connect: (connection: SshConnection) => boolean;
  close: () => void;
}) {
  useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const backdrop = useDialogBackdrop(close);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      className="ssh-dialog ssh-quick-dialog"
      aria-labelledby="ssh-quick-title"
      ref={dialog}
      {...backdrop}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parseQuickSsh(address);
          if (!parsed) {
            setError(
              tx("请输入 Host 别名、user@host:port 或 ssh://user@host:port，不包含密码或命令。"),
            );
            return;
          }
          if (connect({ ...parsed, id: crypto.randomUUID(), sessions: [] })) close();
          else setError(tx("无法保存连接，未启动 SSH 登录。"));
        }}
      >
        <h2 id="ssh-quick-title">{tx("快速 SSH 连接")}</h2>
        <label>
          {tx("SSH 地址")}
          <input
            autoFocus
            required
            value={address}
            maxLength={800}
            placeholder={tx("user@host:22")}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <p className="muted">
          {tx(
            "使用 OpenSSH 自动认证，在终端完成认证。临时配置为恢复会话保留；关闭最后会话且释放文件和隧道后自动移除，也可保存为常用连接。",
          )}
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={close}>
            {tx("取消")}
          </button>
          <button className="primary">{tx("连接")}</button>
        </div>
      </form>
    </dialog>
  );
}
