import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { RedisBinaryPreview } from "./RedisBinaryPreview";
import {
  redisArguments,
  redisDisplay,
  redisEncode,
  redisError,
  redisGuard,
  redisStatus,
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
  const [memberPattern, setMemberPattern] = useState("*");
  const [draft, setDraft] = useState<Draft | null>(null);
  const dirty = !!draft && (draft.fresh || draft.text !== draft.saved);
  const dirtyNow = useRef(dirty);
  dirtyNow.current = dirty;
  const [pending, setPending] = useState<(() => void) | null>(null);
  const guardDialog = useRef<HTMLDialogElement>(null);
  const [mutation, setMutation] = useState<{ action: string; argument: string } | null>(null);
  const mutationDialog = useRef<HTMLDialogElement>(null);
  const [newKey, setNewKey] = useState("");
  const [newKeyTarget, setNewKeyTarget] = useState<RedisBlob | null>(null);
  const [newField, setNewField] = useState("");
  const [newKind, setNewKind] = useState("string");
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
    if (pending) guardDialog.current?.showModal();
    else guardDialog.current?.close();
  }, [pending]);
  useEffect(() => {
    if (mutation) mutationDialog.current?.showModal();
    else mutationDialog.current?.close();
  }, [mutation]);
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
    setNewKeyTarget(null);
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
  async function read(item: RedisKey, field?: RedisBlob, at = 0, cursor = "0") {
    const document = await request<RedisDocument>({
      op: "read",
      key: item.key.data,
      field: field?.data ?? null,
      cursor,
      offset: at,
      pattern: memberPattern,
    });
    setSelection(item);
    setData(document);
    setOffset(at);
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
  }
  async function save(): Promise<boolean> {
    if (!draft || !dirtyNow.current) return true;
    const snapshot = draft;
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
  const keyRow = (item: RedisKey) => (
    <button
      key={item.key.data}
      className={`redis-key${selection?.key.data === item.key.data ? " selected" : ""}`}
      disabled={busy}
      title={keyLabel(item.key)}
      onClick={() =>
        before(() => {
          void run(() => read(item));
        })
      }
    >
      <span>{keyLabel(item.key)}</span>
      <small>{item.kind}</small>
      <small>{item.ttl < 0 ? "—" : `${Math.ceil(item.ttl / 1000)}s`}</small>
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
  return (
    <section
      className="redis-workspace"
      hidden={!active}
      inert={!active}
      aria-label={tx("Redis 工作台")}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          event.stopPropagation();
          void save();
        }
      }}
    >
      <header className="redis-toolbar">
        <strong>{config.name}</strong>
        <span>
          {config.ssh_host ? `${config.ssh_host} → ` : ""}
          {config.host}:{config.port}
          {config.tls ? " · TLS" : ""}
        </span>
        {handle ? (
          <>
            <span className="redis-connected">{info || tx("已连接")}</span>
            <label>
              {tx("数据库 DB")}{" "}
              <input
                aria-label={tx("数据库 DB")}
                type="number"
                min={0}
                max={1024}
                value={nextDb}
                disabled={busy}
                onChange={(event) => setNextDb(Number(event.target.value))}
              />
            </label>
            <button
              disabled={busy || nextDb === db}
              onClick={() =>
                before(() => {
                  void run(async () => {
                    await request({ op: "select", db: nextDb });
                    setDb(nextDb);
                    resetData();
                    await scan(true);
                  });
                })
              }
            >
              {tx("切换")}
            </button>
            <label className="redis-checkbox">
              <input
                type="checkbox"
                checked={writable}
                disabled={busy || dirty}
                onChange={(event) => {
                  const value = event.target.checked;
                  void run(async () => {
                    await invoke("redis_writable", { handle, writable: value });
                    setWritable(value);
                  });
                }}
              />
              {tx("允许编辑")}
            </label>
            <span>{writable ? tx("可编辑") : tx("只读")}</span>
            <button disabled={busy} onClick={reconnect}>
              {tx("重新连接")}
            </button>
            <button disabled={busy} onClick={disconnect}>
              {tx("断开")}
            </button>
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
        <div className="redis-body">
          <aside className="redis-browser">
            <form
              className="redis-search"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => scan(true));
              }}
            >
              <input
                aria-label={tx("Key 匹配规则")}
                value={filter}
                disabled={busy}
                onChange={(event) => setFilter(event.target.value)}
              />
              <button disabled={busy}>{tx("搜索")}</button>
            </form>
            <label className="redis-checkbox">
              <input
                type="checkbox"
                checked={grouped}
                onChange={(event) => setGrouped(event.target.checked)}
              />
              {tx("按冒号分组")}
            </label>
            <div className="redis-key-list">
              {grouped
                ? [...groups].map(([group, items]) => (
                    <details open key={group}>
                      <summary>{group}</summary>
                      {items.map(keyRow)}
                    </details>
                  ))
                : keys.map(keyRow)}
            </div>
            <footer>
              <span>{tx("已加载 {count} 个 Key", { count: keys.length })}</span>
              <button
                disabled={busy || (scanned && cursor === "0") || keys.length >= 10000}
                onClick={() => void run(() => scan(false))}
              >
                {tx("加载更多")}
              </button>
            </footer>
            {keys.length >= 10000 && (
              <p role="status">{tx("已达 10000 个 Key 上限，请缩小匹配范围。")}</p>
            )}
          </aside>
          <div className="redis-detail">
            {writable && (
              <form
                className="redis-create"
                onSubmit={(event) => {
                  event.preventDefault();
                  before(() => {
                    const key = newKeyTarget ?? {
                      data: redisEncode(newKey),
                      text: newKey,
                      size: new TextEncoder().encode(newKey).length,
                      truncated: false,
                    };
                    const field =
                      newKind === "hash"
                        ? {
                            data: redisEncode(newField),
                            text: newField,
                            size: new TextEncoder().encode(newField).length,
                            truncated: false,
                          }
                        : undefined;
                    setSelection({ key, kind: newKind, ttl: -1 });
                    setData({ kind: newKind, ttl: -1, db });
                    setDraft({
                      key,
                      field,
                      text: "",
                      saved: "",
                      version: null,
                      fresh: true,
                      id: nextDocument++,
                      separator: "\n",
                    });
                  });
                }}
              >
                <input
                  aria-label={tx("新 Key")}
                  placeholder={tx("新 Key")}
                  value={newKey}
                  onChange={(e) => {
                    setNewKey(e.target.value);
                    setNewKeyTarget(null);
                  }}
                />
                <select
                  aria-label={tx("值类型")}
                  value={newKind}
                  onChange={(e) => setNewKind(e.target.value)}
                >
                  <option value="string">{tx("String")}</option>
                  <option value="hash">{tx("Hash")}</option>
                </select>
                {newKind === "hash" && (
                  <input
                    aria-label={tx("Hash 字段")}
                    placeholder={tx("Hash 字段")}
                    value={newField}
                    onChange={(e) => setNewField(e.target.value)}
                  />
                )}
                <button disabled={busy}>{tx("新建")}</button>
              </form>
            )}
            {selection && data ? (
              <>
                <div className="redis-value-heading">
                  <strong title={keyLabel(selection.key)}>{keyLabel(selection.key)}</strong>
                  <span>
                    {data.kind} · {data.size ?? "—"} · {tx("TTL")}:{" "}
                    {data.ttl < 0 ? "—" : `${Math.ceil(data.ttl / 1000)}s`}
                  </span>
                  <button
                    disabled={busy}
                    onClick={() =>
                      before(() => {
                        void run(() => read(selection, draft?.field));
                      })
                    }
                  >
                    {tx("重新读取")}
                  </button>
                </div>
                {writable && (
                  <div className="redis-key-actions">
                    <input
                      aria-label={tx("新 Key 名称")}
                      placeholder={tx("新 Key 名称")}
                      value={rename}
                      onChange={(e) => setRename(e.target.value)}
                    />
                    <button
                      disabled={busy}
                      onClick={() =>
                        before(() =>
                          setMutation({ action: "rename", argument: redisEncode(rename) }),
                        )
                      }
                    >
                      {tx("重命名")}
                    </button>
                    <input
                      aria-label={tx("TTL（秒）")}
                      type="number"
                      min={1}
                      max={3153600000}
                      value={ttl}
                      onChange={(e) => setTtl(e.target.value)}
                    />
                    <button
                      disabled={busy}
                      onClick={() => before(() => setMutation({ action: "ttl", argument: ttl }))}
                    >
                      {tx("设置 TTL")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => before(() => setMutation({ action: "persist", argument: "" }))}
                    >
                      {tx("清除 TTL")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => before(() => setMutation({ action: "delete", argument: "" }))}
                    >
                      {tx("删除 Key")}
                    </button>
                  </div>
                )}
                {draft && editorDocument ? (
                  <>
                    <div className="redis-editor-actions">
                      <span>
                        {draft.field ? `${tx("Hash 字段")}: ${keyLabel(draft.field)}` : tx("值")}
                        {dirty ? " *" : ""}
                      </span>
                      <button disabled={busy || !writable || !dirty} onClick={() => void save()}>
                        {tx("保存")}
                      </button>
                      <button
                        disabled={busy || !writable}
                        onClick={() => {
                          try {
                            const text = JSON.stringify(JSON.parse(draft.text), null, 2);
                            setDraft({ ...draft, text, id: nextDocument++ });
                          } catch {
                            setError(tx("内容不是有效的 JSON。"));
                          }
                        }}
                      >
                        {tx("格式化 JSON")}
                      </button>
                      {draft.field && writable && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            before(() =>
                              setMutation({ action: "hdelete", argument: draft.field!.data }),
                            )
                          }
                        >
                          {tx("删除字段")}
                        </button>
                      )}
                    </div>
                    <div className="redis-editor">
                      {editorModule ? (
                        <editorModule.CodeEditor
                          document={editorDocument}
                          controls={controls}
                          blocked={busy || !active}
                          change={(text) =>
                            setDraft((value) => (value ? { ...value, text } : value))
                          }
                          save={() => void save()}
                          close={() => {}}
                        />
                      ) : (
                        <p role="status">{tx("正在打开文件…")}</p>
                      )}
                    </div>
                  </>
                ) : data.value ? (
                  <>
                    <p>
                      {data.value.text === null
                        ? tx("二进制内容，仅供预览。")
                        : tx("值超过 1 MB，不能完整编辑。")}
                    </p>
                    {data.value.text === null ? (
                      <RedisBinaryPreview value={data.value} offset={offset} />
                    ) : (
                      <pre className="redis-preview">{redisDisplay(data.value)}</pre>
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
                          {offset} / {data.size}
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
                  </>
                ) : (
                  <>
                    {(data.kind === "hash" || data.kind === "set") && (
                      <form
                        className="redis-search"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run(() => read(selection));
                        }}
                      >
                        <input
                          aria-label={tx("成员匹配规则")}
                          value={memberPattern}
                          onChange={(e) => setMemberPattern(e.target.value)}
                        />
                        <button disabled={busy}>{tx("搜索成员")}</button>
                        {data.kind === "hash" && writable && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setNewKey(redisDisplay(selection.key));
                              setNewKeyTarget(selection.key);
                              setNewKind("hash");
                            }}
                          >
                            {tx("添加字段")}
                          </button>
                        )}
                      </form>
                    )}
                    {data.unsupported && <p>{tx("该数据类型暂不支持专用视图。")}</p>}
                    {data.partial && (
                      <p role="status">{tx("本批次超过显示上限，请缩小成员匹配范围。")}</p>
                    )}
                    <div className="redis-members">
                      {(data.items ?? [])
                        .filter(
                          (_, index) =>
                            data.kind === "list" || data.kind === "set" || index % 2 === 0,
                        )
                        .map((item, index) => (
                          <div className="redis-member" key={`${index}:${item.data}`}>
                            {data.kind === "hash" ? (
                              <button
                                disabled={busy || item.truncated}
                                onClick={() => void run(() => read(selection, item))}
                              >
                                {keyLabel(item)}
                              </button>
                            ) : (
                              <span>
                                {data.kind === "list" ? `${offset + index}: ` : ""}
                                {redisDisplay(item)}
                              </span>
                            )}
                            {(data.kind === "hash" || data.kind === "zset") && (
                              <pre>{redisDisplay(data.items![index * 2 + 1])}</pre>
                            )}
                          </div>
                        ))}
                    </div>
                    {data.items && (
                      <div className="redis-pagination">
                        <button
                          disabled={
                            busy ||
                            (data.kind === "hash" || data.kind === "set"
                              ? data.cursor === "0"
                              : offset + 200 >= (data.size ?? 0))
                          }
                          onClick={() =>
                            void run(() =>
                              read(
                                selection,
                                undefined,
                                data.kind === "hash" || data.kind === "set" ? 0 : offset + 200,
                                data.cursor ?? "0",
                              ),
                            )
                          }
                        >
                          {tx("下一页")}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              <p className="muted redis-empty">
                {tx("选择 Key 查看内容。连接默认只读，开启允许编辑后可新建或修改数据。")}
              </p>
            )}
          </div>
        </div>
      )}
      {handle && (
        <div className="redis-console">
          <button aria-expanded={consoleOpen} onClick={() => setConsoleOpen((value) => !value)}>
            {tx("命令台")}
          </button>
          {consoleOpen && (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
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
                  onChange={(e) => setCommand(e.target.value)}
                />
                <button disabled={busy}>{tx("执行")}</button>
              </form>
              <p className="muted">
                {tx("支持 PING、INFO、DBSIZE、TYPE、TTL、PTTL、EXISTS 和长度命令。")}
              </p>
              {elapsed !== null && <small>{tx("{elapsed} 毫秒", { elapsed })}</small>}
              <pre>{result}</pre>
            </>
          )}
        </div>
      )}
      <dialog
        ref={guardDialog}
        className="ssh-dialog"
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
        className="ssh-dialog"
        onCancel={(event) => {
          event.preventDefault();
          setMutation(null);
        }}
        aria-labelledby={`redis-confirm-${config.id}`}
      >
        <h2 id={`redis-confirm-${config.id}`}>{tx("确认 Redis 操作")}</h2>
        <p>
          {selection ? keyLabel(selection.key) : ""} · {tx("数据库 DB")} {db}
        </p>
        <p>
          {mutation?.action === "delete"
            ? tx("删除该 Key？此操作无法撤销。")
            : mutation?.action === "hdelete"
              ? tx("删除该 Hash 字段？此操作无法撤销。")
              : tx("将修改此 Key 的名称或过期时间。")}
        </p>
        <footer>
          <button disabled={busy} onClick={() => setMutation(null)}>
            {tx("取消")}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              if (!mutation || !selection) return;
              const current = mutation;
              void run(async () => {
                await request({ op: "mutate", db, key: selection.key.data, ...current });
                setMutation(null);
                setDraft(null);
                setData(null);
                setSelection(null);
                await scan(true);
              });
            }}
          >
            {tx("确认")}
          </button>
        </footer>
      </dialog>
    </section>
  );
}
