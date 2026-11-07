import { useEffect, useState } from "react";
import { GitHubPanel, type GitHubItem } from "./components/GitHubPanel";
import { contentInvoke, listenContent } from "./lib/content-host";
import { localizeMessage } from "./lib/i18n";
import { useSettings } from "./lib/SettingsContext";

export function NativeGitHub({ directory }: { directory: string }) {
  const settings = useSettings();
  const [context, setContext] = useState({ canAssociate: false, canInsert: false });
  const [frozen, setFrozen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const refresh = async () => {
      try {
        const current = await contentInvoke<typeof context>("github_context");
        if (!disposed) {
          setContext(current);
          setError("");
        }
      } catch (reason) {
        if (!disposed) setError(String(reason));
      }
    };
    void refresh();
    for (const [kind, receive] of [
      ["github-frozen", (value: unknown) => setFrozen(value === true)],
      ["github-context-changed", () => void refresh()],
      [
        "github-settings-changed",
        () => void settings.reload().catch((reason) => setError(String(reason))),
      ],
    ] as const) {
      void listenContent(kind, receive)
        .then((stop) => {
          if (disposed) stop();
          else stops.push(stop);
        })
        .catch((reason) => {
          if (!disposed) setError(String(reason));
        });
    }
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, []);
  async function action(kind: string, item: Pick<GitHubItem, "url" | "title">) {
    await contentInvoke("github_session_action", {
      kind,
      item: { url: item.url, title: item.title },
    });
    setContext(await contentInvoke<typeof context>("github_context"));
  }
  return (
    <main className="native-content native-github">
      {error && <p role="alert">{localizeMessage(error)}</p>}
      <fieldset disabled={frozen}>
        <GitHubPanel
          directory={directory}
          resizeHandle={null}
          headerActions={
            <>
              <strong>GitHub</strong>
              <span title={directory}>{directory}</span>
            </>
          }
          port={contentInvoke}
          canAssociate={context.canAssociate}
          canInsert={context.canInsert}
          associate={(item) => action("associate", item)}
          insert={(url) => action("insert", { url, title: "" })}
          createSession={(item) => action("create", item)}
          guardForm={async (active) => {
            await contentInvoke("github_form_guard", { active });
          }}
        />
      </fieldset>
    </main>
  );
}
