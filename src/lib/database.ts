import { sshError } from "./file-target.ts";
import { downloadError } from "./download-error.ts";
import { tx } from "./i18n.ts";
import { validSshTarget, type SshTarget } from "./workspace.ts";

export const databaseKinds = ["mysql", "postgresql", "oracle", "elasticsearch", "mongodb"] as const;
export type DatabaseKind = (typeof databaseKinds)[number];
export const databaseNames: Record<DatabaseKind, string> = {
  mysql: "MySQL",
  postgresql: "PostgreSQL",
  oracle: "Oracle",
  elasticsearch: "Elasticsearch",
  mongodb: "MongoDB",
};
export const databasePorts: Record<DatabaseKind, number> = {
  mysql: 3306,
  postgresql: 5432,
  oracle: 1521,
  elasticsearch: 9200,
  mongodb: 27017,
};
export const isDocumentDatabase = (kind: DatabaseKind) =>
  kind === "elasticsearch" || kind === "mongodb";
export function databaseDependencies(kind?: DatabaseKind): string[] {
  if (!kind || kind === "elasticsearch") return [];
  return kind === "mongodb"
    ? ["runtime", "mongodb", "mongodb-core", "mongodb-bson"]
    : ["runtime", kind];
}
export interface DatabaseConfig {
  id: string;
  name: string;
  kind: DatabaseKind;
  host: string;
  port: number;
  database: string;
  username: string;
  tls: boolean;
  ca_file: string;
  ssh_target?: SshTarget;
  credential_id: string | null;
  auth_source?: string;
  auth_mode?: "basic" | "api_key";
}

/** Parses a host or root HTTP(S) URL into connection fields; rejects unsupported URL parts.
 * 将主机或根 HTTP(S) URL 解析为连接字段；拒绝不支持的 URL 部分。
 */
export function parseElasticsearchAddress(
  value: string,
): { host: string; port?: number; tls?: boolean } | null {
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  const address = value.trim();
  const match = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)(?::([0-9]+))?\/?$/i.exec(address);
  if (!match) {
    return validDatabaseHost(address) && !/^https?:/i.test(address) ? { host: address } : null;
  }
  try {
    const url = new URL(address);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const tls = url.protocol === "https:";
    const port = url.port ? Number(url.port) : tls ? 443 : 80;
    return validDatabaseHost(host) && port > 0 ? { host, port, tls } : null;
  } catch {
    return null;
  }
}

function validDatabaseHost(host: unknown): host is string {
  return (
    typeof host === "string" &&
    host.length <= 255 &&
    /^[a-zA-Z0-9_.:-]+$/.test(host) &&
    !host.startsWith("-")
  );
}
export interface DatabaseComponent {
  id: string;
  version: string;
  size: number;
  installed: boolean;
  external?: boolean;
  downloaded?: number;
  source: string;
}
export interface DatabaseComponents {
  items: DatabaseComponent[];
  java: string | null;
  busy: boolean;
}
export interface DatabaseResult {
  columns?: { name: string; type: string }[];
  rows?: (string | null | { binary: string; truncated: boolean })[][];
  more?: boolean;
  affected?: number;
  elapsed?: number;
  pending?: boolean;
  partial?: [number, number][];
  table?: DatabaseTable;
  applied?: number;
  preview?: { sql: string; parameters: (string | null)[] }[];
}
export interface DatabaseTable {
  columns: {
    name: string;
    jdbcType: number;
    nullable: boolean;
    generated: boolean;
    hasDefault: boolean;
    editable: boolean;
  }[];
  keys: string[];
  editable: boolean;
  signature: string;
  target: string;
}
export interface DatabaseChange {
  id: number;
  kind: "insert" | "update" | "delete";
  row?: number;
  original?: NonNullable<DatabaseResult["rows"]>[number];
  values: Record<string, string | null>;
}
export interface DatabaseFilter {
  column: string;
  operator: "eq" | "contains" | "gt" | "lt" | "null" | "notnull";
  value: string;
}
export interface DatabaseObject {
  name: string;
  catalog: string;
  schema: string;
  type: string;
}
export function databaseObjects(result: DatabaseResult): DatabaseObject[] {
  const at = (row: NonNullable<DatabaseResult["rows"]>[number], name: string) =>
    String(
      row[result.columns?.findIndex((column) => column.name.toUpperCase() === name) ?? -1] ?? "",
    );
  return (result.rows ?? []).map((row) => ({
    name: at(row, "TABLE_NAME") || at(row, "TABLE_SCHEM") || at(row, "TABLE_CAT"),
    catalog: at(row, "TABLE_CAT"),
    schema: at(row, "TABLE_SCHEM"),
    type: at(row, "TABLE_TYPE"),
  }));
}
export const databaseObjectKey = (object: DatabaseObject) =>
  JSON.stringify([object.catalog, object.schema, object.name]);
