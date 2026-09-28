import { tx } from "./i18n.ts";
import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  fileBytes,
  isDirty,
  savedVersion,
  draftKey,
  readDraft,
  DocumentSaveQueue,
} from "./file-document";
import type { FileData, OpenFile } from "./file-document";
export function useFileDocument() {
  const [document, render] = useState<OpenFile | null>(null);
  const current = useRef<OpenFile | null>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingAction = useRef<(() => Promise<void>) | null>(null);
  const transition = useRef(false);
  const writing = useRef(new DocumentSaveQueue());
  const sequence = useRef(0);
  function setDocument(value: OpenFile | null) {
    current.current = value;
    render(value);
    try {
      if (isDirty(value)) localStorage.setItem(draftKey, JSON.stringify(value));
      else localStorage.removeItem(draftKey);
    } catch (reason) {
      setError(tx("无法保存恢复草稿，请手动保存文件：{p0}", { p0: String(reason) }));
    }
  }
  async function save(force = false): Promise<boolean> {
    return writing.current.run(async () => {
      const snapshot = current.current;
      if (!snapshot || !isDirty(snapshot) || snapshot.readonly) return true;
      setSaving(true);
      try {
        const version = await invoke<string>("file_save", {
          directory: snapshot.directory,
          path: snapshot.path,
          text: fileBytes(snapshot),
          expected: snapshot.version,
          force,
        });
        if (current.current?.id === snapshot.id) {
          setDocument({ ...savedVersion(current.current, snapshot, version), notice: null });
          setRecovered(false);
          setError("");
          setConflict(false);
        }
        return true;
      } catch (reason) {
        setError(String(reason).replace(/^CONFLICT:/, ""));
        setConflict(String(reason).startsWith("CONFLICT:"));
        return false;
      } finally {
        setSaving(false);
      }
    });
  }

  async function flush(): Promise<boolean> {
    if (!(await save())) return false;
    if (isDirty(current.current) && !(await save())) return false;
    return !isDirty(current.current);
  }
  async function request(action: () => Promise<void>) {
    if (transition.current) return;
    transition.current = true;
    setTransitioning(true);
    try {
      if (!(await flush())) {
        pendingAction.current = action;
        setPending(true);
        return;
      }
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      transition.current = false;
      setTransitioning(false);
    }
  }
  async function open(directory: string, path: string, line?: number) {
    const existing = current.current;
    if (existing?.directory === directory && existing.path === path) {
      setDocument({ ...existing, line, jump: existing.jump + 1 });
      return;
    }
    await request(async () => {
      const data = await invoke<FileData>("file_read", { directory, path });
      await invoke("editor_guard", { active: data.kind === "text" && !data.readonly });
      setDocument({
        ...data,
        id: ++sequence.current,
        directory,
        path,
        saved: data.text,
        line,
        jump: 0,
      });
      setRecovered(false);
      setError("");
      setConflict(false);
    });
  }
  async function close(after?: () => void | Promise<void>) {
    await request(async () => {
      await invoke("editor_guard", { active: false });
      setDocument(null);
      setRecovered(false);
      setError("");
      setConflict(false);
      await after?.();
    });
  }
  async function reload() {
    const snapshot = current.current;
    if (!snapshot) return;
    const action = async () => {
      const data = await invoke<FileData>("file_read", {
        directory: snapshot.directory,
        path: snapshot.path,
      });
      await invoke("editor_guard", { active: data.kind === "text" && !data.readonly });
      setDocument({ ...snapshot, ...data, id: ++sequence.current, saved: data.text });
      setRecovered(false);
      setError("");
      setConflict(false);
    };
    if (isDirty(snapshot)) {
      pendingAction.current = action;
      setPending(true);
    } else await request(action);
  }
  async function discard() {
    const action = pendingAction.current;
    pendingAction.current = null;
    setPending(false);
    if (!action || transition.current) return;
    transition.current = true;
    setTransitioning(true);
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      transition.current = false;
      setTransitioning(false);
    }
  }
  function cancel() {
    pendingAction.current = null;
    setPending(false);
  }
  function change(text: string) {
    if (current.current && !transition.current) setDocument({ ...current.current, text });
  }
  async function exit() {
    const draft = localStorage.getItem(draftKey);
    localStorage.removeItem(draftKey);
    try {
      await invoke("editor_exit");
    } catch (reason) {
      if (draft) localStorage.setItem(draftKey, draft);
      throw reason;
    }
  }
  const latest = useRef({ request, exit });
  latest.current = { request, exit };
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("editor-close-request", () => void latest.current.request(latest.current.exit))
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((reason) => setError(String(reason)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    transition.current = true;
    setTransitioning(true);
    void (async () => {
      try {
        const raw = localStorage.getItem(draftKey);
        if (!raw) return;
        let restored: OpenFile;
        try {
          restored = readDraft(raw);
        } catch (reason) {
          localStorage.setItem(`${draftKey}.invalid`, raw);
          throw reason;
        }
        await invoke("editor_guard", { active: true });
        if (!disposed) {
          restored.id = ++sequence.current;
          setDocument(restored);
          setRecovered(true);
        }
      } catch (reason) {
        if (!disposed) setError(String(reason));
      } finally {
        if (!disposed) {
          transition.current = false;
          setTransitioning(false);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    // Recovered drafts require an explicit save before autosave can overwrite the disk.
    // 恢复的草稿必须先显式保存，才允许自动保存覆盖磁盘文件。
    if (!isDirty(document) || error || recovered || pending || transitioning) return;
    const timer = setTimeout(() => void save(), 750);
    return () => clearTimeout(timer);
  }, [document?.text, document?.saved, error, recovered, pending, transitioning]);
  async function prepareUpdate() {
    if (isDirty(current.current)) throw new Error(tx("请先保存或放弃文件修改，再安装更新。"));
    await invoke("editor_guard", { active: false });
  }
  async function restoreUpdateGuard() {
    const value = current.current;
    await invoke("editor_guard", { active: !!value && value.kind === "text" && !value.readonly });
  }
  return {
    prepareUpdate,
    restoreUpdateGuard,
    document,
    error,
    conflict,
    saving,
    transitioning,
    pending,
    open,
    close,
    save,
    reload,
    discard,
    cancel,
    change,
    dismissError: () => setError(""),
  };
}
