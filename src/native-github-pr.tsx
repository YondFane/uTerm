import { useEffect, useRef, useState } from "react";
import { PullRequestDialog, type PullRequestDraft } from "./components/PullRequestDialog";
import { contentInvoke, listenContent } from "./lib/content-host";
import { localizeMessage, tx } from "./lib/i18n";
import { useSettings } from "./lib/SettingsContext";
import { useUiLanguage } from "./lib/useUiLanguage";
import { useNativeModalLayout } from "./lib/useNativeModalLayout";

function Startup({
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
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="name-dialog pr-dialog"
      aria-label={tx("新建 Pull Request")}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          retry();
        }}
      >
        <h2>{tx("新建 Pull Request")}</h2>
        {error ? (
          <p role="alert">{localizeMessage(error)}</p>
        ) : (
          <p role="status">{tx("加载中…")}</p>
        )}
        <div>
          <button type="button" onClick={close}>
            {tx("取消")}
          </button>
          <button disabled={loading}>{tx("重试")}</button>
        </div>
      </form>
    </dialog>
  );
}

export function NativeGitHubPR() {
  useUiLanguage();
  const settings = useSettings();
  const [repository, setRepository] = useState("");
  const [form, setForm] = useState<PullRequestDraft | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const reading = useRef(false),
    writing = useRef(false);
  useNativeModalLayout(".pr-dialog", "github_pr_layout", !!form, setError);
  async function load() {
    if (reading.current) return;
    reading.current = true;
    setLoading(true);
    try {
      const context = await contentInvoke<{
        repository: string;
        title: string;
        base: string;
        head: string;
      }>("github_pr_context");
      if (
        !context ||
        [context.repository, context.title, context.base, context.head].some(
          (v) => typeof v !== "string",
        ) ||
        !context.repository
      )
        throw Error("INVALID_ARGUMENT: Invalid pull request context");
      setRepository(context.repository);
      setForm({
        title: context.title,
        base: context.base,
        head: context.head,
        body: tx("## 摘要\n\n\n## 验证\n\n\nRelease Notes:\n\n"),
        draft: true,
      });
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      reading.current = false;
      setLoading(false);
    }
  }
  function close() {
    if (writing.current || frozen) return;
    void contentInvoke("github_pr_close").catch((reason) => setError(String(reason)));
  }
  async function submit() {
    if (!form || writing.current || frozen) return;
    writing.current = true;
    setPosting(true);
    setError("");
    try {
      await contentInvoke("github_pr_submit", { ...form });
    } catch (reason) {
      setError(tx("{p0}；请先刷新列表确认是否已创建，再决定是否重试。", { p0: String(reason) }));
    } finally {
      writing.current = false;
      setPosting(false);
    }
  }
  useEffect(() => {
    void load();
    let disposed = false;
    const subscriptions = [
      listenContent("github-pr-frozen", (value) => setFrozen(value === true)),
      listenContent("github-pr-settings-changed", () => {
        void settings.reload().catch((reason) => {
          if (!disposed) setError(String(reason));
        });
      }),
    ];
    for (const subscription of subscriptions)
      void subscription.catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
      for (const subscription of subscriptions)
        void subscription.then(
          (stop) => stop(),
          () => {},
        );
    };
  }, []);
  return (
    <main className="native-content native-github-pr">
      {form ? (
        <PullRequestDialog
          repository={repository}
          form={form}
          posting={posting || frozen}
          formError={error}
          change={setForm}
          submit={() => void submit()}
          close={close}
        />
      ) : (
        <Startup error={error} loading={loading} retry={() => void load()} close={close} />
      )}
    </main>
  );
}