export function databaseSelect(kind: DatabaseKind, object: DatabaseObject) {
  const quote = kind === "mysql" ? "`" : '"';
  const name = (value: string) => quote + value.replaceAll(quote, quote + quote) + quote;
  const namespace = kind === "mysql" ? object.catalog : object.schema;
  return `SELECT * FROM ${namespace ? name(namespace) + "." : ""}${name(object.name)}`;
}
export function databaseCellText(cell: NonNullable<DatabaseResult["rows"]>[number][number]) {
  return cell === null
    ? "NULL"
    : typeof cell === "string"
      ? cell
      : cell.binary + (cell.truncated ? " …" : "");
}
export function databaseClipboard(
  result: DatabaseResult,
  range: [number, number, number, number],
  headers = false,
) {
  const [top, left, bottom, right] = range;
  const rows = (result.rows ?? [])
    .slice(top, bottom + 1)
    .map((row) => row.slice(left, right + 1).map(databaseCellText));
  if (headers)
    rows.unshift((result.columns ?? []).slice(left, right + 1).map((column) => column.name));
  return rows
    .map((row) =>
      row
        .map((cell) => (/[\t\r\n"]/.test(cell) ? '"' + cell.replaceAll('"', '""') + '"' : cell))
        .join("\t"),
    )
    .join("\n");
}
export interface DatabaseStatus {
  connected: boolean;
  busy: boolean;
  dirty: boolean;
}
let statuses: Record<string, DatabaseStatus> = {};
const listeners = new Set<() => void>();
export const databaseSnapshot = () => statuses;
export function subscribeDatabase(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function databaseStatus(id: string, status: DatabaseStatus) {
  statuses = { ...statuses, [id]: status };
  listeners.forEach((listener) => listener());
}

/** Validates profiles without accepting stored SQL or passwords. 校验连接配置，不接受持久化 SQL 或密码。 */
export function validDatabaseConfig(value: unknown): value is DatabaseConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as DatabaseConfig;
  const clean = (value: unknown, size: number) =>
    typeof value === "string" && value.length <= size && !/[\x00-\x1f\x7f]/.test(value);
  return (
    Object.keys(value).every((key) =>
      [
        "id",
        "name",
        "kind",
        "host",
        "port",
        "database",
        "username",
        "tls",
        "ca_file",
        "ssh_target",
        "credential_id",
        "auth_source",
        "auth_mode",
      ].includes(key),
    ) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.id) &&
    databaseKinds.includes(config.kind) &&
    clean(config.name, 200) &&
    !!config.name.trim() &&
    validDatabaseHost(config.host) &&
    Number.isInteger(config.port) &&
    config.port > 0 &&
    config.port <= 65535 &&
    clean(config.database, 255) &&
    /^[a-zA-Z0-9_$.-]*$/.test(config.database) &&
    (config.kind !== "oracle" || !!config.database) &&
    clean(config.username, 512) &&
    (config.auth_source === undefined ||
      (config.kind === "mongodb" &&
        clean(config.auth_source, 255) &&
        /^[a-zA-Z0-9_$.-]+$/.test(config.auth_source))) &&
    (config.auth_mode === undefined ||
      (config.kind === "elasticsearch" && ["basic", "api_key"].includes(config.auth_mode))) &&
    typeof config.tls === "boolean" &&
    clean(config.ca_file, 4096) &&
    (config.ssh_target === undefined || validSshTarget(config.ssh_target)) &&
    (config.credential_id === null ||
      (typeof config.credential_id === "string" && /^[0-9a-f-]{36}$/i.test(config.credential_id)))
  );
}

/** Maps backend codes without exposing credential-bearing diagnostics. 映射后端错误码，不显示可能含凭据的诊断信息。 */
export function databaseError(reason: unknown): string {
  const code = String(reason);
  if (code.includes("DB_DOCUMENT_QUERY"))
    return tx("查询必须是受支持的 JSON 对象，请检查操作和字段。");
  if (code.includes("DB_DOCUMENT_TARGET")) return tx("请选择数据库和集合，或指定一个索引。");
  if (code.includes("DB_DOCUMENT_CONFLICT")) return tx("文档已变化或不存在，请重新读取后再修改。");
  if (code.includes("DB_DOCUMENT_READ_ONLY")) return tx("请先开启允许编辑，并确认文档写入。");
  if (code.includes("DB_HTTP_AUTH")) return tx("认证失败或权限不足，请检查凭据和服务端权限。");
  if (code.includes("DB_HTTP_STATUS"))
    return tx("Elasticsearch 拒绝了请求，请检查查询、索引和服务端状态。");
  if (code.includes("DB_SQL_UNSUPPORTED"))
    return tx("SQL 语句边界、引号或注释不完整，或包含不支持的语句块。");
  if (code.includes("DB_SQL_EMPTY")) return tx("没有可执行的 SQL，请选择语句或输入查询。");
  if (code.includes("DB_CONFLICT"))
    return tx(
      "数据或表结构已变化，本批表格修改已撤销并保留草稿；此前的 SQL 事务保留。请核对并刷新后重试。",
    );
  if (code.includes("DB_INVALID_VALUE"))
    return tx("值与列类型、必填约束或生成列要求不符，请检查输入。");
  if (code.includes("DB_TABLE_UNSUPPORTED"))
    return tx("此表无法安全编辑，请使用具备主键且支持事务的完整标量列普通表。");
  if (code.includes("DB_WRITE_UNKNOWN"))
    return tx("写入结果不确定，连接已关闭。请重新连接并核对数据，勿直接重复写入。");
  if (code.includes("DB_EXPLAIN_WRITABLE"))
    return tx("Oracle 需开启编辑，并具备 PLAN_TABLE 与 DBMS_XPLAN 权限。");
  if (code.includes("DB_INPUT_LIMIT")) return tx("内容超过大小或数量限制，请减少批量操作。");
  if (code.includes("DB_BATCH_TIMEOUT"))
    return tx("本批表格操作超时，已撤销本批写入并保留草稿及此前事务。");
  if (code.includes("DB_BROWSE_DISCONNECTED"))
    return tx("浏览连接已关闭，SQL 连接和事务保留，请重试浏览。");
  if (code.includes("DB_CONNECTION_LIMIT"))
    return tx("数据库连接名额已用完，请断开其他连接后重试。浏览连接也计入八个名额。");
  if (code.includes("DB_SQL:"))
    return tx("数据库拒绝了操作：{code}", {
      code: code.slice(code.indexOf("DB_SQL:") + 7).replace(/[^a-zA-Z0-9:_-]/g, ""),
    });
  if (code.includes("DB_READ_ONLY")) return tx("只读模式仅支持 SELECT 及不写入数据的 WITH 查询。");
  if (code.includes("DB_COMPONENT_CANCELLED")) return tx("组件安装已取消。");
  if (code.includes("DB_COMPONENT_MISSING"))
    return tx("请选择本机 Java 或安装 Java 运行时，并安装对应数据库驱动。");
  const downloadMessage = downloadError(reason);
  if (downloadMessage) return downloadMessage;
  if (code.includes("DB_COMPONENT_DOWNLOAD"))
    return tx("组件下载中断，已保留下载进度。请重试继续下载，或使用离线安装。");
  if (code.includes("DB_ENGINE_INVALID")) return tx("内置连接引擎不可用，请重新安装 uTerm。");
  if (code.includes("DB_COMPONENT_HASH")) return tx("组件校验失败，未安装。请重新下载匹配版本。");
  if (code.includes("DB_PENDING")) return tx("请先提交或回滚当前事务。");
  if (code.includes("DB_BUSY")) return tx("数据库操作仍在执行，请等待完成。");
  if (code.includes("DB_TIMEOUT"))
    return tx("操作超时，连接已关闭。写入结果可能未知，请重新连接并确认后再操作。");
  if (code.includes("DB_DISCONNECTED"))
    return tx("数据库连接已关闭。写入结果可能未知，请重新连接并确认。");
  if (code.includes("DB_JAVA")) return tx("请选择 Java 17 或更新版本的可执行文件。");
  if (code.includes("DB_CREDENTIAL"))
    return tx("数据库凭据不可用或连接目标已变化，请重新输入密码。");
  if (code.includes("DB_REPLY_LIMIT")) return tx("结果超过显示限制，请缩小查询范围。");
  if (code.includes("DB_INVALID_CONFIG")) return tx("数据库连接配置无效。");
  if (code.includes("DB_CANCELLED"))
    return tx("查询已取消，连接已关闭。写入结果需要重新连接确认。");
  if (code.includes("SSH_")) return sshError(reason);
  return tx("数据库操作失败，请检查组件、连接配置和服务端状态。");
}
