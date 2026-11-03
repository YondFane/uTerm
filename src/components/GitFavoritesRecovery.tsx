import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CoreGitFavoriteRecoveryCatalog,
  CoreGitFavoriteRecoverySnapshot,
} from "../lib/core-contract.generated";
import { coreRequest } from "../lib/shared-state";
import { copyContentText } from "../lib/content-host";
import { localizeMessage, tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";

export function GitFavoritesRecovery({
  onClose,
  onBusyChange,
}: {
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const alive = useRef(false);
  const catalogEpoch = useRef(0);
  const previewEpoch = useRef(0);
  const working = useRef(false);
  const callbacks = useRef({ onClose, onBusyChange });
  callbacks.current = { onClose, onBusyChange };
  const [catalog, setCatalog] = useState<CoreGitFavoriteRecoveryCatalog | null>(null);
  const [selection, setSelection] = useState("");
  const [preview, setPreview] = useState<{
    choice: string;
    text: string;
    snapshot?: CoreGitFavoriteRecoverySnapshot;
  } | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const loading = catalogLoading || previewLoading;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [copied, setCopied] = useState(false);
  async function load() {
    if (working.current) return;
    const request = ++catalogEpoch.current;
    previewEpoch.current++;
    setCatalogLoading(true);
    setCatalog(null);
    setSelection("");
    setError("");
    setPreview(null);
    setCopied(false);
    setCopyError("");
    try {
      const next = (await coreRequest(
        "git.favorites.recovery.list",
      )) as unknown as CoreGitFavoriteRecoveryCatalog;
      if (!alive.current || request !== catalogEpoch.current) return;
      setCatalog(next);
      setSelection(
        next.backups.length
          ? `backup:${next.backups[0]}`
          : next.sources.length
            ? `source:${next.sources[0]}`
            : "",
      );
    } catch (reason) {
      if (alive.current && request === catalogEpoch.current) setError(String(reason));
    } finally {
      if (alive.current && request === catalogEpoch.current) setCatalogLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    const previousFocus = document.activeElement;
    const element = dialog.current;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    cancelButton.current?.focus();
    void load();
    return () => {
      alive.current = false;
      catalogEpoch.current++;
      previewEpoch.current++;
      callbacks.current.onBusyChange(false);
      if (element?.open) element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  useEffect(() => {
    setPreview(null);
    setCopied(false);
    setCopyError("");
    if (!selection || !catalog) {
      setPreviewLoading(false);
      return;
    }
    const request = ++previewEpoch.current;
    setPreviewLoading(true);
    setError("");
    const [kind, revision] = selection.split(":");
    void coreRequest(
      kind === "backup" ? "git.favorites.recovery.preview" : "git.favorites.recovery.source",
      { revision },
    )
      .then((value) => {
        if (!alive.current || request !== previewEpoch.current) return;
        if (kind === "source") {
          if (typeof value !== "string") throw Error(tx("收藏恢复预览无效。"));
          setPreview({ choice: selection, text: value });
        } else {
          const snapshot = value as unknown as CoreGitFavoriteRecoverySnapshot;
          if (snapshot.revision !== revision || snapshot.document.schemaVersion !== 1)
            throw Error(tx("收藏恢复预览无效。"));
          const text =
            Object.entries(snapshot.document.repositories)
              .map(
                ([repository, entry]) =>
                  repository +
                  "\n" +
                  (entry.references.length
                    ? entry.references.map((reference) => "  " + reference).join("\n")
                    : tx("没有收藏")),
              )
              .join("\n\n") || tx("没有收藏");
          setPreview({ choice: selection, text, snapshot });
        }
      })
      .catch((reason) => {
        if (alive.current && request === previewEpoch.current) setError(String(reason));
      })
      .finally(() => {
        if (alive.current && request === previewEpoch.current) setPreviewLoading(false);
      });
    return () => {
      previewEpoch.current++;
    };
  }, [selection, catalog]);
  async function restore() {
    if (
      working.current ||
      loading ||
      !catalog ||
      !preview?.snapshot ||
      preview.choice !== selection
    )
      return;
    working.current = true;
    setBusy(true);
    callbacks.current.onBusyChange(true);
    setError("");
    try {
      const restored = (await coreRequest("git.favorites.recovery.restore", {
        revision: preview.snapshot.revision,
        expectedRevision: catalog.currentRevision,
        expectedMissing: catalog.currentRevision === null,
      })) as unknown as CoreGitFavoriteRecoverySnapshot;
      if (restored.revision !== preview.snapshot.revision) throw Error(tx("收藏恢复预览无效。"));
      if (alive.current) {
        window.dispatchEvent(new Event("uterm:git-favorites-restored"));
        callbacks.current.onClose();
      }
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally {
      working.current = false;
      callbacks.current.onBusyChange(false);
      if (alive.current) setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="git-favorite-recovery-dialog"
      aria-labelledby="git-favorite-recovery-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!working.current) callbacks.current.onClose();
      }}
    >
      <h2 id="git-favorite-recovery-title">{tx("恢复 Git 收藏")}</h2>
      <p>{tx("恢复会替换所有仓库的收藏，并保留损坏字节及恢复前副本。")}</p>
      <label>
        {tx("收藏恢复副本或原始来源")}
        <select
          disabled={busy || catalogLoading || !catalog}
          value={selection}
          onChange={(event) => {
            if (!working.current) setSelection(event.target.value);
          }}
        >
          {!selection && <option value="">{tx("没有校验通过的收藏恢复数据")}</option>}
          {catalog?.backups.map((revision) => (
            <option value={`backup:${revision}`} key={`backup:${revision}`}>
              {tx("收藏副本")} · {revision.slice(0, 12)}
            </option>
          ))}
          {catalog?.sources.map((revision) => (
            <option value={`source:${revision}`} key={`source:${revision}`}>
              {tx("原始来源")} · {revision.slice(0, 12)}
            </option>
          ))}
        </select>
      </label>
      <textarea
        readOnly
        spellCheck={false}
        aria-label={tx("收藏恢复预览")}
        value={loading ? tx("正在读取收藏恢复数据…") : (preview?.text.slice(0, 20000) ?? "")}
      />
      {(preview?.text.length ?? 0) > 20000 && <p>{tx("预览已截断，复制会保留全部内容。")}</p>}
      {preview && !preview.snapshot && (
        <p>{tx("原始来源只能预览和复制，不会直接替换共享收藏。")}</p>
      )}
      {(error || copyError) && <p role="alert">{localizeMessage(error || copyError)}</p>}
      {copied && <p role="status">{tx("已复制完整预览。")}</p>}
      <div className="git-favorite-recovery-actions">
        <button
          ref={cancelButton}
          autoFocus
          disabled={busy}
          onClick={() => {
            if (!working.current) callbacks.current.onClose();
          }}
        >
          {tx("取消")}
        </button>
        <button disabled={busy || catalogLoading} onClick={() => void load()}>
          {tx("重新读取恢复副本")}
        </button>
        <button
          disabled={busy || loading || !preview || preview.choice !== selection}
          onClick={() => {
            const request = previewEpoch.current;
            setCopyError("");
            setCopied(false);
            void copyContentText(preview?.text ?? "")
              .then(() => {
                if (alive.current && request === previewEpoch.current) setCopied(true);
              })
              .catch((reason) => {
                if (alive.current && request === previewEpoch.current) setCopyError(String(reason));
              });
          }}
        >
          {tx("复制完整预览")}
        </button>
        <button
          disabled={busy || loading || !preview?.snapshot || preview.choice !== selection}
          onClick={() => void restore()}
        >
          {tx("恢复所有仓库收藏")}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
