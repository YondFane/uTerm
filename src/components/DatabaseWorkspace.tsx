import { memo, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import {
  databaseError,
  databaseNames,
  databaseStatus,
  type DatabaseConfig,
  type DatabaseResult,
} from "../lib/database";
import type { OpenFile } from "../lib/file-document";
import { DatabaseComponents } from "./DatabaseComponents";

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
  const [scope, setScope] = useState("");
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
    setMetadata(await request({ op: "metadata", view: "catalogs" }));
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
    if (writable) setPending(true);
    const value = await request({ op: "query", sql: text, offset: at });
    setResult(value);
    setExecuted(text);
    setOffset(at);
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
  const quote = (value: string) => {
    const q = config.kind === "mysql" ? "`" : '"';
    return q + value.replaceAll(q, q + q) + q;
  };
  return (
    <section
      className="database-workspace"
      hidden={!active}
      inert={!active}
      aria-label={tx("数据库工作台")}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          if (handle && !busy) {
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
      <header className="redis-toolbar">
        <strong>{config.name}</strong>
        <span>
          {databaseNames[config.kind]} · {config.host}:{config.port} {info}
        </span>
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
      {!handle && active && (
        <details open>
          <summary>{tx("安装或管理连接组件")}</summary>
          <DatabaseComponents selectedKind={config.kind} />
        </details>
      )}
      <div className="database-body">
        <aside className="database-browser">
          <div className="database-actions">
            <button
              disabled={!handle || busy || pending}
              onClick={() =>
                void run(async () =>
                  setMetadata(await request({ op: "metadata", view: "catalogs" })),
                )
              }
            >
              {tx("库与模式")}
            </button>
            <button
              disabled={!handle || busy || pending}
              onClick={() =>
                void run(async () =>
                  setMetadata(
                    await request({
                      op: "metadata",
                      view: "tables",
                      catalog: config.kind === "mysql" ? scope : "",
                      schema: config.kind === "mysql" ? "" : scope,
                    }),
                  ),
                )
              }
            >
              {tx("表与视图")}
            </button>
          </div>
          <input
            aria-label={tx("库或模式")}
            value={scope}
            placeholder={tx("库或模式")}
            onChange={(event) => setScope(event.target.value)}
          />
          {metadata?.rows?.map((row, index) => {
            const indexOf = (name: string) =>
              metadata.columns?.findIndex((item) => item.name === name) ?? -1;
            const name = String(
              row[indexOf("TABLE_NAME")] ??
                row[indexOf("TABLE_SCHEM")] ??
                row[indexOf("TABLE_CAT")] ??
                row[0] ??
                "",
            );
            const table = indexOf("TABLE_NAME") >= 0;
            const catalog = String(row[indexOf("TABLE_CAT")] ?? "");
            const schema = String(row[indexOf("TABLE_SCHEM")] ?? "");
            return (
              <div className="database-browser-row" key={`${name}-${index}`}>
                <button
                  disabled={!handle || busy || pending}
                  onClick={() => {
                    if (!table) {
                      setScope(name);
                      void run(async () =>
                        setMetadata(
                          await request({
                            op: "metadata",
                            view: "tables",
                            catalog: config.kind === "mysql" ? name : "",
                            schema: config.kind === "mysql" ? "" : name,
                          }),
                        ),
                      );
                    } else {
                      const namespace = config.kind === "mysql" ? catalog : schema;
                      const text = `SELECT * FROM ${namespace ? quote(namespace) + "." : ""}${quote(name)}`;
                      if (dirty && text !== sql)
                        confirmAction(
                          async () => replaceSql(text),
                          tx("替换当前 SQL？尚未保存的修改将被覆盖。"),
                        );
                      else replaceSql(text);
                    }
                  }}
                >
                  {name}
                </button>
                {table && (
                  <button
                    disabled={!handle || busy || pending}
                    title={tx("查看字段")}
                    onClick={() =>
                      void run(async () => {
                        const value = await request({
                          op: "metadata",
                          view: "columns",
                          catalog,
                          schema,
                          table: name,
                        });
                        setExecuted("");
                        setOffset(0);
                        setResult(value);
                      })
                    }
                  >
                    {tx("字段")}
                  </button>
                )}
              </div>
            );
          })}
          {metadata?.more && <p>{tx("元数据超过 500 项，请缩小库或模式范围。")}</p>}
        </aside>
        <div className="database-query">
          <div className="database-actions">
            <button
              disabled={!handle || busy}
              onClick={() => (writable ? confirmAction(() => query()) : void run(() => query()))}
            >
              {tx("执行 SQL")}
            </button>
            {busy && handle && (
              <button
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
            <button
              disabled={busy}
              onClick={() => {
                void navigator.clipboard.writeText(sql).catch(() => setError(tx("无法复制 SQL。")));
              }}
            >
              {tx("复制 SQL")}
            </button>
            <button disabled={busy} onClick={() => void run(exportSql)}>
              {tx("保存 SQL…")}
            </button>
            <button
              disabled={!dirty || busy}
              onClick={() =>
                confirmAction(async () => {
                  replaceSql(saved);
                }, tx("放弃 SQL 修改？这会恢复上次保存的 SQL 内容。"))
              }
            >
              {tx("放弃 SQL 修改")}
            </button>
            {pending && <strong>{tx("事务待处理；DDL 可能自动提交。")}</strong>}
          </div>
          <div className="database-sql-editor">
            {editor ? (
              <editor.CodeEditor
                key={document.id}
                document={document}
                blocked={busy}
                change={setSql}
                save={() => {
                  void run(exportSql);
                }}
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
          <DatabaseResults result={result} />
          {result && (
            <footer className="database-actions">
              <span>
                {tx("结果：{count} 行 · {elapsed} 毫秒", {
                  count: result.rows?.length ?? result.affected ?? 0,
                  elapsed: result.elapsed ?? 0,
                })}
              </span>
              <button
                disabled={!handle || busy || offset === 0 || writable || !executed}
                onClick={() => void run(() => query(Math.max(0, offset - 200), executed))}
              >
                {tx("上一页")}
              </button>
              <button
                disabled={
                  !handle || busy || !result.more || writable || !executed || offset >= 10000
                }
                onClick={() => void run(() => query(offset + 200, executed))}
              >
                {tx("下一页")}
              </button>
            </footer>
          )}
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

const DatabaseResults = memo(function DatabaseResults({
  result,
}: {
  result: DatabaseResult | null;
}) {
  return (
    <div className="database-results">
      <table>
        <thead>
          <tr>
            {result?.columns?.map((column, index) => (
              <th key={index} title={column.type}>
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result?.rows?.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (
                <td key={column}>
                  {cell === null ? (
                    <em>{"NULL"}</em>
                  ) : typeof cell === "string" ? (
                    cell
                  ) : (
                    `${cell.binary}${cell.truncated ? " …" : ""}`
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
