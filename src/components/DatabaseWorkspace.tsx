import { createRef, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DatabaseGrid } from "./DatabaseGrid";
import { DocumentWorkspace } from "./DocumentWorkspace";
import { ToolbarIcon } from "./SidebarIcon";
import { DatabaseObjects } from "./DatabaseObjects";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { history as editorHistory, isolateHistory } from "@codemirror/commands";
import {
  sql as sqlLanguage,
  MySQL,
  PostgreSQL,
  PLSQL,
  type SQLNamespace,
} from "@codemirror/lang-sql";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import {
  databaseError,
  isDocumentDatabase,
  databaseNames,
  databaseStatus,
  databaseSelect,
  type DatabaseObject,
  type DatabaseConfig,
  type DatabaseResult,
  type DatabaseChange,
  type DatabaseFilter,
} from "../lib/database";
import { sqlExecution, formatDatabaseSql, type SqlStatement } from "../lib/database-sql";
import {
  databaseChangeCell,
  databaseDraftRows,
  databaseExport,
  databasePreview,
} from "../lib/database-data";
import type { OpenFile } from "../lib/file-document";

interface QueryResult {
  sql: string;
  value: DatabaseResult;
  from: number;
  weight: number;
}
interface QueryTab {
  id: number;
  sql: string;
  saved: string;
  executed: string;
  revision: number;
  result: DatabaseResult | null;
  offset: number;
  results: QueryResult[];
  errorAt?: number;
  error?: string;
}
interface QueryHistory {
  id: number;
  sql: string;
  elapsed: number;
  failed: boolean;
}
const emptyQuery = (id: number, text: string): QueryTab => ({
  id,
  sql: text,
  saved: text,
  executed: "",
  revision: 1,
  result: null,
  offset: 0,
  results: [],
});
function resultWeight(result: DatabaseResult) {
  let size = 0;
  for (const row of result.rows ?? [])
    for (const value of row)
      size += typeof value === "string" ? value.length : value === null ? 4 : value.binary.length;
  return size;
}

export function DatabaseWorkspace(props: {
  config: DatabaseConfig;
  active: boolean;
  password: string;
}) {
  return isDocumentDatabase(props.config.kind) ? (
    <DocumentWorkspace {...props} />
  ) : (
    <SqlDatabaseWorkspace {...props} />
  );
}

