import { useEffect, useRef, useState } from "react";
import { SshQuickConnect } from "./components/SshQuickConnect";
import { contentInvoke, listenContent } from "./lib/content-host";
import { localizeMessage, tx } from "./lib/i18n";
import { sshTargetFor } from "./lib/workspace";
import { useSettings } from "./lib/SettingsContext";
import { useNativeModalLayout } from "./lib/useNativeModalLayout";
import { useDialogBackdrop } from "./lib/useDialogBackdrop";

function QuickContextDialog({
  error,
  loading,
  retry,
  close,
}: {
  error: string;
  loading: boolean;
  retry: () => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdrop = useDialogBackdrop(close);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="ssh-dialog ssh-quick-dialog"
      aria-labelledby="native-quick-context-title"
      {...backdrop}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!loading) retry();
        }}
      >
        <h2 id="native-quick-context-title">{tx("快速 SSH 连接")}</h2>
        {error ? <p role="alert">{error}</p> : <p role="status">{tx("加载中…")}</p>}
        <div>
          <button type="button" onClick={close}>
            {tx("取消")}
          </button>
          <button type="button" disabled={loading} onClick={retry}>
            {tx("重试")}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function NativeSshQuick() {
  const settings = useSettings();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const reading = useRef(false);
  useNativeModalLayout(".ssh-quick-dialog", "quick_ssh_layout", workspaceId, setError);
  async function load() {
    if (reading.current) return;
    reading.current = true;
    setLoading(true);
    try {
      const context = await contentInvoke<{ workspaceId: string }>("quick_ssh_context");
      if (typeof context?.workspaceId !== "string" || !context.workspaceId.trim())
        throw Error(tx("快速 SSH 工作区无效，请重试。"));
      setWorkspaceId(context.workspaceId);
      setError("");
    } catch (reason) {
      setError(localizeMessage(String(reason)));
    } finally {
      reading.current = false;
      setLoading(false);
    }
  }
  const close = () => {
    void contentInvoke("quick_ssh_close").catch((reason) =>
      setError(localizeMessage(String(reason))),
    );
  };
  useEffect(() => {
    void load();
    let disposed = false;
    const subscription = listenContent("quick-ssh-settings-changed", () => {
      void settings.reload().catch((reason) => {
        if (!disposed) setError(localizeMessage(String(reason)));
      });
    }).catch((reason) => {
      if (!disposed) setError(localizeMessage(String(reason)));
    });
    return () => {
      disposed = true;
      void subscription.then((stop) => stop?.());
    };
  }, []);
  return (
    <main className="native-content native-ssh-quick">
      {workspaceId ? (
        <SshQuickConnect
          errorMessage={error}
          close={close}
          connect={(connection) =>
            contentInvoke<boolean>("quick_ssh_connect", {
              connection: sshTargetFor(connection, workspaceId),
            })
          }
        />
      ) : (
        <QuickContextDialog
          error={error}
          loading={loading}
          retry={() => void load()}
          close={close}
        />
      )}
    </main>
  );
}
