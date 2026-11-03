import { useState } from "react";
import type {
  CoreEditorDraftSnapshot,
  CoreEditorRecoveryCatalog,
} from "../lib/core-contract.generated";
import { EditorDraftHandoff } from "../lib/editor-draft-handoff";
import { coreRequest } from "../lib/shared-state";
import { tx } from "../lib/i18n";

export function EditorDraftRecovery({
  reason,
  handoff,
  ready,
}: {
  reason: unknown;
  handoff?: EditorDraftHandoff;
  ready: (snapshot: CoreEditorDraftSnapshot) => void;
}) {
  const [message, setMessage] = useState(String(reason));
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<CoreEditorRecoveryCatalog | null>(null);
  const [preview, setPreview] = useState<CoreEditorDraftSnapshot | null>(null);
  const legacy = handoff?.legacy ?? null;
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
    <main className="editor-draft-recovery">
      <h1>{tx("恢复编辑器草稿")}</h1>
      <p role="alert">{message}</p>
      <p>{tx("旧草稿和共享草稿分别保留。选择共享草稿不会覆盖另一来源。")}</p>
      <div className="editor-draft-recovery-actions">
        <button disabled={busy} onClick={() => location.reload()}>
          {tx("重试")}
        </button>
        {handoff?.canAcceptShared && (
          <button
            disabled={busy}
            onClick={() => void perform(async () => ready(await handoff!.acceptShared()))}
          >
            {tx("继续使用共享草稿")}
          </button>
        )}
        {legacy !== null && (
          <button
            disabled={busy}
            onClick={() => void perform(async () => navigator.clipboard.writeText(legacy))}
          >
            {tx("复制旧草稿原文")}
          </button>
        )}
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              setPreview(null);
              setCatalog(
                (await coreRequest(
                  "editor.drafts.recovery.list",
                )) as unknown as CoreEditorRecoveryCatalog,
              );
            })
          }
        >
          {tx("查看恢复副本")}
        </button>
      </div>
      {legacy !== null && (
        <details>
          <summary>{tx("旧草稿原文预览")}</summary>
          <pre>{legacy.slice(0, 4096)}</pre>
        </details>
      )}
      {catalog && (
        <section aria-label={tx("编辑器恢复副本")}>
          <p>{tx("预览后明确恢复所选副本。此操作只替换恢复数据，不写入文件。")}</p>
          <div className="editor-draft-recovery-actions">
            {catalog.backups.map((revision) => (
              <button
                key={revision}
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    setPreview(null);
                    setPreview(
                      (await coreRequest("editor.drafts.recovery.preview", {
                        revision,
                      })) as unknown as CoreEditorDraftSnapshot,
                    );
                  })
                }
              >
                {tx("预览副本")} {revision.slice(0, 12)}
              </button>
            ))}
          </div>
          {preview && (
            <>
              {preview.document.drafts.map((draft) => (
                <article key={JSON.stringify([draft.directory, draft.path])}>
                  <h2>
                    {draft.directory}/{draft.path}
                  </h2>
                  <pre>{draft.text.slice(0, 4096)}</pre>
                </article>
              ))}
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (catalog.currentRevision !== null && catalog.currentRevision !== undefined)
                      await coreRequest("editor.drafts.recovery.restore", {
                        revision: preview.revision,
                        expectedRevision: catalog.currentRevision,
                      });
                    else
                      await coreRequest("editor.drafts.recovery.restoreMissing", {
                        revision: preview.revision,
                        expectedMissing: true,
                      });
                    location.reload();
                  })
                }
              >
                {tx("恢复所选草稿副本")}
              </button>
            </>
          )}
        </section>
      )}
    </main>
  );
}