function SqlDatabaseWorkspace({
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
  const initialSql = config.kind === "oracle" ? "SELECT 1 FROM DUAL" : "SELECT 1";
  const [queries, setQueries] = useState<QueryTab[]>(() => [emptyQuery(1, initialSql)]);
  const [queryId, setQueryId] = useState(1);
  const nextQueryId = useRef(2);
  const queryControls = useRef(new Map([[1, createRef<EditorView>()]]));
  const activeQuery = queries.find((query) => query.id === queryId)!;
  const { sql, saved, executed, revision, result, offset } = activeQuery;
  const patchQuery = (id: number, patch: Partial<QueryTab>) =>
    setQueries((previous) =>
      previous.map((query) => (query.id === id ? { ...query, ...patch } : query)),
    );
  const setSaved = (saved: string) => patchQuery(queryId, { saved });
  const [scope, setScope] = useState<"auto" | "selection" | "current" | "all">("auto");
  const [history, setHistory] = useState<QueryHistory[]>([]);
  const historyDialog = useRef<HTMLDialogElement>(null);
  const [completion, setCompletion] = useState<SQLNamespace>(Object.create(null));
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const cancelled = useRef(false);
  const [pending, setPending] = useState(false);
  const [writable, setWritable] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [metadata, setMetadata] = useState<DatabaseResult | null>(null);
  const [object, setObject] = useState<DatabaseObject | null>(null);
  const [tab, setTab] = useState<"query" | "object">("query");
  const [objectView, setObjectView] = useState<"data" | "columns">("data");
  const [objectResults, setObjectResults] = useState<{
    data: DatabaseResult | null;
    columns: DatabaseResult | null;
  }>({ data: null, columns: null });
  const [objectOffset, setObjectOffset] = useState(0);
  const [filters, setFilters] = useState<DatabaseFilter[]>([]);
  const [filterColumn, setFilterColumn] = useState("");
  const [filterOperator, setFilterOperator] = useState<DatabaseFilter["operator"]>("eq");
  const [filterValue, setFilterValue] = useState("");
  const [changes, setChanges] = useState<DatabaseChange[]>([]);
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const changeId = useRef(1);
  const [transactionView, setTransactionView] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [browserWidth, setBrowserWidth] = useState(220);
  const [editorRatio, setEditorRatio] = useState(35);
  const [browserOpen, setBrowserOpen] = useState(true);
  const [showMessages, setShowMessages] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const queryPane = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState<(() => Promise<void>) | null>(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [confirmationSql, setConfirmationSql] = useState("");
  const [confirmationLabel, setConfirmationLabel] = useState("");
  const [editor, setEditor] = useState<typeof import("./FileEditor") | null>(null);
  const controls = queryControls.current.get(queryId)!;
  const dialog = useRef<HTMLDialogElement>(null);
  const dirty = sql !== saved;
  const executeKey = useRef((_all: boolean) => {});
  executeKey.current = (all) => {
    if (handle && !busy && tab === "query") executeScope(all ? "all" : "auto");
  };
  const hasDrafts = queries.some((query) => query.sql !== query.saved) || changes.length > 0;
  const syntax = useMemo(
    () => [
      sqlLanguage({
        dialect:
          config.kind === "mysql" ? MySQL : config.kind === "postgresql" ? PostgreSQL : PLSQL,
        schema: completion,
        defaultSchema: config.database,
        upperCaseKeywords: true,
      }),
      editorHistory({ minDepth: 20 }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              executeKey.current(false);
              return true;
            },
          },
          {
            key: "Mod-Shift-Enter",
            run: () => {
              executeKey.current(true);
              return true;
            },
          },
        ]),
      ),
      EditorState.transactionFilter.of((transaction) => {
        if (transaction.newDoc.length <= 262144) return transaction;
        queueMicrotask(() => setError(tx("SQL 超过 262,144 字符限制。")));
        return [];
      }),
    ],
    [config.kind, config.database, completion],
  );
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
    databaseStatus(config.id, { connected: !!handle, busy, dirty: hasDrafts || pending });
    void invoke("database_guard", { id: config.id, dirty: hasDrafts }).catch((reason) =>
      setError(databaseError(reason)),
    );
  }, [config.id, handle, busy, hasDrafts, pending]);
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
  function confirmAction(
    action: () => Promise<void>,
    message?: string,
    preview = "",
    label = tx("确认"),
  ) {
    setConfirmationSql(preview);
    setConfirmationLabel(label);
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
      if (/DB_(TIMEOUT|DISCONNECTED|WRITE_UNKNOWN)/.test(String(reason))) {
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
    setQueries((previous) =>
      previous.map((query) => ({ ...query, result: null, results: [], executed: "", offset: 0 })),
    );
    setMetadata(null);
    setCompletion(Object.create(null));
    if (!changesRef.current.length) {
      setObject(null);
      setObjectResults({ data: null, columns: null });
      setTab("query");
    }
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
      patchQuery(queryId, { result: value, executed: text, offset: at });
    } finally {
      setQuerying(false);
    }
  }
  async function browseTable(
    target: DatabaseObject,
    view: "data" | "columns",
    at = 0,
    nextFilters: DatabaseFilter[] = filters,
    ownTransaction = false,
  ) {
    if (ownTransaction && writable && view === "data") setPending(true);
    const value = await request({
      op: ownTransaction && view === "data" ? "table" : "browse",
      view: view === "data" ? "table" : view,
      catalog: target.catalog,
      schema: target.schema,
      table: target.name,
      offset: at,
      filters: nextFilters,
    });
    setObject(target);
    setTab("object");
    setObjectView(view);
    if (view === "data") {
      setFilters(nextFilters);
      setTransactionView(ownTransaction);
      if (ownTransaction && writable) setPending(true);
    }
    setObjectResults((previous) => ({
      ...(object &&
      object.catalog === target.catalog &&
      object.schema === target.schema &&
      object.name === target.name
        ? previous
        : { data: null, columns: null }),
      [view]: value,
    }));
    if (view === "data") setObjectOffset(at);
    if (value.table)
      updateCompletion(target.catalog || target.schema, [
        { ...target, fields: value.table.columns.map((column) => column.name) },
      ]);
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
    patchQuery(queryId, {
      sql: text,
      revision: revision + 1,
      error: undefined,
      errorAt: undefined,
    });
  }
  function updateCompletion(
    namespace: string,
    objects: (DatabaseObject & { fields?: string[] })[],
  ) {
    setCompletion((previous) => {
      const root = previous as Record<string, Record<string, string[]>>;
      const group: Record<string, string[]> = Object.assign(
        Object.create(null),
        objects.some((target) => target.fields !== undefined) ? (root[namespace] ?? {}) : {},
      );
      for (const target of objects.slice(0, 500))
        group[target.name] = target.fields ?? root[namespace]?.[target.name] ?? [];
      return Object.assign(
        Object.create(null),
        Object.fromEntries(
          Object.entries(root)
            .filter(([name]) => name !== namespace)
            .slice(-7),
        ),
        { [namespace]: group },
      );
    });
  }
  function addQuery() {
    if (queries.length >= 8) {
      setError(tx("最多打开八个查询标签，请先关闭一个标签。"));
      return;
    }
    const id = nextQueryId.current++;
    queryControls.current.set(id, createRef<EditorView>());
    setQueries((previous) => [...previous, emptyQuery(id, initialSql)]);
    setQueryId(id);
    setTab("query");
  }
  function closeQuery(id: number) {
    const target = queries.find((query) => query.id === id);
    if (!target || queries.length === 1 || busy) return;
    const close = async () => {
      const remaining = queries.filter((query) => query.id !== id);
      setQueries(remaining);
      queryControls.current.delete(id);
      if (queryId === id) setQueryId(remaining[0].id);
    };
    if (target.sql !== target.saved) confirmAction(close, tx("关闭此查询标签并放弃未保存的 SQL？"));
    else void close();
  }
  async function executeStatements(statements: SqlStatement[]) {
    if (!statements.length) throw new Error("DB_SQL_EMPTY");
    if (!writable && statements.some((statement) => !statement.readonly))
      throw new Error("DB_READ_ONLY");
    const id = queryId;
    patchQuery(id, { results: [], error: undefined, errorAt: undefined });
    setShowMessages(false);
    setQuerying(true);
    try {
      for (const statement of statements) {
        const executionSql: string = JSON.parse(JSON.stringify(statement.sql));
        const start = performance.now();
        let failed = false;
        try {
          if (writable) setPending(true);
          const value = await request({ op: "query", sql: executionSql, offset: 0 });
          const weight = resultWeight(value);
          if (value.pending !== undefined) setPending(value.pending);
          setQueries((previous) =>
            previous.map((query) => {
              if (query.id !== id) return query;
              const results = [
                ...query.results,
                { sql: executionSql, value, from: statement.from, weight },
              ].slice(-4);
              while (
                results.length > 1 &&
                results.reduce((size, item) => size + item.weight, 0) > 2097152
              )
                results.shift();
              return { ...query, results, result: value, executed: statement.sql, offset: 0 };
            }),
          );
        } catch (reason) {
          failed = true;
          const code = String(reason);
          const position = /:POSITION:(\d+)/.exec(code);
          const line = /:LINE:(\d+)/.exec(code);
          let at = statement.from;
          if (position)
            at += Array.from(statement.sql)
              .slice(0, Math.max(0, Number(position[1]) - 1))
              .join("").length;
          else if (line)
            at += statement.sql
              .split("\n")
              .slice(0, Math.max(0, Number(line[1]) - 1))
              .reduce((size, value) => size + value.length + 1, 0);
          patchQuery(id, { error: databaseError(reason), errorAt: Math.min(sql.length, at) });
          throw reason;
        } finally {
          const entry = {
            id: Date.now(),
            sql: executionSql,
            elapsed: Math.round(performance.now() - start),
            failed,
          };
          setHistory((previous) => {
            let size = 0;
            return [entry, ...previous].slice(0, 50).filter((item) => {
              size += item.sql.length;
              return size <= 262144;
            });
          });
        }
      }
    } finally {
      setQuerying(false);
    }
  }
  function executeScope(selectedScope = scope) {
    try {
      const selection = controls.current?.state.selection.main;
      const from = selection?.from ?? 0,
        to = selection?.to ?? from;
      const selected =
        selectedScope === "auto" ? (from === to ? "current" : "selection") : selectedScope;
      const statements = sqlExecution(
        sql,
        config.kind,
        selected,
        selected === "current" ? (selection?.head ?? 0) : from,
        to,
      );
      if (!statements.length) {
        setError(tx("没有可执行的 SQL，请选择语句或输入查询。"));
        return;
      }
      const action = () => executeStatements(statements);
      if (writable)
        confirmAction(
          action,
          tx("确认执行 {count} 条 SQL？所有查询标签共享此连接及事务，DDL 可能自动提交。", {
            count: statements.length,
          }),
          statements.map((statement) => statement.sql).join(";\n\n"),
        );
      else void run(action);
    } catch (reason) {
      setError(databaseError(reason));
    }
  }
  function formatSql() {
    try {
      const view = controls.current;
      if (!view) return;
      const selection = view.state.selection.main;
      const from = selection.empty ? 0 : selection.from,
        to = selection.empty ? view.state.doc.length : selection.to;
      view.dispatch({
        changes: {
          from,
          to,
          insert: formatDatabaseSql(view.state.doc.sliceString(from, to), config.kind),
        },
        annotations: isolateHistory.of("full"),
      });
    } catch (reason) {
      setError(databaseError(reason));
    }
  }
  function jumpToError() {
    const view = controls.current;
    if (!view || activeQuery.errorAt === undefined) return;
    const at = Math.min(view.state.doc.length, activeQuery.errorAt);
    view.dispatch({
      selection: { anchor: at },
      effects: EditorView.scrollIntoView(at, { y: "center" }),
    });
    view.focus();
  }
  function acceptChanges(next: DatabaseChange[]) {
    if (next.length > 100 || new TextEncoder().encode(JSON.stringify(next)).length > 786432)
      throw new Error("DB_INPUT_LIMIT");
    changesRef.current = next;
    setChanges(next);
  }
  function changeCell(row: number, column: number, value: string | null) {
    if (!objectResults.data || !writable || busy) return;
    acceptChanges(
      databaseChangeCell(
        objectResults.data,
        changesRef.current,
        row,
        column,
        value,
        changeId.current++,
      ),
    );
  }
  function removeRow(row: number) {
    const result = objectResults.data;
    if (!result || !writable || busy) return;
    const entry = databaseDraftRows(result, changesRef.current)[row];
    if (!entry) return;
    if (entry.change?.kind === "insert")
      acceptChanges(changesRef.current.filter((change) => change.id !== entry.change!.id));
    else if (entry.change?.kind === "delete")
      acceptChanges(
        Object.keys(entry.change.values).length
          ? changesRef.current.map((change) =>
              change.id === entry.change!.id ? { ...change, kind: "update" } : change,
            )
          : changesRef.current.filter((change) => change.id !== entry.change!.id),
      );
    else {
      if (result.partial?.some((cell) => cell[0] === row)) {
        setError(tx("此行包含截断值，无法安全编辑或删除。"));
        return;
      }
      acceptChanges([
        ...changesRef.current.filter((change) => change.row !== row),
        {
          id: entry.change?.id ?? changeId.current++,
          kind: "delete",
          row,
          original: result.rows?.[row],
          values: entry.change?.values ?? {},
        },
      ]);
    }
  }
  function openObject(target: DatabaseObject, view: "data" | "columns") {
    const action = async () => {
      acceptChanges([]);
      await browseTable(target, view, 0, []);
    };
    if (changesRef.current.length)
      confirmAction(action, tx("切换表将放弃尚未应用的表格修改，是否继续？"));
    else void run(action);
  }
  async function previewChanges() {
    if (!object || !objectResults.data?.table || !changesRef.current.length || !writable) return;
    const payload = {
      catalog: object.catalog,
      schema: object.schema,
      table: object.name,
      signature: objectResults.data.table.signature,
      changes: changesRef.current,
      offset: objectOffset,
      filters,
    };
    setPending(true);
    const preview = await request({ op: "preview", ...payload });
    confirmAction(
      async () => {
        const value = await request({ op: "apply", ...payload });
        setObjectResults((previous) => ({ ...previous, data: value }));
        acceptChanges([]);
        setTransactionView(true);
        setPending(true);
      },
      tx("将这些修改应用到当前事务？应用后仍需显式提交；冲突会保留草稿，不会自动重试。"),
      databasePreview(preview),
      tx("应用到事务"),
    );
  }
  async function exportResults(format: "csv" | "json") {
    if (!visibleResult || (changesRef.current.length && tab === "object")) return;
    await invoke("database_export_result", { format, data: databaseExport(visibleResult, format) });
  }
  async function explain() {
    const selection = controls.current?.state.selection.main;
    const statements = sqlExecution(
      sql,
      config.kind,
      selection && !selection.empty ? "selection" : "current",
      selection?.from ?? 0,
      selection?.to,
    );
    if (statements.length !== 1 || !statements[0].readonly) throw new Error("DB_READ_ONLY");
    if (writable) setPending(true);
    const value = await request({ op: "explain", sql: statements[0].sql });
    patchQuery(queryId, { result: value, executed: "", offset: 0, results: [] });
    if (value.pending !== undefined) setPending(value.pending);
    setShowMessages(false);
  }
  async function settleTransaction(operation: "commit" | "rollback") {
    await request({ op: operation });
    setPending(false);
    if (transactionView && object && !changesRef.current.length)
      await browseTable(object, "data", objectOffset, filters, false);
  }
  const latestObjects = useRef({ request, run, openObject, generate, updateCompletion });
  latestObjects.current = { request, run, openObject, generate, updateCompletion };
  const objectActions = useMemo(
    () => ({
      load: (value: Record<string, unknown>) => latestObjects.current.request(value),
      perform: (action: () => Promise<void>) => void latestObjects.current.run(action),
      open: (target: DatabaseObject, view: "data" | "columns") =>
        latestObjects.current.openObject(target, view),
      generate: (target: DatabaseObject) => latestObjects.current.generate(target),
      loaded: (namespace: string, objects: DatabaseObject[]) =>
        latestObjects.current.updateCompletion(namespace, objects),
      refresh: () =>
        void latestObjects.current.run(async () => {
          setCompletion(Object.create(null));
          setMetadata(await latestObjects.current.request({ op: "browse", view: "catalogs" }));
        }),
    }),
    [],
  );
  useEffect(() => {
    if (tab === "query") {
      controls.current?.requestMeasure();
      controls.current?.focus();
    }
  }, [queryId, tab, controls]);
  const queryDocument = (query: QueryTab): OpenFile => ({
    id: query.revision,
    directory: "database",
    path: `query-${query.id}.sql`,
    kind: "text",
    text: query.sql,
    saved: query.saved,
    version: "",
    bom: false,
    line_ending: "\n",
    readonly: false,
    notice: null,
    jump: 0,
  });
  const visibleResult = tab === "query" ? result : objectResults[objectView];
  const visibleOffset = tab === "query" ? offset : objectOffset;
  const canPage = tab === "query" ? !!executed && !writable : objectView === "data";
  function page(at: number) {
    void run(() =>
      tab === "query"
        ? query(at, executed)
        : browseTable(object!, "data", at, filters, transactionView && writable),
    );
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
        if (event.defaultPrevented) return;
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
        if (event.defaultPrevented) return;
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          if (handle && !busy && tab === "query") {
            executeScope(event.shiftKey ? "all" : "auto");
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
        {handle && (
          <span className="database-session-scope" title={tx("所有查询标签共享此连接及事务")}>
            {tx("共享事务")}
          </span>
        )}
        {handle ? (
          <>
            <label>
              <input
                type="checkbox"
                checked={writable}
                disabled={!handle || busy || pending || (writable && changes.length > 0)}
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
                  onClick={() => confirmAction(() => settleTransaction("commit"))}
                >
                  {tx("提交事务")}
                </button>
                <button
                  disabled={!pending || busy}
                  onClick={() => confirmAction(() => settleTransaction("rollback"))}
                >
                  {tx("回滚事务")}
                </button>
              </>
            )}
            <button
              disabled={busy}
              onClick={() =>
                changes.length
                  ? confirmAction(async () => {
                      acceptChanges([]);
                      await disconnect(true);
                    }, tx("断开连接并放弃尚未应用的表格修改？未提交的事务将尝试回滚。"))
                  : pending
                    ? confirmAction(() => disconnect(true))
                    : void run(() => disconnect(false))
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
          {tab === "query" && activeQuery.errorAt !== undefined && (
            <button onClick={jumpToError}>{tx("定位失败语句")}</button>
          )}
        </p>
      )}
      <div className="database-body" ref={body}>
        <aside className="database-browser" hidden={!browserOpen}>
          <DatabaseObjects
            visible={active && browserOpen}
            key={handle ?? "disconnected"}
            kind={config.kind}
            scopes={metadata}
            disabled={!handle || busy}
            {...objectActions}
          />
        </aside>
        {browserOpen && resizer("browser")}
        <div className="database-content">
          <div className="database-view-tabs" role="tablist" aria-label={tx("数据库视图")}>
            {queries.map((query) => (
              <div className="database-query-tab" key={query.id}>
                <button
                  role="tab"
                  aria-selected={tab === "query" && query.id === queryId}
                  disabled={busy}
                  onClick={() => {
                    setQueryId(query.id);
                    setTab("query");
                    setError(query.error ?? "");
                  }}
                >
                  {query.id === 1 ? tx("SQL 查询") : tx("查询 {number}", { number: query.id })}
                  {query.sql !== query.saved ? " •" : ""}
                </button>
                {queries.length > 1 && (
                  <button
                    aria-label={tx("关闭查询 {number}", { number: query.id })}
                    disabled={busy}
                    onClick={() => closeQuery(query.id)}
                  >
                    <ToolbarIcon name="close" />
                  </button>
                )}
              </div>
            ))}
            <button
              aria-label={tx("新建查询")}
              disabled={busy || queries.length >= 8}
              onClick={addQuery}
            >
              +
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
                onClick={() => executeScope()}
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
              <select
                aria-label={tx("执行范围")}
                value={scope}
                disabled={busy}
                onChange={(event) => setScope(event.target.value as typeof scope)}
              >
                <option value="auto">{tx("当前语句或选区")}</option>
                <option value="current">{tx("当前语句")}</option>
                <option value="selection">{tx("选中语句")}</option>
                <option value="all">{tx("全部语句")}</option>
              </select>
              <button disabled={busy} onClick={formatSql}>
                {tx("格式化 SQL")}
              </button>
              <button
                disabled={!handle || busy}
                title={
                  config.kind === "oracle"
                    ? tx("Oracle 需开启编辑，并具备 PLAN_TABLE 与 DBMS_XPLAN 权限。")
                    : undefined
                }
                onClick={() => void run(explain)}
              >
                {tx("执行计划")}
              </button>
              <button onClick={() => historyDialog.current?.showModal()}>{tx("查询历史")}</button>
            </div>
            {queries.map((query) => (
              <div className="database-sql-editor" key={query.id} hidden={query.id !== queryId}>
                {editor ? (
                  <editor.CodeEditor
                    key={query.revision}
                    document={queryDocument(query)}
                    blocked={busy}
                    syntax={syntax}
                    change={(text) =>
                      patchQuery(query.id, { sql: text, error: undefined, errorAt: undefined })
                    }
                    save={() => void run(exportSql)}
                    close={() => {}}
                    controls={queryControls.current.get(query.id)!}
                  />
                ) : (
                  <textarea
                    aria-label={tx("SQL 编辑器")}
                    value={query.sql}
                    disabled={busy}
                    onChange={(event) => patchQuery(query.id, { sql: event.target.value })}
                    maxLength={262144}
                  />
                )}
              </div>
            ))}
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
                disabled={!handle || busy || changes.length > 0}
                onClick={() =>
                  void run(() =>
                    browseTable(
                      object,
                      objectView,
                      objectView === "data" ? objectOffset : 0,
                      filters,
                      writable && pending,
                    ),
                  )
                }
              >
                {tx("刷新")}
              </button>
              <button disabled={busy} onClick={() => generate(object)}>
                {tx("生成 SELECT")}
              </button>
              <span>{transactionView ? tx("当前事务数据") : tx("只读浏览")}</span>
              {objectResults.data?.table?.editable && (writable || changes.length > 0) && (
                <>
                  <button
                    disabled={!handle || !writable || busy || !changes.length}
                    onClick={() => void run(previewChanges)}
                  >
                    {tx("预览表格修改")}
                  </button>
                  <button
                    disabled={busy || !changes.length}
                    onClick={() =>
                      confirmAction(
                        async () => acceptChanges([]),
                        tx("放弃尚未应用的表格修改？已应用到事务的写入需使用回滚事务。"),
                      )
                    }
                  >
                    {tx("放弃表格修改")}
                  </button>
                </>
              )}
            </div>
          )}
          {tab === "object" && objectView === "data" && objectResults.data?.table && (
            <div className="database-table-filter">
              <strong>{tx("服务端筛选")}</strong>
              <select
                aria-label={tx("筛选字段")}
                value={filterColumn}
                disabled={busy}
                onChange={(event) => setFilterColumn(event.target.value)}
              >
                <option value="">{tx("选择字段")}</option>
                {objectResults.data.table.columns.map((column) => (
                  <option key={column.name}>{column.name}</option>
                ))}
              </select>
              <select
                aria-label={tx("筛选条件")}
                value={filterOperator}
                disabled={busy}
                onChange={(event) =>
                  setFilterOperator(event.target.value as DatabaseFilter["operator"])
                }
              >
                <option value="eq">=</option>
                <option value="contains">{tx("包含")}</option>
                <option value="gt">&gt;</option>
                <option value="lt">&lt;</option>
                <option value="null">{tx("为空")}</option>
                <option value="notnull">{tx("非空")}</option>
              </select>
              <input
                aria-label={tx("筛选值")}
                value={filterValue}
                maxLength={1024}
                disabled={busy || ["null", "notnull"].includes(filterOperator)}
                onChange={(event) => setFilterValue(event.target.value)}
              />
              <button
                disabled={busy || !filterColumn || changes.length > 0}
                onClick={() =>
                  void run(() =>
                    browseTable(
                      object!,
                      "data",
                      0,
                      [{ column: filterColumn, operator: filterOperator, value: filterValue }],
                      transactionView && writable,
                    ),
                  )
                }
              >
                {tx("应用筛选")}
              </button>
              <button
                disabled={busy || !filters.length || changes.length > 0}
                onClick={() =>
                  void run(() => browseTable(object!, "data", 0, [], transactionView && writable))
                }
              >
                {tx("清除筛选")}
              </button>
              {!objectResults.data.table.editable && (
                <span>{tx("此表缺少可靠主键、包含不支持的列类型，或不支持事务；保持只读。")}</span>
              )}
            </div>
          )}
          <div className="database-result-tabs" role="tablist" aria-label={tx("查询输出")}>
            <button role="tab" aria-selected={!showMessages} onClick={() => setShowMessages(false)}>
              {tx("结果")}
            </button>
            {tab === "query" && activeQuery.results.length > 1 && (
              <select
                aria-label={tx("选择语句结果")}
                value={Math.max(
                  0,
                  activeQuery.results.findIndex((item) => item.value === result),
                )}
                onChange={(event) => {
                  const item = activeQuery.results[Number(event.target.value)];
                  patchQuery(queryId, { result: item.value, executed: item.sql, offset: 0 });
                }}
              >
                {activeQuery.results.map((item, index) => (
                  <option key={index} value={index}>
                    {index + 1} · {item.sql.slice(0, 60)}
                  </option>
                ))}
              </select>
            )}
            <button
              disabled={
                !visibleResult?.columns?.length || busy || (tab === "object" && changes.length > 0)
              }
              onClick={() => void run(() => exportResults("csv"))}
            >
              {tx("导出 CSV")}
            </button>
            <button
              disabled={
                !visibleResult?.columns?.length || busy || (tab === "object" && changes.length > 0)
              }
              onClick={() => void run(() => exportResults("json"))}
            >
              {tx("导出 JSON")}
            </button>
            <button role="tab" aria-selected={showMessages} onClick={() => setShowMessages(true)}>
              {tx("消息")}
            </button>
          </div>
          <div className="database-grid-container" hidden={showMessages}>
            <DatabaseGrid
              result={visibleResult}
              report={setError}
              changes={tab === "object" && objectView === "data" ? changes : undefined}
              editable={
                tab === "object" &&
                objectView === "data" &&
                writable &&
                !!objectResults.data?.table?.editable
              }
              busy={busy}
              change={tab === "object" ? changeCell : undefined}
              remove={
                tab === "object"
                  ? (row) => {
                      try {
                        removeRow(row);
                      } catch (reason) {
                        setError(databaseError(reason));
                      }
                    }
                  : undefined
              }
              add={
                tab === "object"
                  ? () => {
                      try {
                        acceptChanges([
                          ...changesRef.current,
                          { id: changeId.current++, kind: "insert", values: {} },
                        ]);
                      } catch (reason) {
                        setError(databaseError(reason));
                      }
                    }
                  : undefined
              }
            />
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
            {changes.length > 0 && tab === "object" && (
              <span>{tx("未应用修改：{count}", { count: changes.length })}</span>
            )}
            <button
              disabled={
                !handle ||
                busy ||
                visibleOffset === 0 ||
                !canPage ||
                (tab === "object" && changes.length > 0)
              }
              onClick={() => page(Math.max(0, visibleOffset - 200))}
            >
              {tx("上一页")}
            </button>
            <button
              disabled={
                !handle ||
                busy ||
                !visibleResult?.more ||
                !canPage ||
                visibleOffset >= 10000 ||
                (tab === "object" && changes.length > 0)
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
        {confirmationSql && <pre className="database-sql-preview">{confirmationSql}</pre>}
        <button onClick={() => setConfirm(null)}>{tx("取消")}</button>
        <button
          onClick={() => {
            const action = confirm;
            setConfirm(null);
            if (action) void run(action);
          }}
        >
          {confirmationLabel || tx("确认")}
        </button>
      </dialog>
      <dialog ref={historyDialog} className="database-history-dialog">
        <h3>{tx("查询历史（仅本次运行）")}</h3>
        <button onClick={() => setHistory([])}>{tx("清空历史")}</button>
        {history.map((entry, index) => (
          <button
            className="database-history-entry"
            key={`${entry.id}-${index}`}
            onClick={() => {
              historyDialog.current?.close();
              const apply = async () => replaceSql(entry.sql);
              if (dirty) confirmAction(apply, tx("替换当前 SQL？尚未保存的修改将被覆盖。"));
              else void apply();
            }}
          >
            <span>
              {new Date(entry.id).toLocaleTimeString()} · {entry.failed ? tx("失败") : tx("成功")} ·{" "}
              {tx("耗时：{elapsed} 毫秒", { elapsed: entry.elapsed })}
            </span>
            <pre>{entry.sql.slice(0, 2000)}</pre>
          </button>
        ))}
        {!history.length && <p>{tx("没有查询历史")}</p>}
        <button onClick={() => historyDialog.current?.close()}>{tx("关闭")}</button>
      </dialog>
    </section>
  );
}
