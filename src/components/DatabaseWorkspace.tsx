import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DatabaseGrid } from "./DatabaseGrid";
import { DatabaseObjects } from "./DatabaseObjects";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import {
  databaseError,
  databaseNames,
  databaseStatus,
  databaseSelect,
  type DatabaseObject,
  type DatabaseConfig,
  type DatabaseResult,
} from "../lib/database";
import type { OpenFile } from "../lib/file-document";

export function DatabaseWorkspace({
  config,
  active,
  password: initialPassword,
}: {
  config: DatabaseConfig;
  active: boolean;
  password: string;
}) {
  useUiLanguage();
  const [handle, setHandle] = useState<string | null>(null);
  const current = useRef<string | null>(null);
  const mounted = useRef(true);
  const [password, setPassword] = useState(initialPassword);
  const [sql, setSql] = useState(config.kind === "oracle" ? "SELECT 1 FROM DUAL" : "SELECT 1");
  const [saved, setSaved] = useState(config.kind === "oracle" ? "SELECT 1 FROM DUAL" : "SELECT 1");
  const [executed, setExecuted] = useState("");
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const cancelled = useRef(false);
  const [revision, setRevision] = useState(1);
  const [pending, setPending] = useState(false);
  const [writable, setWritable] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [result, setResult] = useState<DatabaseResult | null>(null);
  const [metadata, setMetadata] = useState<DatabaseResult | null>(null);
  const [object, setObject] = useState<DatabaseObject | null>(null);
  const [tab, setTab] = useState<"query" | "object">("query");
  const [objectView, setObjectView] = useState<"data" | "columns">("data");
  const [objectResults, setObjectResults] = useState<{
    data: DatabaseResult | null;
    columns: DatabaseResult | null;
  }>({ data: null, columns: null });
  const [objectOffset, setObjectOffset] = useState(0);
  const [querying, setQuerying] = useState(false);
  const [browserWidth, setBrowserWidth] = useState(220);
  const [editorRatio, setEditorRatio] = useState(35);
  const [browserOpen, setBrowserOpen] = useState(true);
  const [showMessages, setShowMessages] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const queryPane = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [confirm, setConfirm] = useState<(() => Promise<void>) | null>(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [editor, setEditor] = useState<typeof import("./FileEditor") | null>(null);
  const controls = useRef<EditorView | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dirty = sql !== saved;
  useEffect(() => {
    if (initialPassword) setPassword(initialPassword);
  }, [initialPassword]);
  useEffect(() => {
    let disposed = false;
    void import("./FileEditor")
      .then((module) => {
        if (!disposed) setEditor(module);
      })
      .catch(() => setError(tx("编辑器加载失败，请重新打开工作台。")));
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    databaseStatus(config.id, { connected: !!handle, busy, dirty: dirty || pending });
    void invoke("database_guard", { id: config.id, dirty }).catch((reason) =>
      setError(databaseError(reason)),
    );
  }, [config.id, handle, busy, dirty, pending]);
  useEffect(() => {
    if (confirm) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirm]);
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
  }, []);
  function confirmAction(action: () => Promise<void>, message?: string) {
    setConfirmationText(
      message ??
        tx(
          "确认此数据库操作？写入、DDL 和事务操作可能立即影响服务器；未提交事务在断开时尝试回滚。",
        ),
    );
    setConfirm(() => action);
  }
  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    cancelled.current = false;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      if (mounted.current) setError(databaseError(cancelled.current ? "DB_CANCELLED" : reason));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function request(value: Record<string, unknown>): Promise<DatabaseResult> {
    if (!current.current) throw new Error("DB_DISCONNECTED");
    const requestedHandle = current.current;
    try {
      const result = await invoke<DatabaseResult>("database_request", {
        handle: requestedHandle,
        request: value,
      });
      if (!mounted.current || current.current !== requestedHandle) throw new Error("DB_CANCELLED");
      return result;
    } catch (reason) {
      if (/DB_(TIMEOUT|DISCONNECTED)/.test(String(reason))) {
        try {
          await invoke("database_disconnect", { handle: requestedHandle, discard: true });
        } finally {
          if (mounted.current && current.current === requestedHandle) {
            clearConnection();
          }
        }
      }
      throw reason;
    }
  }
  function clearConnection() {
    current.current = null;
    setHandle(null);
    setPending(false);
    setWritable(false);
    setResult(null);
    setMetadata(null);
    setExecuted("");
    setOffset(0);
    setObject(null);
    setObjectResults({ data: null, columns: null });
    setTab("query");
  }
  async function connect() {
    const result = await invoke<{ handle: string; info: { version: string } }>("database_connect", {
      config,
      password: password || null,
    });
    if (!mounted.current) {
      await invoke("database_disconnect", { handle: result.handle, discard: true });
      return;
    }
    current.current = result.handle;
    setHandle(result.handle);
    setInfo(result.info.version);
    setPassword("");
    setWritable(false);
    setPending(false);
    setMetadata(await request({ op: "browse", view: "catalogs" }));
  }
  async function disconnect(discard: boolean) {
    if (current.current) await invoke("database_disconnect", { handle: current.current, discard });
    clearConnection();
  }
  async function exportSql() {
    const copied = sql;
    if (await invoke<boolean>("database_export_sql", { sql: copied })) setSaved(copied);
  }
  async function query(at = 0, text = sql) {
    setQuerying(true);
    try {
      if (writable) setPending(true);
      const value = await request({ op: "query", sql: text, offset: at });
      setResult(value);
      setExecuted(text);
      setOffset(at);
    } finally {
      setQuerying(false);
    }
  }
  async function browseTable(target: DatabaseObject, view: "data" | "columns", at = 0) {
    const value = await request({
      op: "browse",
      view,
      catalog: target.catalog,
      schema: target.schema,
      table: target.name,
      offset: at,
    });
    setObject(target);
    setTab("object");
    setObjectView(view);
    setObjectResults((previous) => ({
      ...(object === target ? previous : { data: null, columns: null }),
      [view]: value,
    }));
    if (view === "data") setObjectOffset(at);
  }
  function generate(target: DatabaseObject) {
    const text = databaseSelect(config.kind, target);
    const apply = async () => {
      replaceSql(text);
      setTab("query");
    };
    if (dirty && text !== sql) confirmAction(apply, tx("替换当前 SQL？尚未保存的修改将被覆盖。"));
    else void apply();
  }
  // Recreate the shared editor after replacing SQL outside its user-input callback.
  // 程序替换 SQL 时更新文档标识，使共享编辑器与待执行 SQL 保持一致。
  function replaceSql(text: string) {
    setSql(text);
    setRevision((value) => value + 1);
  }
  const document: OpenFile = {
    id: revision,
    directory: "database",
    path: "query.sql",
    kind: "text",
    text: sql,
    saved,
    version: "",
    bom: false,
    line_ending: "\n",
    readonly: false,
    notice: null,
    jump: 0,
  };
  const visibleResult = tab === "query" ? result : objectResults[objectView];
  const visibleOffset = tab === "query" ? offset : objectOffset;
  const canPage = tab === "query" ? !!executed && !writable : objectView === "data";
  function page(at: number) {
    void run(() => (tab === "query" ? query(at, executed) : browseTable(object!, "data", at)));
  }
  const resizer = (axis: "browser" | "editor") => (
    <div
      role="separator"
      tabIndex={0}
      className={`database-resizer database-resizer-${axis}`}
      aria-label={axis === "browser" ? tx("调整对象浏览区宽度") : tx("调整 SQL 编辑区高度")}
      aria-orientation={axis === "browser" ? "vertical" : "horizontal"}
      aria-valuemin={axis === "browser" ? 150 : 15}
      aria-valuemax={axis === "browser" ? 360 : 75}
      aria-valuenow={axis === "browser" ? browserWidth : editorRatio}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        if (axis === "browser") {
          const rect = body.current?.getBoundingClientRect();
          if (rect)
            setBrowserWidth(
              Math.max(150, Math.min(360, rect.width * 0.45, event.clientX - rect.left)),
            );
        } else {
          const rect = queryPane.current?.getBoundingClientRect();
          const height = queryPane.current?.parentElement?.clientHeight;
          if (rect && height)
            setEditorRatio(Math.max(15, Math.min(75, ((event.clientY - rect.top) / height) * 100)));
        }
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        if (axis === "browser" && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
          event.preventDefault();
          setBrowserWidth((previous) =>
            Math.max(150, Math.min(360, previous + (event.key === "ArrowRight" ? 20 : -20))),
          );
        }
        if (axis === "editor" && ["ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          setEditorRatio((previous) =>
            Math.max(15, Math.min(75, previous + (event.key === "ArrowDown" ? 5 : -5))),
          );
        }
      }}
    />
  );
  return (
    <section
      className="database-workspace"
      style={
        {
          "--database-browser-width": `${browserWidth}px`,
          "--database-editor-ratio": `${editorRatio}%`,
        } as CSSProperties
      }
      hidden={!active}
      inert={!active}
      aria-label={tx("数据库工作台")}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          if (handle && !busy && tab === "query") {
            if (writable) confirmAction(() => query());
            else void run(() => query());
          }
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) void run(exportSql);
        }
      }}
    >
      <header className="redis-toolbar database-connection-bar">
        <button
          aria-label={tx("对象浏览区")}
          aria-expanded={browserOpen}
          onClick={() => setBrowserOpen((value) => !value)}
        >
          {tx("对象")}
        </button>
        <span>
          {databaseNames[config.kind]} · {config.host}:{config.port} {info}
        </span>
        <span className="database-access-state">{writable ? tx("允许写入") : tx("只读")}</span>
        {handle ? (
          <>
            <label>
              <input
                type="checkbox"
                checked={writable}
                disabled={!handle || busy || pending}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void run(async () => {
                    await request({ op: "writable", enabled });
                    setWritable(enabled);
                  });
                }}
              />
              {tx("允许编辑")}
            </label>
            {pending && (
              <span role="status" title={tx("事务待处理；DDL 可能自动提交。")}>
                {tx("事务已开启")}
              </span>
            )}
            {writable && (
              <>
                <button
                  disabled={!pending || busy}
                  onClick={() =>
                    confirmAction(async () => {
                      await request({ op: "commit" });
                      setPending(false);
                    })
                  }
                >
                  {tx("提交事务")}
                </button>
                <button
                  disabled={!pending || busy}
                  onClick={() =>
                    confirmAction(async () => {
                      await request({ op: "rollback" });
                      setPending(false);
                    })
                  }
                >
                  {tx("回滚事务")}
                </button>
              </>
            )}
            <button
              disabled={busy}
              onClick={() =>
                pending ? confirmAction(() => disconnect(true)) : void run(() => disconnect(false))
              }
            >
              {tx("断开")}
            </button>
          </>
        ) : (
          <>
            <input
              type="password"
              aria-label={tx("临时密码")}
              placeholder={config.credential_id ? tx("留空使用已保存密码") : tx("临时密码")}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button disabled={busy} onClick={() => void run(connect)}>
              {busy ? tx("正在连接…") : tx("连接")}
            </button>
          </>
        )}
      </header>
      {error && (
        <p role="alert" className="redis-error">
          {error}
        </p>
      )}
      <div className="database-body" ref={body}>
        <aside className="database-browser" hidden={!browserOpen}>
          <DatabaseObjects
            key={handle ?? "disconnected"}
            kind={config.kind}
            scopes={metadata}
            disabled={!handle || busy}
            load={request}
            perform={(action) => void run(action)}
            open={(target, view) => void run(() => browseTable(target, view))}
            generate={generate}
            refresh={() =>
              void run(async () => setMetadata(await request({ op: "browse", view: "catalogs" })))
            }
          />
        </aside>
        {browserOpen && resizer("browser")}
        <div className="database-content">
          <div className="database-view-tabs" role="tablist" aria-label={tx("数据库视图")}>
            <button role="tab" aria-selected={tab === "query"} onClick={() => setTab("query")}>
              {tx("SQL 查询")}
              {dirty ? " •" : ""}
            </button>
            {object && (
              <button
                role="tab"
                aria-selected={tab === "object"}
                title={[object.catalog, object.schema, object.name].filter(Boolean).join(".")}
                onClick={() => setTab("object")}
              >
                {object.name}
              </button>
            )}
          </div>
          <div className="database-query" hidden={tab !== "query"} ref={queryPane}>
            <div className="database-actions database-query-actions">
              <button
                className="database-run"
                disabled={!handle || busy}
                onClick={() => (writable ? confirmAction(() => query()) : void run(() => query()))}
              >
                {tx("执行 SQL")}
              </button>
              {querying && handle && (
                <button
                  title={tx("取消会关闭连接，写入结果可能未知。")}
                  onClick={() => {
                    cancelled.current = true;
                    void disconnect(true)
                      .then(() => setError(databaseError("DB_CANCELLED")))
                      .catch((reason) => setError(databaseError(reason)));
                  }}
                >
                  {tx("取消查询")}
                </button>
              )}
              <button disabled={busy} onClick={() => void run(exportSql)}>
                {tx("保存 SQL…")}
              </button>
              <details className="database-query-menu">
                <summary>{tx("更多")}</summary>
                <div>
                  <button
                    disabled={busy}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(sql)
                        .catch(() => setError(tx("无法复制 SQL。")));
                    }}
                  >
                    {tx("复制 SQL")}
                  </button>
                  <button
                    disabled={!dirty || busy}
                    onClick={() =>
                      confirmAction(
                        async () => replaceSql(saved),
                        tx("放弃 SQL 修改？这会恢复上次保存的 SQL 内容。"),
                      )
                    }
                  >
                    {tx("放弃 SQL 修改")}
                  </button>
                </div>
              </details>
            </div>
            <div className="database-sql-editor">
              {editor ? (
                <editor.CodeEditor
                  key={document.id}
                  document={document}
                  blocked={busy}
                  change={setSql}
                  save={() => void run(exportSql)}
                  close={() => {}}
                  controls={controls}
                />
              ) : (
                <textarea
                  aria-label={tx("SQL 编辑器")}
                  value={sql}
                  disabled={busy}
                  onChange={(event) => setSql(event.target.value)}
                  maxLength={262144}
                />
              )}
            </div>
            {resizer("editor")}
          </div>
          {tab === "object" && object && (
            <div className="database-actions database-object-actions">
              <button
                aria-pressed={objectView === "data"}
                disabled={!handle || busy}
                onClick={() =>
                  objectResults.data
                    ? setObjectView("data")
                    : void run(() => browseTable(object, "data"))
                }
              >
                {tx("数据")}
              </button>
              <button
                aria-pressed={objectView === "columns"}
                disabled={!handle || busy}
                onClick={() =>
                  objectResults.columns
                    ? setObjectView("columns")
                    : void run(() => browseTable(object, "columns"))
                }
              >
                {tx("结构")}
              </button>
              <button
                disabled={!handle || busy}
                onClick={() =>
                  void run(() =>
                    browseTable(object, objectView, objectView === "data" ? objectOffset : 0),
                  )
                }
              >
                {tx("刷新")}
              </button>
              <button disabled={busy} onClick={() => generate(object)}>
                {tx("生成 SELECT")}
              </button>
              <span>{tx("只读浏览")}</span>
            </div>
          )}
          <div className="database-result-tabs" role="tablist" aria-label={tx("查询输出")}>
            <button role="tab" aria-selected={!showMessages} onClick={() => setShowMessages(false)}>
              {tx("结果")}
            </button>
            <button role="tab" aria-selected={showMessages} onClick={() => setShowMessages(true)}>
              {tx("消息")}
            </button>
          </div>
          <div className="database-grid-container" hidden={showMessages}>
            <DatabaseGrid result={visibleResult} report={setError} />
          </div>
          <div className="database-output-message" hidden={!showMessages} role="status">
            {error ||
              (visibleResult?.affected !== undefined
                ? tx("受影响行数：{count}", { count: visibleResult.affected })
                : visibleResult
                  ? tx("结果：{count} 行 · {elapsed} 毫秒", {
                      count: visibleResult.rows?.length ?? 0,
                      elapsed: visibleResult.elapsed ?? 0,
                    })
                  : tx("执行 SQL 或打开表查看数据"))}
          </div>
          <footer className="database-actions database-result-footer">
            <span>
              {visibleResult
                ? tx("结果：{count} 行 · {elapsed} 毫秒", {
                    count: visibleResult.rows?.length ?? visibleResult.affected ?? 0,
                    elapsed: visibleResult.elapsed ?? 0,
                  })
                : tx("就绪")}
            </span>
            {visibleResult?.more && <span>{tx("还有更多数据")}</span>}
            <button
              disabled={!handle || busy || visibleOffset === 0 || !canPage}
              onClick={() => page(Math.max(0, visibleOffset - 200))}
            >
              {tx("上一页")}
            </button>
            <button
              disabled={
                !handle || busy || !visibleResult?.more || !canPage || visibleOffset >= 10000
              }
              onClick={() => page(visibleOffset + 200)}
            >
              {tx("下一页")}
            </button>
          </footer>
        </div>
      </div>
      <dialog
        ref={dialog}
        className="database-confirm-dialog"
        onCancel={(event) => {
          event.preventDefault();
          setConfirm(null);
        }}
      >
        <p>{confirmationText}</p>
        <button onClick={() => setConfirm(null)}>{tx("取消")}</button>
        <button
          onClick={() => {
            const action = confirm;
            setConfirm(null);
            if (action) void run(action);
          }}
        >
          {tx("确认")}
        </button>
      </dialog>
    </section>
  );
}
