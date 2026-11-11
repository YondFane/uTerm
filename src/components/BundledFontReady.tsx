import { useEffect, useState, type ReactNode } from "react";
import { tx } from "../lib/i18n";

export function BundledFontReady({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void Promise.resolve()
      .then(() => document.fonts.load('14px "Cascadia Code"'))
      .then(
        (faces) => {
          if (active) {
            setReady(faces.length > 0);
            setFailed(faces.length === 0);
          }
        },
        () => {
          if (active) setFailed(true);
        },
      );
    return () => {
      active = false;
    };
  }, [attempt]);
  if (ready) return children;
  return (
    <main className="native-content-startup-error">
      {failed ? (
        <>
          <p role="alert">{tx("无法加载内置终端字体，请重试或重新安装应用。")}</p>
          <button onClick={() => setAttempt((value) => value + 1)}>{tx("重试")}</button>
        </>
      ) : (
        <p role="status">{tx("加载中…")}</p>
      )}
    </main>
  );
}
