import { sshError } from "./file-target.ts";
import { tx } from "./i18n.ts";
import { validSshTarget, type SshTarget } from "./workspace.ts";

export const databaseKinds = ["mysql", "postgresql", "oracle"] as const;
export type DatabaseKind = (typeof databaseKinds)[number];
export const databaseNames: Record<DatabaseKind, string> = {
  mysql: "MySQL",
  postgresql: "PostgreSQL",
  oracle: "Oracle",
};
export const databasePorts: Record<DatabaseKind, number> = {
  mysql: 3306,
  postgresql: 5432,
  oracle: 1521,
};
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
}
export interface DatabaseComponent {
  id: string;
  version: string;
  size: number;
  installed: boolean;
  external?: boolean;
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
      ].includes(key),
    ) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.id) &&
    databaseKinds.includes(config.kind) &&
    clean(config.name, 200) &&
    !!config.name.trim() &&
    clean(config.host, 255) &&
    /^[a-zA-Z0-9_.:-]+$/.test(config.host) &&
    !config.host.startsWith("-") &&
    Number.isInteger(config.port) &&
    config.port > 0 &&
    config.port <= 65535 &&
    clean(config.database, 255) &&
    /^[a-zA-Z0-9_$.-]*$/.test(config.database) &&
    (config.kind !== "oracle" || !!config.database) &&
    clean(config.username, 512) &&
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
  if (code.includes("DB_SQL:"))
    return tx("数据库拒绝了操作：{code}", {
      code: code.slice(code.indexOf("DB_SQL:") + 7).replace(/[^a-zA-Z0-9:_-]/g, ""),
    });
  if (code.includes("DB_READ_ONLY"))
    return tx("连接处于只读模式，仅支持 SELECT 查询。开启允许编辑后可执行其他 SQL。");
  if (code.includes("DB_COMPONENT_CANCELLED")) return tx("组件安装已取消。");
  if (code.includes("DB_COMPONENT_MISSING"))
    return tx("请选择本机 Java 或安装 Java 运行时，并安装对应数据库驱动。");
  if (code.includes("DB_COMPONENT_DOWNLOAD"))
    return tx("组件下载失败。请检查网络，或使用离线安装。");
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
