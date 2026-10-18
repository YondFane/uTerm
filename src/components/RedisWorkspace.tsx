import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { RedisBinaryPreview } from "./RedisBinaryPreview";
import { ToolbarIcon } from "./SidebarIcon";
import {
  redisArguments,
  redisDisplay,
  redisEncode,
  redisError,
  redisGuard,
  redisStatus,
  redisValidScore,
  type RedisCollectionChange,
  type RedisConfig,
  type RedisDocument,
  type RedisKey,
  type RedisBlob,
} from "../lib/redis";
import type { OpenFile } from "../lib/file-document";

interface Draft {
  key: RedisBlob;
  field?: RedisBlob;
  text: string;
  saved: string;
  version: string | null;
  fresh: boolean;
  id: number;
  separator: string;
  collection?: RedisCollectionChange;
  savedScore?: string;
}
let nextDocument = 1;
export function RedisWorkspace({
  config,
  active,
  password: initialPassword,
  consumed,
}: {
  config: RedisConfig;
  active: boolean;
  password: string;
  consumed: () => void;
}) {
  useUiLanguage();
  const [handle, setHandle] = useState<string | null>(null);
  const currentHandle = useRef<string | null>(null);
  const [password, setPassword] = useState(initialPassword);
  useEffect(() => {
    if (initialPassword) setPassword(initialPassword);
  }, [initialPassword]);
  const [db, setDb] = useState(config.db);
  const [nextDb, setNextDb] = useState(config.db);
  const [writable, setWritable] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [keys, setKeys] = useState<RedisKey[]>([]);
  const [cursor, setCursor] = useState("0");
  const [scanned, setScanned] = useState(false);
  const [filter, setFilter] = useState("*");
  const [scanPattern, setScanPattern] = useState("*");
  const [grouped, setGrouped] = useState(true);
  const [selection, setSelection] = useState<RedisKey | null>(null);
  const [data, setData] = useState<RedisDocument | null>(null);
  const [offset, setOffset] = useState(0);
  const [fieldData, setFieldData] = useState<{ field: RedisBlob; document: RedisDocument } | null>(
    null,
  );
  const [emptyBatch, setEmptyBatch] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [browserWidth, setBrowserWidth] = useState(280);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const workspace = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const browser = useRef<HTMLElement>(null);
  const browserToggle = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const dialogOrigin = useRef<HTMLElement | null>(null);
  const restoreActionFocus = useRef(false);
  const fieldOrigin = useRef<HTMLButtonElement | null>(null);
  const restoreFieldFocus = useRef(false);
  const [memberPattern, setMemberPattern] = useState("*");
  const [draft, setDraft] = useState<Draft | null>(null);
  const dirty =
    !!draft &&
    (draft.fresh || draft.text !== draft.saved || draft.collection?.score !== draft.savedScore);
  const dirtyNow = useRef(dirty);
  dirtyNow.current = dirty;
  const [pending, setPending] = useState<(() => void) | null>(null);
  const guardDialog = useRef<HTMLDialogElement>(null);
  const [mutation, setMutation] = useState<{ action: string; argument: string } | null>(null);
  const mutationDialog = useRef<HTMLDialogElement>(null);
  const [newKey, setNewKey] = useState("");
  const [newField, setNewField] = useState("");
  const [newKind, setNewKind] = useState("string");
  const [memberTarget, setMemberTarget] = useState<RedisCollectionChange | null>(null);
  const [rename, setRename] = useState("");
  const [ttl, setTtl] = useState("3600");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [command, setCommand] = useState("PING");
  const [result, setResult] = useState("");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [editorModule, setEditorModule] = useState<typeof import("./FileEditor") | null>(null);
  const controls = useRef<EditorView | null>(null);
  useEffect(() => {
    if (!draft || editorModule) return;
    let disposed = false;
    void import("./FileEditor").then(
      (module) => {
        if (!disposed) setEditorModule(module);
      },
      () => {
        if (!disposed) setError(tx("编辑器加载失败，请重新打开工作台。"));
      },
    );
    return () => {
      disposed = true;
    };
  }, [!!draft, editorModule]);
  useEffect(() => {
    redisStatus(config.id, { connected: !!handle, dirty, opening: busy });
    void redisGuard(config.id, dirty).catch((error) => setError(redisError(error)));
  }, [config.id, handle, dirty, busy]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (currentHandle.current)
        void invoke("redis_disconnect", { handle: currentHandle.current }).catch(() => {});
    };
  }, []);
  function before(action: () => void) {
    if (working.current) return;
    if (dirtyNow.current) setPending(() => action);
    else action();
  }
  useEffect(() => {
    if (!workspace.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 720));
    observer.observe(workspace.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (browserOpen && narrow) searchInput.current?.focus();
  }, [browserOpen, narrow]);
  useEffect(() => {
    const dismiss = (event: PointerEvent | KeyboardEvent) => {
      workspace.current
        ?.querySelectorAll<HTMLDetailsElement>(".redis-menu[open]")
        .forEach((menu) => {
          if (
            (event.type === "keydown" && (event as KeyboardEvent).key === "Escape") ||
            (event.type === "pointerdown" && !menu.contains(event.target as Node))
          ) {
            menu.open = false;
            if (event.type === "keydown") menu.querySelector("summary")?.focus();
          }
        });
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, []);
  useEffect(() => {
    if (pending) guardDialog.current?.showModal();
    else guardDialog.current?.close();
  }, [pending]);
  useEffect(() => {
    if (mutation) mutationDialog.current?.showModal();
    else mutationDialog.current?.close();
  }, [mutation]);
  useEffect(() => {
    if (!mutation && !busy && restoreActionFocus.current) {
      (dialogOrigin.current?.isConnected
        ? dialogOrigin.current
        : (workspace.current?.querySelector<HTMLButtonElement>(".redis-member-search button") ??
          (narrow ? browserToggle.current : searchInput.current))
      )?.focus();
      restoreActionFocus.current = false;
    }
  }, [mutation, busy, narrow]);
  useEffect(() => {
    if (!fieldData && !draft?.collection && !busy && restoreFieldFocus.current) {
      (fieldOrigin.current?.isConnected
        ? fieldOrigin.current
        : workspace.current?.querySelector<HTMLButtonElement>(".redis-member-search button")
      )?.focus();
      restoreFieldFocus.current = false;
    }
  }, [!!fieldData, !!draft?.collection, busy]);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<string | null>("redis-close-request", (event) => {
      if (event.payload === config.id)
        setPending(() => () => {
          void invoke("redis_exit").catch((error) => setError(redisError(error)));
        });
    })
      .then((value) => {
        if (disposed) value();
        else stop = value;
      })
      .catch((error) => setError(redisError(error)));
    return () => {
      disposed = true;
      stop?.();
    };
  }, [config.id]);
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      return await action();
    } catch (error) {
      if (mounted.current) setError(redisError(error));
      return undefined;
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function request<T>(request: Record<string, unknown>, id = currentHandle.current) {
    if (!id) return Promise.reject("REDIS_RECONNECT");
    return invoke<T>("redis_request", { handle: id, request });
  }
  function resetData() {
    setKeys([]);
    setCursor("0");
    setScanned(false);
    setSelection(null);
    setData(null);
    setDraft(null);
    setOffset(0);
    setFieldData(null);
    setEmptyBatch(false);
  }
  async function scan(restart: boolean, id = currentHandle.current) {
    const pattern = restart ? filter : scanPattern;
    const response = await request<{ cursor: string; entries: RedisKey[] }>(
      { op: "scan", cursor: restart ? "0" : cursor, pattern },
      id,
    );
    setKeys((previous) => {
      const entries = new Map((restart ? [] : previous).map((item) => [item.key.data, item]));
      for (const item of response.entries) entries.set(item.key.data, item);
      return [...entries.values()].slice(0, 10000);
    });
    setEmptyBatch(response.entries.length === 0);
    setCursor(response.cursor);
    setScanned(true);
    setScanPattern(pattern);
  }
  async function connect() {
    await run(async () => {
      const opened = await invoke<{ handle: string; db: number }>("redis_connect", {
        config,
        password: password || null,
      });
      if (!mounted.current) {
        await invoke("redis_disconnect", { handle: opened.handle });
        return;
      }
      currentHandle.current = opened.handle;
      setHandle(opened.handle);
      setDb(opened.db);
      setNextDb(opened.db);
      setWritable(false);
      setPassword("");
      consumed();
      resetData();
      await serverInfo(opened.handle);
      await scan(true, opened.handle);
    });
  }
  async function serverInfo(id: string) {
    const values = await Promise.allSettled([
      request<{ result: RedisBlob }>({ op: "console", args: ["INFO", "server"] }, id),
      request<{ result: RedisBlob }>({ op: "console", args: ["INFO", "replication"] }, id),
      request<{ elapsed: number }>({ op: "console", args: ["PING"] }, id),
    ]);
    const version =
      values[0].status === "fulfilled"
        ? values[0].value.result.text?.match(/^redis_version:(.+)$/m)?.[1]?.trim()
        : null;
    const role =
      values[1].status === "fulfilled"
        ? values[1].value.result.text?.match(/^role:(.+)$/m)?.[1]?.trim()
        : null;
    const elapsed = values[2].status === "fulfilled" ? values[2].value.elapsed : undefined;
    setInfo(
      [
        version ?? "Redis",
        role,
        elapsed === undefined ? null : tx("{elapsed} 毫秒", { elapsed }),
        values.some((value) => value.status === "rejected") ? tx("部分服务器信息不可用。") : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  function reconnect() {
    before(() => {
      void run(async () => {
        const previous = currentHandle.current;
        if (!previous) return;
        currentHandle.current = null;
        setHandle(null);
        setWritable(false);
        resetData();
        const opened = await invoke<{ handle: string; db: number }>("redis_reconnect", {
          handle: previous,
        });
        if (!mounted.current) {
          await invoke("redis_disconnect", { handle: opened.handle });
          return;
        }
        currentHandle.current = opened.handle;
        setHandle(opened.handle);
        setDb(opened.db);
        setNextDb(opened.db);
        await serverInfo(opened.handle);
        await scan(true, opened.handle);
      });
    });
  }
  function disconnect() {
    before(() => {
      void run(async () => {
        if (currentHandle.current)
          await invoke("redis_disconnect", { handle: currentHandle.current });
        currentHandle.current = null;
        setHandle(null);
        setWritable(false);
        resetData();
        setInfo("");
      });
    });
  }
  async function read(
    item: RedisKey,
    field?: RedisBlob,
    at = 0,
    cursor = "0",
    pattern = memberPattern,
  ) {
    const document = await request<RedisDocument>({
      op: "read",
      key: item.key.data,
      field: field?.data ?? null,
      cursor,
      offset: at,
      pattern,
    });
    setSelection(item);
    if (field) setFieldData({ field, document });
    else {
      setData(document);
      setFieldData(null);
      setOffset(at);
      setMemberPattern(pattern);
    }
    setDraft(
      document.value?.text !== null &&
        document.value?.text !== undefined &&
        (document.version || field)
        ? {
            key: item.key,
            field,
            text: document.value.text,
            saved: document.value.text,
            version: document.version ?? null,
            fresh: document.version === null,
            id: nextDocument++,
            separator: document.value.text.match(/\r\n|\r|\n/)?.[0] ?? "\n",
          }
        : null,
    );
    return document;
  }
  async function save(): Promise<boolean> {
    if (!draft || !dirtyNow.current) return true;
    const snapshot = draft;
    if (snapshot.collection) {
      if (
        snapshot.collection.kind === "zset" &&
        !redisValidScore(snapshot.collection.score ?? "")
      ) {
        setError(tx("分数必须是有限且可表示的数值。"));
        return false;
      }
      const saved = await run(async () => {
        await request({
          op: "collection",
          db,
          key: snapshot.key.data,
          change: { ...snapshot.collection, value: redisEncode(snapshot.text) },
        });
        setDraft(null);
        restoreFieldFocus.current = true;
        dirtyNow.current = false;
        await redisGuard(config.id, false);
        await refreshCollection(
          { key: snapshot.key, kind: snapshot.collection!.kind, ttl: data?.ttl ?? -1 },
          snapshot.collection!.action === "create" ? 0 : offset,
        );
        return true;
      });
      return saved === true;
    }
    const saved = await run(async () => {
      const value = await request<{ version: string }>({
        op: "save",
        db,
        key: snapshot.key.data,
        field: snapshot.field?.data ?? null,
        value: redisEncode(snapshot.text),
        expected: snapshot.version,
      });
      setDraft((current) =>
        current?.id === snapshot.id
          ? { ...current, saved: snapshot.text, version: value.version, fresh: false }
          : current,
      );
      const blob = {
        data: redisEncode(snapshot.text),
        text: snapshot.text,
        size: new TextEncoder().encode(snapshot.text).length,
        truncated: false,
      };
      if (snapshot.field) {
        setFieldData({
          field: snapshot.field,
          document: {
            kind: "hash",
            ttl: data?.ttl ?? -1,
            db,
            value: blob,
            version: value.version,
          },
        });
        setData((current) => {
          if (!current) return current;
          const items = [...(current.items ?? [])];
          const index = items.findIndex(
            (item, index) => index % 2 === 0 && item.data === snapshot.field!.data,
          );
          const previewBytes = new TextEncoder().encode(snapshot.text).slice(0, 64 * 1024);
          let binary = "";
          for (let index = 0; index < previewBytes.length; index += 8192)
            binary += String.fromCharCode(...previewBytes.subarray(index, index + 8192));
          const preview = {
            ...blob,
            data: btoa(binary),
            text: new TextDecoder().decode(previewBytes),
            truncated: blob.size > 64 * 1024,
          };
          if (index >= 0) items[index + 1] = preview;
          else if (snapshot.fresh && memberPattern === "*" && items.length < 2000)
            items.push(snapshot.field!, preview);
          return {
            ...current,
            items,
            size: current.size === undefined ? undefined : current.size + (snapshot.fresh ? 1 : 0),
          };
        });
      } else
        setData((current) =>
          current ? { ...current, value: blob, size: blob.size, version: value.version } : current,
        );
      let savedTtl = data?.ttl ?? -1;
      if (snapshot.field && data?.size === undefined) {
        try {
          const collection = await request<RedisDocument>({
            op: "read",
            key: snapshot.key.data,
            field: null,
            cursor: "0",
            offset: 0,
            pattern: memberPattern,
          });
          setData(collection);
          savedTtl = collection.ttl;
        } catch (error) {
          setError(redisError(error));
        }
      }
      const savedKey = {
        key: snapshot.key,
        kind: snapshot.field ? "hash" : "string",
        ttl: savedTtl,
      };
      setKeys((previous) =>
        previous.some((item) => item.key.data === snapshot.key.data)
          ? previous.map((item) => (item.key.data === snapshot.key.data ? savedKey : item))
          : previous.length < 10000
            ? [...previous, savedKey]
            : previous,
      );
      dirtyNow.current = false;
      await redisGuard(config.id, false);
      return true;
    });
    return saved === true;
  }
  async function resolveGuard(saveFirst: boolean) {
    if (saveFirst && !(await save())) return;
    if (!saveFirst) {
      setDraft(null);
      dirtyNow.current = false;
      await redisGuard(config.id, false).catch((error) => {
        throw new Error(redisError(error));
      });
    }
    const action = pending;
    setPending(null);
    action?.();
  }
  const keyLabel = (item: RedisBlob) => redisDisplay(item) || tx("空 Key");
  async function copyKey() {
    try {
      await navigator.clipboard.writeText(selection?.key.text ?? "");
    } catch {
      setError(tx("无法复制 Key。"));
    }
  }
  function ttlLabel(value: number) {
    if (value === -2) return tx("Key 已过期");
    if (value < 0) return tx("无过期时间");
    const seconds = Math.ceil(value / 1000);
    return seconds < 60
      ? tx("{count} 秒", { count: seconds })
      : seconds < 3600
        ? tx("{count} 分钟", { count: Math.ceil(seconds / 60) })
        : tx("{count} 小时", { count: Math.ceil(seconds / 3600) });
  }
  function ttlTitle(value: number) {
    return tx("读取时 TTL：{count} 毫秒", { count: value });
  }
  function closeBrowser() {
    setBrowserOpen(false);
    if (narrow) browserToggle.current?.focus();
  }
  function closeMenus() {
    workspace.current?.querySelectorAll<HTMLDetailsElement>(".redis-menu[open]").forEach((menu) => {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    });
  }
  function openAction(action: string) {
    closeMenus();
    dialogOrigin.current = document.activeElement as HTMLElement;
    before(() => {
      setRename(selection?.key.text ?? "");
      setTtl(data && data.ttl > 0 ? String(Math.ceil(data.ttl / 1000)) : "3600");
      setNextDb(db);
      setNewKey("");
      setNewField("");
      setNewKind("string");
      setMutation({ action, argument: fieldData?.field.data ?? "" });
    });
  }
  function closeAction() {
    setMutation(null);
    restoreActionFocus.current = true;
  }
  function closeField() {
    before(() => {
      restoreFieldFocus.current = true;
      setDraft(null);
      setFieldData(null);
    });
  }
  function createDraft() {
    const blob = (text: string): RedisBlob => ({
      text,
      data: redisEncode(text),
      size: new TextEncoder().encode(text).length,
      truncated: false,
    });
    const adding = mutation?.action === "field";
    const key = adding ? selection!.key : blob(newKey);
    const kind = adding ? "hash" : newKind;
    const field = kind === "hash" ? blob(newField) : undefined;
    if (key.size > 4096 || (field && field.size > 4096)) {
      setError(tx("Key 或字段名超过 4096 字节。"));
      return;
    }
    if (!adding) {
      setSelection({ key, kind, ttl: -1 });
      setData({
        kind,
        ttl: -1,
        db,
        size: field ? undefined : 0,
        ...(field ? { items: [], cursor: "0" } : {}),
      });
      setOffset(0);
      setMemberPattern("*");
    }
    setFieldData(field ? { field, document: { kind: "hash", ttl: data?.ttl ?? -1, db } } : null);
    setDraft({
      key,
      field,
      text: "",
      saved: "",
      version: null,
      fresh: true,
      id: nextDocument++,
      separator: "\n",
      ...(["list", "set", "zset"].includes(kind)
        ? {
            collection: {
              kind: kind as RedisCollectionChange["kind"],
              action: "create" as const,
              ...(kind === "zset" ? { score: "0" } : {}),
              ...(kind === "list" ? { position: "tail" as const } : {}),
            },
            savedScore: kind === "zset" ? "0" : undefined,
          }
        : {}),
    });
    closeAction();
    closeBrowser();
  }
  function openMember(item?: RedisBlob, index = 0, deleting = false, origin?: HTMLButtonElement) {
    if (!selection || !data || !["list", "set", "zset"].includes(data.kind)) return;
    const kind = data.kind as RedisCollectionChange["kind"];
    const change: RedisCollectionChange = {
      kind,
      action: item ? (deleting ? "delete" : "update") : "add",
      ...(item
        ? {
            member: item.data,
            ...(kind === "list"
              ? { index: offset + index, expected: data.version ?? undefined }
              : {
                  expected:
                    kind === "zset" ? (data.items?.[index * 2 + 1]?.text ?? undefined) : "present",
                }),
          }
        : {}),
      ...(kind === "zset"
        ? { score: item ? (data.items?.[index * 2 + 1]?.text ?? "0") : "0" }
        : {}),
      ...(kind === "list" ? { position: "tail" } : {}),
    };
    before(() => {
      fieldOrigin.current = origin ?? null;
      if (deleting) {
        dialogOrigin.current = origin ?? null;
        setMemberTarget(change);
        setMutation({ action: "member-delete", argument: item?.text ?? tx("二进制成员") });
      } else {
        setFieldData(null);
        setDraft({
          key: selection.key,
          text: item?.text ?? "",
          saved: item?.text ?? "",
          version: null,
          fresh: !item,
          id: nextDocument++,
          separator: item?.text?.match(/\r\n|\r|\n/)?.[0] ?? "\n",
          collection: change,
          savedScore: change.score,
        });
      }
    });
  }
  async function refreshCollection(target: RedisKey, at: number) {
    try {
      const loaded = await read(target, undefined, at);
      if ((loaded.kind === "list" || loaded.kind === "zset") && loaded.size && at >= loaded.size)
        await read(target, undefined, Math.floor((loaded.size - 1) / 200) * 200);
    } catch (error) {
      if (String(error).includes("REDIS_KEY_MISSING")) {
        setSelection(null);
        setData(null);
        setKeys((keys) => keys.filter((item) => item.key.data !== target.key.data));
      } else setError(redisError(error));
    }
    try {
      await scan(true);
    } catch (error) {
      setError(redisError(error));
    }
  }
  async function deleteMember() {
    if (!selection || !memberTarget) return;
    const target = selection;
    await run(async () => {
      await request({ op: "collection", db, key: target.key.data, change: memberTarget });
      closeAction();
      setMemberTarget(null);
      await refreshCollection(target, offset);
    });
  }
  async function mutate(action: string, argument: string) {
    if (!selection) return;
    const target = selection;
    await run(async () => {
      await request({ op: "mutate", db, key: target.key.data, action, argument });
      closeAction();
      setDraft(null);
      setFieldData(null);
      if (action === "delete") {
        setSelection(null);
        setData(null);
      } else {
        const next =
          action === "rename"
            ? {
                ...target,
                key: {
                  ...target.key,
                  data: argument,
                  text: rename,
                  size: new TextEncoder().encode(rename).length,
                },
              }
            : target;
        try {
          await read(next);
        } catch (error) {
          setSelection(null);
          setData(null);
          if (action !== "hdelete" || !String(error).includes("REDIS_KEY_MISSING")) throw error;
        }
      }
      await scan(true);
    });
  }
  const keyRow = (item: RedisKey) => (
    <button
      key={item.key.data}
      className={`redis-key${selection?.key.data === item.key.data ? " selected" : ""}`}
      aria-pressed={selection?.key.data === item.key.data}
      disabled={busy}
      title={keyLabel(item.key)}
      onClick={() =>
        before(() => {
          void run(async () => {
            await read(item, undefined, 0, "0", "*");
            closeBrowser();
          });
        })
      }
    >
      <span>{keyLabel(item.key)}</span>
      <small className="redis-type" data-kind={item.kind}>
        {item.kind}
      </small>
      <small className="redis-key-ttl" title={ttlTitle(item.ttl)}>
        {ttlLabel(item.ttl)}
      </small>
    </button>
  );
  const groups = new Map<string, RedisKey[]>();
  for (const item of keys) {
    const label = item.key.text?.split(":")[0] ?? tx("二进制 Key");
    const group = groups.get(label) ?? [];
    group.push(item);
    groups.set(label, group);
  }
  const editorDocument: OpenFile | null = draft
    ? {
        id: draft.id,
        directory: "redis",
        path: `${draft.field ? keyLabel(draft.field) : keyLabel(draft.key)}${draft.text.trim().startsWith("{") || draft.text.trim().startsWith("[") ? ".json" : ".txt"}`,
        text: draft.text,
        saved: draft.saved,
        version: draft.version ?? "",
        line_ending: draft.separator,
        bom: false,
        readonly: !writable,
        notice: null,
        kind: "text",
        jump: 0,
      }
    : null;
  const valueDocument = fieldData?.document ?? data;
  const value = valueDocument?.value;
  const actionTitles: Record<string, string> = {
    create: tx("新 Key"),
    field: tx("添加字段"),
    rename: tx("重命名"),
    ttl: tx("设置 TTL"),
    delete: tx("删除 Key"),
    hdelete: tx("删除字段"),
    "member-delete": tx("删除成员"),
    db: tx("数据库 DB"),
  };
  const action = mutation?.action;
  const collection = data && ["hash", "list", "set", "zset"].includes(data.kind);
  return (
    <section
      ref={workspace}
      className="redis-workspace"
      hidden={!active}
      inert={!active}
      aria-label={tx("Redis 工作台")}
      onClickCapture={(event) => {
        // macOS may leave clicked buttons unfocused, so modal return targets need explicit focus.
        // macOS 可能不会聚焦点击的按钮，因此需显式聚焦以保留对话框返回目标。
        (event.target as HTMLElement).closest<HTMLElement>("button, summary")?.focus();
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          event.stopPropagation();
          if (!mutation && !pending) void save();
        }
      }}
    >
      <header className="redis-toolbar">
        {handle && (
          <button
            ref={browserToggle}
            className="redis-browser-toggle"
            aria-label={tx("浏览 Key")}
            title={tx("浏览 Key")}
            aria-expanded={browserOpen}
            onClick={() => (browserOpen ? closeBrowser() : setBrowserOpen(true))}
          >
            ☰
          </button>
        )}
        <span
          className={handle ? "redis-connected" : "muted"}
          title={handle ? tx("已连接") : tx("未连接")}
        >
          ●
        </span>
        <strong className="redis-connection-name" title={config.name}>
          {config.name}
        </strong>
        <span className="redis-endpoint" title={`${config.host}:${config.port}`}>
          {config.host}:{config.port}
          {config.tls ? " · TLS" : ""}
        </span>
        {handle ? (
          <>
            <button disabled={busy} onClick={() => openAction("db")} title={tx("数据库 DB")}>
              {tx("数据库 DB")} {db} ▾
            </button>
            <label className="redis-checkbox redis-write-toggle">
              <input
                type="checkbox"
                checked={writable}
                disabled={busy || dirty}
                aria-label={tx("允许编辑")}
                onChange={(event) => {
                  const value = event.target.checked;
                  void run(async () => {
                    await invoke("redis_writable", { handle, writable: value });
                    setWritable(value);
                  });
                }}
              />
              {writable ? tx("可编辑") : tx("只读")}
            </label>
            <details className="redis-menu redis-info">
              <summary aria-label={tx("连接信息")} title={tx("连接信息")}>
                ⓘ
              </summary>
              <div className="redis-menu-content">
                <strong>{tx("连接信息")}</strong>
                <p>{info || tx("已连接")}</p>
                <p>
                  {config.ssh_host ? `${config.ssh_host} → ` : ""}
                  {config.host}:{config.port}
                  {config.tls ? " · TLS" : ""}
                </p>
              </div>
            </details>
            <div className="redis-connection-actions">
              <button
                disabled={busy}
                onClick={() => {
                  closeMenus();
                  reconnect();
                }}
              >
                {tx("重新连接")}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  closeMenus();
                  disconnect();
                }}
              >
                {tx("断开")}
              </button>
            </div>
          </>
        ) : (
          <>
            <input
              aria-label={tx("临时密码")}
              type="password"
              autoComplete="off"
              placeholder={config.credential_id ? tx("留空使用已保存密码") : tx("临时密码")}
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button disabled={busy} onClick={() => void connect()}>
              {busy ? tx("正在连接…") : tx("连接")}
            </button>
          </>
        )}
      </header>
      {error && (
        <p className="remote-file-error" role="alert">
          {error}
        </p>
      )}
      {handle && (
        <>
          <div className="redis-body" ref={body} data-drawer-open={browserOpen || undefined}>
            {browserOpen && (
              <button
                className="redis-browser-backdrop"
                tabIndex={-1}
                aria-label={tx("关闭 Key 导航")}
                onClick={closeBrowser}
              />
            )}
            <aside
              className="redis-browser"
              ref={browser}
              aria-label={tx("浏览 Key")}
              style={{ width: browserWidth }}
              onKeyDown={(event) => {
                if (!narrow || !browserOpen) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeBrowser();
                }
                if (event.key === "Tab") {
                  const items = [
                    ...browser.current!.querySelectorAll<HTMLElement>(
                      "button:not(:disabled), input:not(:disabled), summary",
                    ),
                  ].filter(
                    (item) => item.tagName === "SUMMARY" || !item.closest("details:not([open])"),
                  );
                  const first = items[0],
                    last = items.at(-1);
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                  }
                }
              }}
            >
              <form
                className="redis-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(() => scan(true));
                }}
              >
                <label htmlFor={`redis-pattern-${config.id}`}>{tx("Key 匹配规则")}</label>
                <div className="redis-search-controls">
                  <input
                    ref={searchInput}
                    id={`redis-pattern-${config.id}`}
                    value={filter}
                    placeholder={tx("例如 user:*")}
                    disabled={busy}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                  <button disabled={busy} title={tx("搜索")}>
                    {tx("搜索")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={tx("刷新 Key")}
                    title={tx("刷新 Key")}
                    onClick={() => void run(() => scan(true))}
                  >
                    ↻
                  </button>
                  <button
                    type="button"
                    disabled={busy || !writable}
                    aria-label={tx("新 Key")}
                    title={writable ? tx("新 Key") : tx("允许编辑")}
                    onClick={() => openAction("create")}
                  >
                    ＋
                  </button>
                </div>
              </form>
              <div className="redis-browser-options">
                <label className="redis-checkbox">
                  <input
                    type="checkbox"
                    checked={grouped}
                    onChange={(event) => setGrouped(event.target.checked)}
                  />
                  {tx("按冒号分组")}
                </label>
                <button
                  className="redis-drawer-close"
                  aria-label={tx("关闭 Key 导航")}
                  title={tx("关闭 Key 导航")}
                  onClick={closeBrowser}
                >
                  <ToolbarIcon name="close" />
                </button>
              </div>
              <div className="redis-key-list">
                {grouped
                  ? [...groups].map(([group, items]) => (
                      <details
                        open={!collapsed.has(group)}
                        key={group}
                        onToggle={(event) => {
                          const open = event.currentTarget.open;
                          setCollapsed((previous) => {
                            if (previous.has(group) === !open) return previous;
                            const next = new Set(previous);
                            if (open) next.delete(group);
                            else next.add(group);
                            return next;
                          });
                        }}
                      >
                        <summary>
                          <span>{group}</span>
                          <small>{tx("已加载 {count}", { count: items.length })}</small>
                        </summary>
                        {items.map(keyRow)}
                      </details>
                    ))
                  : keys.map(keyRow)}
                {!keys.length && (
                  <p className="muted redis-list-empty">
                    {busy ? tx("正在读取…") : tx("本批次无匹配")}
                  </p>
                )}
              </div>
            </aside>
            <div
              role="separator"
              tabIndex={0}
              className="redis-resizer"
              aria-label={tx("调整 Key 导航宽度")}
              aria-orientation="vertical"
              aria-valuemin={180}
              aria-valuemax={420}
              aria-valuenow={browserWidth}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const rect = body.current?.getBoundingClientRect();
                if (rect)
                  setBrowserWidth(
                    Math.max(180, Math.min(420, rect.width * 0.45, event.clientX - rect.left)),
                  );
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onKeyDown={(event) => {
                if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  const max = Math.min(420, (body.current?.clientWidth || 940) * 0.45);
                  setBrowserWidth((value) =>
                    Math.max(
                      180,
                      Math.min(
                        max,
                        event.key === "Home"
                          ? 180
                          : event.key === "End"
                            ? max
                            : value + (event.key === "ArrowLeft" ? -10 : 10),
                      ),
                    ),
                  );
                }
              }}
            />
            <div className="redis-detail">
              {selection && data ? (
                <>
                  <div className="redis-value-heading">
                    <span className="redis-type" data-kind={data.kind}>
                      {data.kind}
                    </span>
                    <strong title={keyLabel(selection.key)}>{keyLabel(selection.key)}</strong>
                    <button
                      disabled={selection.key.text === null}
                      aria-label={tx("复制 Key")}
                      title={tx("复制 Key")}
                      onClick={() => {
                        void copyKey();
                      }}
                    >
                      ⧉
                    </button>
                    <button
                      disabled={busy}
                      title={tx("重新读取")}
                      aria-label={tx("重新读取")}
                      onClick={() =>
                        before(
                          () =>
                            void run(async () => {
                              const field = fieldData?.field;
                              await read(selection);
                              if (field) await read(selection, field);
                            }),
                        )
                      }
                    >
                      ↻
                    </button>
                    <button
                      disabled={busy || !writable}
                      title={ttlTitle(data.ttl)}
                      onClick={() => openAction("ttl")}
                    >
                      {tx("TTL")} · {ttlLabel(data.ttl)}
                    </button>
                    <details className="redis-menu">
                      <summary aria-label={tx("Key 操作")} title={tx("Key 操作")}>
                        ⋯
                      </summary>
                      <div className="redis-menu-content">
                        <button disabled={busy || !writable} onClick={() => openAction("rename")}>
                          {tx("重命名")}
                        </button>
                        <button
                          disabled={busy || !writable}
                          className="redis-danger"
                          onClick={() => openAction("delete")}
                        >
                          {tx("删除 Key")}
                        </button>
                      </div>
                    </details>
                  </div>
                  <div className="redis-value-meta">
                    <span>
                      {data.size === undefined
                        ? "—"
                        : data.kind === "string"
                          ? tx("{count} 字节", { count: data.size })
                          : tx("{count} 个成员", { count: data.size })}
                    </span>
                    <span title={ttlTitle(data.ttl)}>{ttlLabel(data.ttl)}</span>
                    {busy && <span role="status">{tx("正在读取…")}</span>}
                  </div>
                  {collection && (
                    <div
                      className={`redis-collection${fieldData || draft?.field || draft?.collection ? " has-field" : ""}`}
                    >
                      {data.kind !== "hash" && (
                        <div className="redis-member-search">
                          <button
                            disabled={busy || !writable}
                            onClick={(event) =>
                              openMember(undefined, 0, false, event.currentTarget)
                            }
                          >
                            {tx("添加成员")}
                          </button>
                          {data.kind === "list" && data.size !== 0 && !data.version && (
                            <span className="muted">
                              {tx("List 超过 10000 个成员或总值超过 1 MB，只能添加成员和浏览。")}
                            </span>
                          )}
                        </div>
                      )}
                      {(data.kind === "hash" || data.kind === "set") && (
                        <form
                          className="redis-member-search"
                          onSubmit={(event) => {
                            event.preventDefault();
                            before(() => void run(() => read(selection)));
                          }}
                        >
                          <input
                            aria-label={tx("成员匹配规则")}
                            placeholder={tx("成员匹配规则")}
                            value={memberPattern}
                            disabled={busy}
                            onChange={(event) => setMemberPattern(event.target.value)}
                          />
                          <button disabled={busy}>{tx("搜索成员")}</button>
                          {data.kind === "hash" && (
                            <button
                              type="button"
                              disabled={busy || !writable}
                              onClick={() => openAction("field")}
                            >
                              {tx("添加字段")}
                            </button>
                          )}
                        </form>
                      )}
                      {data.partial && (
                        <p role="status" className="muted">
                          {tx("本批次超过显示上限，请缩小成员匹配范围。")}
                        </p>
                      )}
                      <div className="redis-members">
                        <table>
                          <thead>
                            <tr>
                              <th>
                                {data.kind === "hash"
                                  ? tx("字段名")
                                  : data.kind === "list"
                                    ? tx("索引")
                                    : tx("成员")}
                              </th>
                              {data.kind !== "set" && (
                                <th>{data.kind === "zset" ? tx("分数") : tx("值预览")}</th>
                              )}
                              {data.kind !== "hash" && (
                                <th className="redis-member-actions">{tx("操作")}</th>
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {(data.items ?? [])
                              .filter(
                                (_, index) =>
                                  data.kind === "list" || data.kind === "set" || index % 2 === 0,
                              )
                              .map((item, index) => (
                                <tr
                                  key={`${index}:${item.data}`}
                                  data-selected={fieldData?.field.data === item.data || undefined}
                                >
                                  <td>
                                    {data.kind === "hash" ? (
                                      <button
                                        disabled={busy || item.truncated}
                                        onClick={(event) => {
                                          const origin = event.currentTarget;
                                          before(
                                            () =>
                                              void run(async () => {
                                                await read(selection, item);
                                                fieldOrigin.current = origin;
                                              }),
                                          );
                                        }}
                                      >
                                        {keyLabel(item)}
                                      </button>
                                    ) : data.kind === "list" ? (
                                      offset + index
                                    ) : (
                                      redisDisplay(item)
                                    )}
                                  </td>
                                  {data.kind !== "set" && (
                                    <td>
                                      <pre>
                                        {redisDisplay(
                                          data.kind === "list" ? item : data.items![index * 2 + 1],
                                        )}
                                      </pre>
                                    </td>
                                  )}
                                  {data.kind !== "hash" && (
                                    <td className="redis-member-actions">
                                      <button
                                        disabled={
                                          busy ||
                                          !writable ||
                                          item.truncated ||
                                          item.text === null ||
                                          (data.kind === "list" && !data.version)
                                        }
                                        onClick={(event) =>
                                          openMember(item, index, false, event.currentTarget)
                                        }
                                      >
                                        {tx("编辑成员")}
                                      </button>
                                      <button
                                        className="redis-danger"
                                        disabled={
                                          busy ||
                                          !writable ||
                                          item.truncated ||
                                          (data.kind === "list" && !data.version)
                                        }
                                        onClick={(event) =>
                                          openMember(item, index, true, event.currentTarget)
                                        }
                                      >
                                        {tx("删除成员")}
                                      </button>
                                    </td>
                                  )}
                                </tr>
                              ))}
                          </tbody>
                        </table>
                        {!data.items?.length && (
                          <p className="muted redis-list-empty">{tx("本批次无匹配")}</p>
                        )}
                      </div>
                      <div className="redis-pagination">
                        {(data.kind === "list" || data.kind === "zset") && (
                          <button
                            disabled={busy || offset === 0}
                            onClick={() =>
                              before(
                                () =>
                                  void run(() =>
                                    read(selection, undefined, Math.max(0, offset - 200)),
                                  ),
                              )
                            }
                          >
                            {tx("上一页")}
                          </button>
                        )}
                        <span>
                          {data.kind === "hash" || data.kind === "set"
                            ? data.cursor === "0"
                              ? tx("扫描完成")
                              : tx("扫描未完成")
                            : tx("成员 {start}–{end} / {count}", {
                                start: data.size ? offset + 1 : 0,
                                end: Math.min(offset + 200, data.size ?? 0),
                                count: data.size ?? 0,
                              })}
                        </span>
                        <button
                          disabled={
                            busy ||
                            (data.kind === "hash" || data.kind === "set"
                              ? data.cursor === "0"
                              : offset + 200 >= (data.size ?? 0))
                          }
                          onClick={() =>
                            before(
                              () =>
                                void run(() =>
                                  read(
                                    selection,
                                    undefined,
                                    data.kind === "hash" || data.kind === "set" ? 0 : offset + 200,
                                    data.cursor ?? "0",
                                  ),
                                ),
                            )
                          }
                        >
                          {tx("下一页")}
                        </button>
                      </div>
                    </div>
                  )}
                  {(draft || value || fieldData) && (
                    <div className="redis-value-pane">
                      <div className="redis-editor-actions">
                        <strong
                          title={
                            fieldData
                              ? keyLabel(fieldData.field)
                              : draft?.collection
                                ? tx("成员")
                                : tx("值")
                          }
                        >
                          {fieldData
                            ? keyLabel(fieldData.field)
                            : draft?.collection
                              ? draft.collection.kind === "list" &&
                                draft.collection.index !== undefined
                                ? `${tx("索引")} ${draft.collection.index}`
                                : tx("成员")
                              : tx("值")}
                        </strong>
                        {fieldData && value && (
                          <span>{tx("{count} 字节", { count: value.size })}</span>
                        )}
                        {dirty && <span className="redis-dirty">{tx("未保存")}</span>}
                        {draft && (
                          <>
                            <button
                              disabled={busy || !writable || !dirty}
                              title={tx("保存（Cmd/Ctrl+S）")}
                              onClick={() => void save()}
                            >
                              {tx("保存")}
                            </button>
                            <button
                              disabled={busy || !writable}
                              onClick={() => {
                                try {
                                  setDraft({
                                    ...draft,
                                    text: JSON.stringify(JSON.parse(draft.text), null, 2),
                                    id: nextDocument++,
                                  });
                                } catch {
                                  setError(tx("内容不是有效的 JSON。"));
                                }
                              }}
                            >
                              {tx("格式化 JSON")}
                            </button>
                          </>
                        )}
                        {fieldData && (
                          <>
                            <button
                              className="redis-danger"
                              disabled={busy || !writable || draft?.fresh}
                              onClick={() => openAction("hdelete")}
                            >
                              {tx("删除字段")}
                            </button>
                            <button
                              disabled={busy}
                              title={tx("关闭字段编辑")}
                              aria-label={tx("关闭字段编辑")}
                              onClick={closeField}
                            >
                              <ToolbarIcon name="close" />
                            </button>
                          </>
                        )}
                        {draft?.collection && (
                          <button
                            disabled={busy}
                            aria-label={tx("关闭成员编辑")}
                            title={tx("关闭成员编辑")}
                            onClick={closeField}
                          >
                            <ToolbarIcon name="close" />
                          </button>
                        )}
                      </div>
                      {draft?.collection && (
                        <div className="redis-member-options">
                          {draft.collection.kind === "zset" && (
                            <label>
                              {tx("分数")}
                              <input
                                aria-label={tx("分数")}
                                value={draft.collection.score ?? ""}
                                disabled={busy || !writable}
                                onChange={(event) =>
                                  setDraft((draft) =>
                                    draft?.collection
                                      ? {
                                          ...draft,
                                          collection: {
                                            ...draft.collection,
                                            score: event.target.value,
                                          },
                                        }
                                      : draft,
                                  )
                                }
                              />
                            </label>
                          )}
                          {draft.collection.kind === "list" &&
                            draft.collection.action !== "update" && (
                              <label>
                                {tx("添加位置")}
                                <select
                                  aria-label={tx("添加位置")}
                                  value={draft.collection.position ?? "tail"}
                                  disabled={busy || !writable}
                                  onChange={(event) =>
                                    setDraft((draft) =>
                                      draft?.collection
                                        ? {
                                            ...draft,
                                            collection: {
                                              ...draft.collection,
                                              position: event.target.value as "head" | "tail",
                                            },
                                          }
                                        : draft,
                                    )
                                  }
                                >
                                  <option value="tail">{tx("列表末尾")}</option>
                                  <option value="head">{tx("列表开头")}</option>
                                </select>
                              </label>
                            )}
                        </div>
                      )}
                      {draft && editorDocument ? (
                        <div className="redis-editor">
                          {editorModule ? (
                            <editorModule.CodeEditor
                              document={editorDocument}
                              controls={controls}
                              blocked={busy || !active}
                              change={(text) =>
                                setDraft((value) => (value ? { ...value, text } : value))
                              }
                              save={() => {
                                if (!mutation && !pending) void save();
                              }}
                              close={() => {
                                if (fieldData || draft.collection) closeField();
                              }}
                            />
                          ) : (
                            <p role="status">{tx("正在打开文件…")}</p>
                          )}
                        </div>
                      ) : value ? (
                        <div className="redis-value-preview">
                          <p className="muted">
                            {value.text === null
                              ? tx("二进制内容，仅供预览。")
                              : tx("值超过 1 MB，不能完整编辑。")}
                          </p>
                          {value.text === null ? (
                            <RedisBinaryPreview value={value} offset={fieldData ? 0 : offset} />
                          ) : (
                            <pre className="redis-preview">{redisDisplay(value)}</pre>
                          )}
                          {data.kind === "string" && (
                            <div className="redis-pagination">
                              <button
                                disabled={busy || offset === 0}
                                onClick={() =>
                                  void run(() =>
                                    read(selection, undefined, Math.max(0, offset - 1024 * 1024)),
                                  )
                                }
                              >
                                {tx("上一页")}
                              </button>
                              <span>
                                {tx("字节 {start}–{end} / {count}", {
                                  start: (data.size ?? 0) ? offset + 1 : 0,
                                  end: Math.min(offset + 1024 * 1024, data.size ?? 0),
                                  count: data.size ?? 0,
                                })}
                              </span>
                              <button
                                disabled={busy || offset + 1024 * 1024 >= (data.size ?? 0)}
                                onClick={() =>
                                  void run(() => read(selection, undefined, offset + 1024 * 1024))
                                }
                              >
                                {tx("下一页")}
                              </button>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="muted redis-list-empty">{tx("字段不存在，请重新读取。")}</p>
                      )}
                    </div>
                  )}
                  {data.unsupported && (
                    <p className="muted redis-empty">{tx("该数据类型暂不支持专用视图。")}</p>
                  )}
                </>
              ) : (
                <p className="muted redis-empty">
                  {tx("选择 Key 查看内容。连接默认只读，开启允许编辑后可新建或修改数据。")}
                </p>
              )}
            </div>
          </div>
          <footer className="redis-scan-status" role="status">
            <span>
              {tx("已加载 {count} 个 Key", { count: keys.length })} ·{" "}
              {busy
                ? tx("正在读取…")
                : scanned && cursor === "0"
                  ? tx("扫描完成")
                  : tx("扫描未完成")}
              {emptyBatch && !busy ? ` · ${tx("本批次无匹配")}` : ""}
            </span>
            {keys.length >= 10000 && <span>{tx("已达 10000 个 Key 上限，请缩小匹配范围。")}</span>}
            <button
              disabled={busy || (scanned && cursor === "0") || keys.length >= 10000}
              onClick={() => void run(() => scan(false))}
            >
              {tx("加载更多")}
            </button>
          </footer>
          <div className="redis-console">
            <button
              className="redis-console-toggle"
              aria-expanded={consoleOpen}
              onClick={() => setConsoleOpen((value) => !value)}
            >
              <span aria-hidden="true">{consoleOpen ? "▾" : "▸"}</span> {tx("命令台")}
            </button>
            {consoleOpen && (
              <>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      setResult("");
                      setElapsed(null);
                      const response = await request<{ result: unknown; elapsed: number }>({
                        op: "console",
                        args: redisArguments(command),
                      });
                      const value = response.result;
                      setResult(
                        typeof value === "object" && value !== null && "data" in value
                          ? redisDisplay(value as RedisBlob)
                          : JSON.stringify(value, null, 2),
                      );
                      setElapsed(response.elapsed);
                    });
                  }}
                >
                  <input
                    aria-label={tx("Redis 命令")}
                    autoComplete="off"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                  />
                  <button disabled={busy}>{tx("执行")}</button>
                  {elapsed !== null && <small>{tx("{elapsed} 毫秒", { elapsed })}</small>}
                </form>
                <p className="muted">
                  {tx("支持 PING、INFO、DBSIZE、TYPE、TTL、PTTL、EXISTS 和长度命令。")}
                </p>
                <pre>{result}</pre>
              </>
            )}
          </div>
        </>
      )}
      <dialog
        ref={guardDialog}
        className="ssh-dialog redis-action-dialog"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) setPending(null);
        }}
        aria-labelledby={`redis-unsaved-${config.id}`}
      >
        <h2 id={`redis-unsaved-${config.id}`}>{tx("Redis 有未保存修改")}</h2>
        <p>{tx("编辑内容仅保存在本次运行中。保存、放弃修改或取消当前操作。")}</p>
        <footer>
          <button disabled={busy} onClick={() => setPending(null)}>
            {tx("取消")}
          </button>
          <button
            disabled={busy}
            onClick={() => void resolveGuard(false).catch((error) => setError(redisError(error)))}
          >
            {tx("放弃修改")}
          </button>
          <button disabled={busy || !writable} onClick={() => void resolveGuard(true)}>
            {tx("保存并继续")}
          </button>
        </footer>
      </dialog>
      <dialog
        ref={mutationDialog}
        className="ssh-dialog redis-action-dialog"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) closeAction();
        }}
        aria-labelledby={`redis-confirm-${config.id}`}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!action || busy) return;
            if (action === "create" || action === "field") createDraft();
            else if (action === "member-delete") void deleteMember();
            else if (action === "db") {
              void run(async () => {
                await request({ op: "select", db: nextDb });
                setDb(nextDb);
                resetData();
                closeAction();
                await scan(true);
              });
            } else
              void mutate(
                action,
                action === "rename"
                  ? redisEncode(rename)
                  : action === "ttl"
                    ? ttl
                    : mutation.argument,
              );
          }}
        >
          <h2 id={`redis-confirm-${config.id}`}>{action ? actionTitles[action] : ""}</h2>
          <p className="redis-dialog-target">
            {config.name} · {config.host}:{config.port} · {tx("数据库 DB")} {db}
          </p>
          {action !== "create" && action !== "db" && selection && (
            <p className="redis-dialog-target">
              {keyLabel(selection.key)}
              {action === "hdelete" && fieldData ? ` / ${keyLabel(fieldData.field)}` : ""}
            </p>
          )}
          {action === "create" && (
            <>
              <label>
                {tx("新 Key")}
                <input
                  autoFocus
                  aria-label={tx("新 Key")}
                  value={newKey}
                  disabled={busy}
                  onChange={(event) => setNewKey(event.target.value)}
                />
              </label>
              <label>
                {tx("值类型")}
                <select
                  aria-label={tx("值类型")}
                  value={newKind}
                  onChange={(event) => setNewKind(event.target.value)}
                >
                  <option value="string">{tx("String")}</option>
                  <option value="hash">{tx("Hash")}</option>
                  <option value="list">{tx("List")}</option>
                  <option value="set">{tx("Set")}</option>
                  <option value="zset">{tx("ZSet")}</option>
                </select>
              </label>
            </>
          )}
          {(action === "field" || (action === "create" && newKind === "hash")) && (
            <label>
              {tx("Hash 字段")}
              <input
                autoFocus={action === "field"}
                aria-label={tx("Hash 字段")}
                value={newField}
                disabled={busy}
                onChange={(event) => setNewField(event.target.value)}
              />
            </label>
          )}
          {action === "rename" && (
            <label>
              {tx("新 Key 名称")}
              <input
                autoFocus
                aria-label={tx("新 Key 名称")}
                value={rename}
                disabled={busy}
                onChange={(event) => setRename(event.target.value)}
              />
            </label>
          )}
          {action === "ttl" && (
            <label>
              {tx("TTL（秒）")}
              <input
                autoFocus
                aria-label={tx("TTL（秒）")}
                type="number"
                min={1}
                max={3153600000}
                required
                value={ttl}
                disabled={busy}
                onChange={(event) => setTtl(event.target.value)}
              />
            </label>
          )}
          {action === "db" && (
            <label>
              {tx("数据库 DB")}
              <input
                autoFocus
                aria-label={tx("数据库 DB")}
                type="number"
                min={0}
                max={1024}
                required
                value={nextDb}
                disabled={busy}
                onChange={(event) => setNextDb(Number(event.target.value))}
              />
            </label>
          )}
          {action === "delete" && <p>{tx("删除该 Key？此操作无法撤销。")}</p>}
          {action === "hdelete" && <p>{tx("删除该 Hash 字段？此操作无法撤销。")}</p>}
          {action === "member-delete" && (
            <>
              <p className="redis-dialog-target">
                {memberTarget?.kind === "list"
                  ? `${tx("索引")} ${memberTarget.index}`
                  : mutation?.argument}
              </p>
              <p>{tx("删除该成员？删除最后一个成员会同时删除 Key。此操作无法撤销。")}</p>
            </>
          )}
          {error && (
            <p className="remote-file-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button type="button" disabled={busy} onClick={closeAction}>
              {tx("取消")}
            </button>
            {action === "ttl" && (
              <button type="button" disabled={busy} onClick={() => void mutate("persist", "")}>
                {tx("清除 TTL")}
              </button>
            )}
            <button
              disabled={busy || (action === "db" && nextDb === db)}
              className={
                action === "delete" || action === "hdelete" || action === "member-delete"
                  ? "redis-danger"
                  : undefined
              }
            >
              {action === "create" || action === "field"
                ? tx("新建")
                : action === "db"
                  ? tx("切换")
                  : tx("确认")}
            </button>
          </footer>
        </form>
      </dialog>
    </section>
  );
}
