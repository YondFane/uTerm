import { useEffect, useState } from "react";
import { localizeMessage, tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import type { useFileDocument } from "../lib/useFileDocument";

export function DeferredFileEditor({ editor }: { editor: ReturnType<typeof useFileDocument> }) {
  useUiLanguage();
  const [module, setModule] = useState<typeof import("./FileEditor") | null>(null);
  const [error, setError] = useState("");
  const needed = !!editor.document || !!editor.pending;
  useEffect(() => {
    if (!needed || module) return;
    let disposed = false;
    setError("");
    // Load editor, Markdown and syntax dependencies only when a file needs them.
    // 仅在文件需要时加载编辑器、Markdown 和语法依赖。
    void import("./FileEditor").then(
      (loaded) => {
        if (!disposed) setModule(loaded);
      },
      (reason) => {
        if (!disposed) setError(String(reason));
      },
    );
    return () => {
      disposed = true;
    };
  }, [needed, module]);
  if (!needed) return null;
  if (error)
    return (
      <div role="alert">
        {localizeMessage(error)}
        <button onClick={() => void editor.close().catch((reason) => setError(String(reason)))}>
          {tx("关闭")}
        </button>
      </div>
    );
  if (!module) return <p role="status">{tx("正在打开文件…")}</p>;
  return (
    <>
      <module.FileEditor editor={editor} />
      <module.UnsavedDialog editor={editor} />
    </>
  );
}
