import { useEffect, useRef, useState } from "react";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
import { parseQuickSsh } from "../lib/ssh";
import type { SshConnection } from "../lib/workspace";

export function SshQuickConnect({
  connect,
  close,
  errorMessage = "",
}: {
  connect: (connection: SshConnection) => boolean | Promise<boolean>;
  close: () => void;
  errorMessage?: string;
}) {
  useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const dismiss = () => {
    if (!pending.current) close();
  };
  const backdrop = useDialogBackdrop(dismiss);
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
        dismiss();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending.current) return;
          const parsed = parseQuickSsh(address);
          if (!parsed) {
            setError(
              tx("请输入 Host 别名、user@host:port 或 ssh://user@host:port，不包含密码或命令。"),
            );
            return;
          }
          pending.current = true;
          setBusy(true);
          setError("");
          try {
            if (await connect({ ...parsed, id: crypto.randomUUID(), sessions: [] })) close();
            else setError(tx("无法保存连接，未启动 SSH 登录。"));
          } catch {
            setError(tx("无法保存连接，未启动 SSH 登录。"));
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        <h2 id="ssh-quick-title">{tx("快速 SSH 连接")}</h2>
        <label>
          {tx("SSH 地址")}
          <input
            autoFocus
            required
            disabled={busy}
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
        {(error || errorMessage) && <p role="alert">{error || errorMessage}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={dismiss}>
            {tx("取消")}
          </button>
          <button className="primary" disabled={busy}>
            {busy ? tx("正在保存…") : tx("连接")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
