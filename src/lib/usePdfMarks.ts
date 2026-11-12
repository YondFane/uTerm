import { useEffect, useRef, useState } from "react";
import { localizeMessage, tx } from "./i18n";
import { PdfMarkSession, type PdfMark, type PdfMarkTarget } from "./pdf-marks";

export function usePdfMarks(target: PdfMarkTarget, enabled: boolean) {
  const owner = useRef<PdfMarkSession | null>(null);
  const working = useRef<PdfMarkSession | null>(null);
  const [marks, setMarks] = useState<PdfMark[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setMarks([]);
    setReady(false);
    setPending(false);
    setError("");
    if (!enabled) {
      owner.current = null;
      setBusy(false);
      return;
    }
    const session = new PdfMarkSession(target);
    owner.current = session;
    working.current = session;
    setBusy(true);
    void session
      .load()
      .then((value) => {
        if (owner.current === session) {
          setMarks(value);
          setReady(true);
        }
      })
      .catch((reason) => {
        if (owner.current === session) setError(localizeMessage(String(reason)));
      })
      .finally(() => {
        if (working.current === session) working.current = null;
        if (owner.current === session) setBusy(false);
      });
    return () => {
      if (owner.current === session) owner.current = null;
    };
  }, [target.directory, target.path, target.version, enabled]);
  async function perform(action: (session: PdfMarkSession) => Promise<PdfMark[]>) {
    const session = owner.current;
    if (!session || working.current === session) return;
    working.current = session;
    setBusy(true);
    setError("");
    try {
      const result = action(session);
      setPending(session.hasPending);
      const value = await result;
      if (owner.current === session) {
        setMarks(value);
        setReady(true);
        setPending(false);
      }
    } catch (reason) {
      if (owner.current === session) {
        setMarks(session.committed());
        setPending(session.hasPending);
        setError(tx("高亮保存失败：{p0}", { p0: localizeMessage(String(reason)) }));
      }
    } finally {
      if (working.current === session) working.current = null;
      if (owner.current === session) setBusy(false);
    }
  }
  function discard() {
    const session = owner.current;
    if (!session || working.current === session) return;
    setMarks(session.discard());
    setPending(false);
    setError("");
  }
  return {
    marks,
    busy,
    ready,
    pending,
    error,
    discard,
    add: (mark: PdfMark) => perform((session) => session.add(mark)),
    remove: (id: string) => perform((session) => session.remove(id)),
    retry: () => perform((session) => session.retry()),
  };
}
