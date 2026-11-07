import { useState } from "react";
import { coreRequest } from "../lib/shared-state";
import { tx } from "../lib/i18n";

export function StateRecovery({ reason }: { reason: unknown }) {
  const [message, setMessage] = useState(String(reason));
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<{ currentRevision: string; backups: string[] } | null>(
    null,
  );
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <p role="alert">{message}</p>
      <p>{tx("原始数据已保留。")}</p>
      <button disabled={busy} onClick={() => location.reload()}>
        {tx("重试")}
      </button>
      <button
        disabled={busy}
        onClick={() =>
          void perform(async () =>
            setRecovery((await coreRequest("recovery.list")) as unknown as typeof recovery),
          )
        }
      >
        {tx("查看恢复副本")}
      </button>
      {recovery?.backups.map((revision) => (
        <button
          key={revision}
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await coreRequest("recovery.restore", {
                expectedRevision: recovery.currentRevision,
                backupRevision: revision,
              });
              location.reload();
            })
          }
        >
          {tx("从副本恢复")} {revision.slice(0, 12)}
        </button>
      ))}
    </main>
  );
}
