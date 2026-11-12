import { useEffect, useRef } from "react";
import { localizeMessage, tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";

export interface PullRequestDraft {
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
}
export function PullRequestDialog({
  repository,
  form,
  posting,
  formError,
  change,
  submit,
  close,
}: {
  repository: string;
  form: PullRequestDraft | null;
  posting: boolean;
  formError: string;
  change: (form: PullRequestDraft) => void;
  submit: () => void;
  close: () => void;
}) {
  useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (form) dialog.current?.showModal();
    else dialog.current?.close();
  }, [!!form]);
  return (
    <dialog
      ref={dialog}
      className="name-dialog pr-dialog"
      aria-label={tx("新建 Pull Request")}
      onCancel={(event) => {
        event.preventDefault();
        if (!posting) close();
      }}
    >
      {form && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!posting) submit();
          }}
        >
          <h2>{tx("新建 Pull Request")}</h2>
          <p>{tx("{p0} · 分支需事先推送到 GitHub。", { p0: repository })}</p>
          {formError && <p role="alert">{localizeMessage(formError)}</p>}
          {(["title", "base", "head"] as const).map((key) => (
            <label key={key}>
              {{ title: tx("标题"), base: tx("目标分支"), head: tx("来源分支") }[key]}
              <input
                required
                disabled={posting}
                value={form[key]}
                onChange={(e) => change({ ...form, [key]: e.target.value })}
              />
            </label>
          ))}
          <label>
            {tx("说明")}
            <textarea
              disabled={posting}
              rows={9}
              value={form.body}
              onChange={(e) => change({ ...form, body: e.target.value })}
            />
          </label>
          <label className="pr-draft-choice">
            <input
              type="checkbox"
              disabled={posting}
              checked={form.draft}
              onChange={(e) => change({ ...form, draft: e.target.checked })}
            />
            {tx("创建草稿")}
          </label>
          <div>
            <button type="button" disabled={posting} onClick={close}>
              {tx("取消")}
            </button>
            <button disabled={posting}>{posting ? tx("正在创建…") : tx("在 GitHub 创建")}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
