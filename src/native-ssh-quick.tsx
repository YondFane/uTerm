import { useEffect, useState } from "react";
import { SshQuickConnect } from "./components/SshQuickConnect";
import { contentInvoke, listenContent } from "./lib/content-host";
import { localizeMessage, tx } from "./lib/i18n";
import { sshTargetFor } from "./lib/workspace";
import { useSettings } from "./lib/SettingsContext";

export function NativeSshQuick() {
  const settings = useSettings();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function load() {
    try {
      const context = await contentInvoke<{ workspaceId: string }>("quick_ssh_context");
      setWorkspaceId(context.workspaceId);
      setError("");
    } catch (reason) {
      setError(localizeMessage(String(reason)));
    }
  }
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
      {!workspaceId && error && <p role="alert">{error}</p>}
      {workspaceId ? (
        <SshQuickConnect
          errorMessage={error}
          close={() => {
            void contentInvoke("quick_ssh_close").catch((reason) =>
              setError(localizeMessage(String(reason))),
            );
          }}
          connect={(connection) =>
            contentInvoke<boolean>("quick_ssh_connect", {
              connection: sshTargetFor(connection, workspaceId),
            })
          }
        />
      ) : (
        <button onClick={() => void load()}>{tx("重试")}</button>
      )}
    </main>
  );
}
