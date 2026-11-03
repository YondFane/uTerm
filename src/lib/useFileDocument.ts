import { tx } from "./i18n.ts";
import { useEffect, useRef, useState } from "react";
import { fileInvoke } from "./file-target";
import { createContentScope, isContentHost } from "./content-host";
import type { ContentScope } from "./content-transport";
import type { JSONValue } from "./core-contract.generated";
import { EditorDraftQueue } from "./editor-drafts";
import type { EditorRecoveryOptions } from "./editor-drafts";
import {
  fileBytes,
  isDirty,
  savedVersion,
  draftKey,
  readDraft,
  DocumentSaveQueue,
} from "./file-document";
import type { FileData, OpenFile } from "./file-document";
export function useFileDocument(
  fileTabLimit = 10,
  readOnly = false,
  sharedRecovery?: string | EditorRecoveryOptions,
) {
  const recoveryDirectory =
    typeof sharedRecovery === "string" ? sharedRecovery : sharedRecovery?.directory;
  const transport = useRef<ContentScope | null>(null);
  const recovery = useRef<EditorDraftQueue | null>(null);
  function currentTransport() {
    return (transport.current ??= createContentScope());
  }
  function invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return currentTransport().call(method, params);
  }
  function currentRecovery() {
    return sharedRecovery === undefined
      ? null
      : (recovery.current ??= new EditorDraftQueue(invoke, recoveryDirectory));
  }
  useEffect(() => {
    const scope = currentTransport();
    return () => {
      if (transport.current === scope) transport.current = null;
      recovery.current?.close();
      recovery.current = null;
      scope.close();
    };
  }, []);
  const [document, render] = useState<OpenFile | null>(null);
  const current = useRef<OpenFile | null>(null);
  const [documents, renderDocuments] = useState<OpenFile[]>([]);
  const retained = useRef<OpenFile[]>([]);
  function setDocuments(values: OpenFile[]) {
    retained.current = values;
    renderDocuments(values);
  }
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingAction = useRef<(() => Promise<void>) | null>(null);
  const transition = useRef(false);
  const quitToken = useRef<string | null>(null);
  const writing = useRef(new DocumentSaveQueue());
  const sequence = useRef(0);
  const discarding = useRef(false);
  function setDocument(value: OpenFile | null) {
    const previous = current.current;
    current.current = value;
    render(value);
    if (value) {
      const index = retained.current.findIndex(
        (item) => item.directory === value.directory && item.path === value.path,
      );
      setDocuments(
        index < 0
          ? [...retained.current, value]
          : retained.current.map((item, position) => (position === index ? value : item)),
      );
    }
    const queue = currentRecovery();
    if (queue) {
      let saved: Promise<void> | undefined;
      if (!discarding.current && value?.kind === "text" && !value.readonly) {
        if (isDirty(value)) {
          const { directory, path, kind, text, saved: original, version, line_ending, bom } = value;
          saved = queue.put({
            directory,
            path,
            kind,
            text,
            saved: original,
            version,
            line_ending,
            bom,
          });
        } else if (previous?.id === value.id && isDirty(previous))
          saved = queue.remove(value.directory, value.path);
      }
      void saved?.catch((reason) => {
        if (recovery.current === queue)
          setError(tx("无法保存恢复草稿，请手动保存文件：{p0}", { p0: String(reason) }));
      });
      return;
    }
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
      let writingFile = false;
      setSaving(true);
      try {
        await currentRecovery()?.retry();
        if (!snapshot || !isDirty(snapshot) || snapshot.readonly) {
          if (currentRecovery()) {
            setError("");
            setConflict(false);
          }
          return true;
        }
        writingFile = true;
        const version = await fileInvoke<string>(
          "file_save",
          {
            directory: snapshot.directory,
            path: snapshot.path,
            text: fileBytes(snapshot),
            expected: snapshot.version,
            force,
          },
          invoke,
        );
        writingFile = false;
        if (current.current?.id === snapshot.id) {
          setDocument({ ...savedVersion(current.current, snapshot, version), notice: null });
          setRecovered(false);
          await currentRecovery()?.flush();
          setError("");
          setConflict(false);
        }
        return true;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message.replace(/^CONFLICT:/, ""));
        setConflict(writingFile && message.startsWith("CONFLICT:"));
        return false;
      } finally {
        setSaving(false);
      }
    });
  }

  async function flush(): Promise<boolean> {
    if (!(await save())) return false;
    if (isDirty(current.current) && !(await save())) return false;
    return !isDirty(current.current) || !!(currentRecovery() && current.current?.readonly);
  }
  async function request(action: () => Promise<void>) {
    if (transition.current || pendingAction.current) return;
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
  async function trimTabs() {
    const excess = new Set<number>();
    const counts = new Map<string, number>();
    for (const file of [...retained.current].reverse()) {
      const count = (counts.get(file.directory) ?? 0) + 1;
      counts.set(file.directory, count);
      if (count > fileTabLimit) excess.add(file.id);
    }
    if (!excess.size) return;
    if (current.current && excess.has(current.current.id)) {
      await invoke("editor_guard", { active: false });
      setDocument(null);
    }
    setDocuments(retained.current.filter((file) => !excess.has(file.id)));
  }
  useEffect(() => {
    if (transitioning || pending) return;
    const counts = new Map<string, number>();
    if (
      documents.some((file) => {
        const count = (counts.get(file.directory) ?? 0) + 1;
        counts.set(file.directory, count);
        return count > fileTabLimit;
      })
    )
      void request(trimTabs);
  }, [fileTabLimit, documents, transitioning, pending]);
  async function open(directory: string, path: string, line?: number) {
    if (transition.current || pendingAction.current) return;
    const existing = current.current;
    if (existing?.directory === directory && existing.path === path) {
      setDocument({ ...existing, line, jump: existing.jump + 1 });
      return;
    }
    await request(async () => {
      const cached = retained.current.find(
        (item) => item.directory === directory && item.path === path,
      );
      if (cached) {
        await invoke("editor_guard", { active: cached.kind === "text" && !cached.readonly });
        setDocument({ ...cached, line, jump: cached.jump + 1 });
        setRecovered(false);
        setError("");
        setConflict(false);
        return;
      }
      const draft = await currentRecovery()?.load(directory, path);
      let data: FileData;
      try {
        data = await fileInvoke<FileData>("file_read", { directory, path }, invoke);
      } catch (reason) {
        if (!draft) throw reason;
        data = {
          ...draft.draft,
          kind: "text",
          readonly: true,
          notice: tx("无法读取文件，显示保留的恢复草稿：{p0}", { p0: String(reason) }),
        };
      }
      if (readOnly) data.readonly = true;
      const restored = draft ? readDraft(JSON.stringify(draft.draft)) : null;
      await invoke("editor_guard", { active: data.kind === "text" && !data.readonly });
      setDocument({
        ...data,
        id: ++sequence.current,
        directory,
        path,
        saved: data.text,
        line,
        jump: 0,
        ...(restored
          ? {
              ...restored,
              id: sequence.current,
              line,
              readonly: data.readonly,
              notice: data.notice ?? restored.notice,
            }
          : {}),
      });
      await trimTabs();
      setRecovered(!!draft);
      setError("");
      setConflict(false);
    });
  }
  async function hide(after?: () => void | Promise<void>) {
    await request(async () => {
      await invoke("editor_guard", { active: false });
      setDocument(null);
      setRecovered(false);
      setError("");
      setConflict(false);
      await after?.();
    });
  }
  async function close(after?: () => void | Promise<void>, id = current.current?.id) {
    if (transition.current || pendingAction.current) return;
    if (id === undefined) {
      await hide(after);
      return;
    }
    if (id !== current.current?.id) {
      setDocuments(retained.current.filter((item) => item.id !== id));
      return;
    }
    await hide(async () => {
      setDocuments(retained.current.filter((item) => item.id !== id));
      await after?.();
    });
  }
  async function closeDirectory(directory: string, after?: () => void | Promise<void>) {
    await hide(async () => {
      setDocuments(retained.current.filter((item) => item.directory !== directory));
      await after?.();
    });
  }
  async function reload() {
    const snapshot = current.current;
    if (!snapshot) return;
    const action = async () => {
      const data = await fileInvoke<FileData>(
        "file_read",
        {
          directory: snapshot.directory,
          path: snapshot.path,
        },
        invoke,
      );
      if (readOnly) data.readonly = true;
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
      const value = current.current;
      if (value && currentRecovery()) {
        await currentRecovery()!.discard(value.directory, value.path);
        discarding.current = true;
      }
      await action();
      if (value && isDirty(value)) {
        setDocuments(
          retained.current.map((item) =>
            item.id === value.id ? { ...item, text: item.saved } : item,
          ),
        );
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      discarding.current = false;
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
    if (currentRecovery()) {
      await currentRecovery()!.flush();
      await invoke("editor_exit");
      return;
    }
    const draft = localStorage.getItem(draftKey);
    localStorage.removeItem(draftKey);
    try {
      await invoke("editor_exit");
    } catch (reason) {
      if (draft) localStorage.setItem(draftKey, draft);
      throw reason;
    }
  }
  function resumeQuit(payload: JSONValue) {
    if (typeof payload !== "string" || quitToken.current !== payload) return;
    quitToken.current = null;
    transition.current = false;
    setTransitioning(false);
  }
  async function prepareQuit(payload: JSONValue) {
    if (typeof payload !== "string" || !payload || payload.length > 128) return;
    let ready = false;
    try {
      if (!transition.current && !pendingAction.current) {
        quitToken.current = payload;
        transition.current = true;
        setTransitioning(true);
        ready = (await flush()) && quitToken.current === payload;
      } else setError(tx("文件操作尚未完成，请稍后重试退出。"));
      await invoke("editor_prepare_result", { token: payload, ready });
    } catch (reason) {
      ready = false;
      setError(String(reason));
    } finally {
      if (!ready) resumeQuit(payload);
    }
  }
  const latest = useRef({ request, exit, prepareQuit, resumeQuit });
  latest.current = { request, exit, prepareQuit, resumeQuit };
  useEffect(() => {
    if (!isContentHost()) return;
    let disposed = false;
    const unlisten: (() => void)[] = [];
    for (const [event, receive] of [
      ["editor-close-request", () => void latest.current.request(latest.current.exit)],
      ["editor-prepare-quit", (payload: JSONValue) => void latest.current.prepareQuit(payload)],
      ["editor-resume", (payload: JSONValue) => latest.current.resumeQuit(payload)],
    ] as const)
      void currentTransport()
        .subscribe(event, receive)
        .then((stop) => {
          if (disposed) stop();
          else unlisten.push(stop);
        })
        .catch((reason) => setError(String(reason)));
    return () => {
      disposed = true;
      for (const stop of unlisten) stop();
    };
  }, []);
  useEffect(() => {
    if (!isContentHost() || readOnly || sharedRecovery !== undefined) return;
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
    const initial = typeof sharedRecovery === "object" ? sharedRecovery.initialFile : undefined;
    if (!isContentHost() || readOnly || !initial) return;
    let disposed = false;
    const queue = currentRecovery()!;
    void queue.initialize().then(
      () => {
        if (!disposed) void open(initial.directory, initial.path);
      },
      (reason) => {
        if (!disposed) setError(String(reason));
      },
    );
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
    await currentRecovery()?.flush();
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
    documents,
    error,
    conflict,
    saving,
    transitioning,
    pending,
    open,
    close,
    hide,
    closeDirectory,
    save,
    reload,
    discard,
    cancel,
    change,
    dismissError: () => setError(""),
  };
}
