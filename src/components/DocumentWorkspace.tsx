import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { databaseError, databaseNames, databaseStatus, type DatabaseConfig } from "../lib/database";
import {
  documentQuery,
  validDocumentJson,
  type DatabaseDocument,
  type DocumentResult,
} from "../lib/document-database";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { DatabaseComponents } from "./DatabaseComponents";

export function DocumentWorkspace({
  config,
  active,
  password: initialPassword,
}: {
  config: DatabaseConfig;
  active: boolean;
  password: string;
}) {
  useUiLanguage();
  const elastic = config.kind === "elasticsearch";
  const [handle, setHandle] = useState<string | null>(null);
  const current = useRef<string | null>(null);
  const mounted = useRef(true);
  const working = useRef(false);
  const [password, setPassword] = useState(initialPassword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [database, setDatabase] = useState(config.database || (elastic ? "" : "admin"));
  const [databases, setDatabases] = useState<string[]>([]);
  const [collection, setCollection] = useState(elastic ? config.database : "");
  const [names, setNames] = useState<string[]>([]);
  const [query, setQuery] = useState(() => documentQuery(config.kind));
  const [savedQuery, setSavedQuery] = useState(query);
  const [resultQuery, setResultQuery] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DatabaseDocument[]>([]);
  const [selected, setSelected] = useState<DatabaseDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [metadata, setMetadata] = useState("");
  const [writable, setWritable] = useState(false);
  const [componentsOpen, setComponentsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{ text: string; action: () => void } | null>(
    null,
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const documentDirty = draft !== (selected?.value ?? "");
  const dirty = query !== savedQuery || documentDirty;
  useEffect(() => {
    if (initialPassword) setPassword(initialPassword);
  }, [initialPassword]);
  useEffect(() => {
    databaseStatus(config.id, { connected: !!handle, busy, dirty });
    void invoke("database_guard", { id: config.id, dirty }).catch((reason) =>
      setError(databaseError(reason)),
    );
  }, [config.id, handle, busy, dirty]);
  useEffect(() => {
    if (confirmation) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirmation]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (current.current)
        void invoke("database_disconnect", { handle: current.current, discard: true }).catch(
          () => {},
        );
      void invoke("database_guard", { id: config.id, dirty: false }).catch(() => {});
      databaseStatus(config.id, { connected: false, busy: false, dirty: false });
    };
  }, [config.id]);
  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      if (mounted.current) setError(databaseError(reason));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function request(
    action: string,
    extra: Record<string, unknown> = {},
  ): Promise<DocumentResult> {
    const requestedHandle = current.current;
    if (!requestedHandle) throw new Error("DB_DISCONNECTED");
    try {
      const result = await invoke<DocumentResult>("database_request", {
        handle: requestedHandle,
        request: { op: "document", action, database, collection, ...extra },
      });
      if (!mounted.current || current.current !== requestedHandle) throw new Error("DB_CANCELLED");
      return result;
    } catch (reason) {
      if (
        /DB_(TIMEOUT|DISCONNECTED|WRITE_UNKNOWN)/.test(String(reason)) &&
        current.current === requestedHandle
      ) {
        await invoke("database_disconnect", { handle: requestedHandle, discard: true });
        current.current = null;
        setHandle(null);
        setWritable(false);
      }
      throw reason;
    }
  }
  function protect(action: () => void) {
    if (documentDirty) setConfirmation({ text: tx("文档有未保存修改，确认放弃后继续？"), action });
    else action();
  }
  function clearDocuments() {
    setResultQuery(null);
    setDocuments([]);
    setSelected(null);
    setDraft("");
    setMetadata("");
    setMore(false);
    setOffset(0);
  }
  async function loadNames(nextDatabase = database) {
    const result = await request("collections", { database: nextDatabase });
    setNames(result.names ?? []);
  }
  async function connect() {
    const opened = await invoke<{ handle: string }>("database_connect", {
      config,
      password: password || null,
    });
    if (!mounted.current) {
      await invoke("database_disconnect", { handle: opened.handle, discard: true });
      return;
    }
    current.current = opened.handle;
    setHandle(opened.handle);
    setPassword("");
    setWritable(false);
    if (!elastic) {
      const result = await request("databases");
      setDatabases(result.names ?? []);
    }
    await loadNames();
  }
  async function disconnect() {
    const closing = current.current;
    if (!closing) return;
    await invoke("database_disconnect", { handle: closing, discard: true });
    current.current = null;
    setHandle(null);
    setWritable(false);
    setDocuments([]);
    setMetadata("");
    setMore(false);
    setResultQuery(null);
  }
  async function execute(nextOffset = 0) {
    if (!validDocumentJson(query)) throw new Error("DB_DOCUMENT_QUERY");
    const page = resultQuery === query ? nextOffset : 0;
    const result = await request("query", { query, offset: page });
    setDocuments(result.documents ?? []);
    setMore(!!result.more);
    setOffset(page);
    setResultQuery(query);
    setMetadata(result.metadata ?? "");
    setSelected(null);
    setDraft("");
  }
  function write(action: "insert" | "replace" | "delete") {
    if (!writable || !current.current || !collection) return;
    if (action !== "delete" && !validDocumentJson(draft)) {
      setError(databaseError("DB_DOCUMENT_QUERY"));
      return;
    }
    setConfirmation({
      text: tx("此操作立即写入服务器，不支持提交或回滚。确认继续？"),
      action: () =>
        void run(async () => {
          await request(action, {
            document: draft,
            original: selected?.value,
            identity: selected?.identity,
            version: selected?.version,
            confirmed: true,
          });
          setSelected(null);
          setDraft("");
          setDocuments([]);
          setMore(false);
          setMetadata("");
          setNotice(tx("文档操作成功，请重新执行查询查看结果。"));
        }),
    });
  }
  return (
    <section
      className="database-workspace document-workspace"
      hidden={!active}
      aria-label={`${databaseNames[config.kind]} ${config.name}`}
    >
      <header className="redis-toolbar database-connection-bar">
        <strong>{config.name}</strong>
        <span>
          {databaseNames[config.kind]} · {config.host}:{config.port}
        </span>
        {!handle && (
          <input
            aria-label={tx("密码")}
            type="password"
            value={password}
            placeholder={config.credential_id ? tx("留空使用已保存密码") : tx("密码")}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
        <button disabled={busy} onClick={() => void run(handle ? disconnect : connect)}>
          {handle ? tx("断开") : tx("连接")}
        </button>
        {busy && handle && (
          <button
            onClick={() => void disconnect().catch((reason) => setError(databaseError(reason)))}
          >
            {tx("取消查询并断开")}
          </button>
        )}
        <label className="redis-checkbox">
          <input
            type="checkbox"
            checked={writable}
            disabled={!handle || busy}
            onChange={(event) => {
              const enabled = event.target.checked;
              void run(async () => {
                await request("writable", { enabled });
                setWritable(enabled);
              });
            }}
          />
          {tx("允许编辑")}
        </label>
        {!elastic && (
          <button disabled={busy} onClick={() => setComponentsOpen(!componentsOpen)}>
            {tx("数据库组件")}
          </button>
        )}
      </header>
      {componentsOpen && <DatabaseComponents selectedKind={config.kind} />}
      <p className="document-access-state">{tx("默认只读。文档写入立即生效，不提供 SQL 事务。")}</p>
      {error && (
        <p role="alert" className="redis-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="document-body">
        <aside className="document-browser">
          {!elastic && (
            <label>
              {tx("数据库")}
              <input
                aria-label={tx("数据库名称")}
                list={`document-databases-${config.id}`}
                value={database}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value;
                  protect(() => {
                    setDatabase(value);
                    setCollection("");
                    setNames([]);
                    clearDocuments();
                  });
                }}
              />
              <datalist id={`document-databases-${config.id}`}>
                {databases.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
          )}
          <button disabled={!handle || busy} onClick={() => void run(() => loadNames())}>
            {tx("刷新对象")}
          </button>
          <strong>{elastic ? tx("索引") : tx("集合")}</strong>
          <input
            aria-label={elastic ? tx("索引") : tx("集合")}
            value={collection}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              protect(() => {
                setCollection(value);
                clearDocuments();
              });
            }}
          />
          <div className="document-names">
            {names.map((name) => (
              <button
                key={name}
                title={name}
                aria-pressed={name === collection}
                disabled={busy}
                onClick={() =>
                  protect(() => {
                    setCollection(name);
                    clearDocuments();
                  })
                }
              >
                {name}
              </button>
            ))}
          </div>
          {elastic && (
            <button
              disabled={!handle || !collection || busy}
              onClick={() =>
                void run(async () => {
                  const result = await request("mapping");
                  setMetadata(result.metadata ?? "");
                })
              }
            >
              {tx("映射")}
            </button>
          )}
        </aside>
        <div className="document-content">
          <div className="database-actions">
            <strong>
              {elastic ? "Query DSL" : tx("查询 JSON（filter 或 pipeline）")}
              {query !== savedQuery ? " •" : ""}
            </strong>
            <button
              disabled={!handle || !collection || busy}
              onClick={() => protect(() => void run(() => execute()))}
            >
              {tx("执行查询")}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (
                    await invoke<boolean>("database_export_result", { data: query, format: "json" })
                  )
                    setSavedQuery(query);
                })
              }
            >
              {tx("保存 JSON")}
            </button>
            <button
              disabled={busy || query === savedQuery}
              onClick={() =>
                setConfirmation({
                  text: tx("确认放弃查询修改？"),
                  action: () => setQuery(savedQuery),
                })
              }
            >
              {tx("放弃查询修改")}
            </button>
          </div>
          <textarea
            className="document-query"
            aria-label={tx("查询 JSON")}
            spellCheck={false}
            maxLength={262144}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                if (handle && !busy && collection) protect(() => void run(() => execute()));
              }
            }}
          />
          <div className="document-results" aria-label={tx("查询结果")}>
            {documents.map((item, index) => (
              <button
                className="document-result"
                key={`${offset}-${index}`}
                disabled={busy}
                aria-pressed={selected === item}
                onClick={() =>
                  protect(() => {
                    setSelected(item);
                    setDraft(item.value);
                  })
                }
              >
                <span>{offset + index + 1}</span>
                <pre>{item.value}</pre>
              </button>
            ))}
            {metadata && <pre className="document-metadata">{metadata}</pre>}
          </div>
          <div className="database-actions document-pagination">
            <span>{tx("本页 {count} 条", { count: documents.length })}</span>
            <button
              disabled={!handle || busy || query !== resultQuery || offset === 0}
              onClick={() => protect(() => void run(() => execute(Math.max(0, offset - 50))))}
            >
              {tx("上一页")}
            </button>
            <button
              disabled={!handle || busy || query !== resultQuery || !more || offset >= 9950}
              onClick={() => protect(() => void run(() => execute(offset + 50)))}
            >
              {tx("下一页")}
            </button>
            <button
              disabled={busy || !documents.length}
              onClick={() =>
                void run(async () => {
                  await invoke("database_export_result", {
                    data: `[\n${documents.map((item) => item.value).join(",\n")}\n]`,
                    format: "json",
                  });
                })
              }
            >
              {tx("导出本页 JSON")}
            </button>
            <button
              disabled={!handle || busy || !writable}
              onClick={() =>
                protect(() => {
                  setSelected(null);
                  setDraft("{}");
                })
              }
            >
              {tx("新建文档")}
            </button>
          </div>
          {(selected || draft) && (
            <div className="document-editor">
              <div className="database-actions">
                <strong>
                  {tx("文档 JSON")}
                  {documentDirty ? " •" : ""}
                </strong>
                <button
                  disabled={
                    !handle ||
                    busy ||
                    !writable ||
                    !documentDirty ||
                    (!!selected && !selected.identity)
                  }
                  onClick={() => write(selected ? "replace" : "insert")}
                >
                  {selected ? tx("替换文档") : tx("插入文档")}
                </button>
                <button
                  disabled={!handle || busy || !writable || !selected?.identity || documentDirty}
                  onClick={() => write("delete")}
                >
                  {tx("删除文档")}
                </button>
                <button
                  disabled={busy || !documentDirty}
                  onClick={() =>
                    setConfirmation({
                      text: tx("确认放弃文档修改？"),
                      action: () => setDraft(selected?.value ?? ""),
                    })
                  }
                >
                  {tx("放弃文档修改")}
                </button>
              </div>
              <textarea
                aria-label={tx("文档 JSON")}
                value={draft}
                maxLength={262144}
                readOnly={!writable || busy}
                spellCheck={false}
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
          )}
        </div>
      </div>
      <dialog
        ref={dialog}
        className="database-confirm-dialog"
        onCancel={(event) => {
          event.preventDefault();
          setConfirmation(null);
        }}
      >
        <p>{confirmation?.text}</p>
        <button onClick={() => setConfirmation(null)}>{tx("取消")}</button>
        <button
          onClick={() => {
            const action = confirmation?.action;
            setConfirmation(null);
            action?.();
          }}
        >
          {tx("确认")}
        </button>
      </dialog>
    </section>
  );
}
