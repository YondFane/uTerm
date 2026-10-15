import { invoke } from "@tauri-apps/api/core";
import { tx } from "./i18n.ts";
import { validSshHost } from "./workspace.ts";

export interface RedisConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  db: number;
  username: string;
  tls: boolean;
  ca_file: string;
  server_name: string;
  ssh_host: string;
  credential_id: string | null;
}
export interface RedisBlob {
  data: string;
  text: string | null;
  size: number;
  truncated: boolean;
}
export interface RedisKey {
  key: RedisBlob;
  kind: string;
  ttl: number;
}
export interface RedisDocument {
  kind: string;
  ttl: number;
  db: number;
  size?: number;
  value?: RedisBlob | null;
  version?: string | null;
  items?: RedisBlob[];
  cursor?: string;
  partial?: boolean;
  unsupported?: boolean;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Validates persisted profiles and rejects embedded secrets. 校验持久化配置，并拒绝其中嵌入的凭据。 */
export function validRedisConfig(value: unknown): value is RedisConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as RedisConfig;
  const host = (value: unknown) =>
    typeof value === "string" &&
    value.length <= 255 &&
    /^[a-zA-Z0-9_.:-]+$/.test(value) &&
    !value.startsWith("-");
  return (
    Object.keys(value).every((key) =>
      [
        "id",
        "name",
        "host",
        "port",
        "db",
        "username",
        "tls",
        "ca_file",
        "server_name",
        "ssh_host",
        "credential_id",
      ].includes(key),
    ) &&
    typeof config.id === "string" &&
    uuid.test(config.id) &&
    typeof config.name === "string" &&
    !!config.name.trim() &&
    config.name.length <= 200 &&
    host(config.host) &&
    Number.isInteger(config.port) &&
    config.port > 0 &&
    config.port <= 65535 &&
    Number.isInteger(config.db) &&
    config.db >= 0 &&
    config.db <= 1024 &&
    typeof config.username === "string" &&
    config.username.length <= 512 &&
    typeof config.tls === "boolean" &&
    typeof config.ca_file === "string" &&
    config.ca_file.length <= 4096 &&
    !config.ca_file.includes("\0") &&
    (config.server_name === "" || host(config.server_name)) &&
    (config.ssh_host === "" || validSshHost(config.ssh_host)) &&
    (config.credential_id === null ||
      (typeof config.credential_id === "string" && uuid.test(config.credential_id)))
  );
}
export function redisError(error: unknown): string {
  const value = String(error);
  const errors: Record<string, () => string> = {
    REDIS_CONFLICT: () => tx("Redis 数据已变化，编辑内容已保留。请重新读取后再修改。"),
    REDIS_READ_ONLY: () => tx("Redis 连接处于只读模式。"),
    REDIS_DB_CHANGED: () => tx("Redis 数据库已切换，请重新读取。"),
    REDIS_KEY_MISSING: () => tx("Redis Key 已不存在。"),
    REDIS_NAME_EXISTS: () => tx("目标 Key 已存在，未覆盖。"),
    REDIS_WRITE_UNCERTAIN: () => tx("写入结果未知。请重新连接并读取确认，不要直接重复提交。"),
    REDIS_SCAN_FAILED: () => tx("Redis 扫描失败，请检查读取权限并重新连接。"),
    REDIS_RECONNECT: () => tx("Redis 连接已中断或请求超时，请重新连接。"),
    REDIS_AUTH_FAILED: () => tx("Redis 认证或数据库选择失败，请检查用户名、密码和 DB。"),
    REDIS_TLS_FAILED: () => tx("TLS 连接失败，请检查证书、CA 和服务端名称。"),
    REDIS_CA_FAILED: () => tx("无法读取有效的 CA 证书。"),
    REDIS_CONNECT_TIMEOUT: () => tx("Redis 连接超时，请检查网络或 SSH 隧道。"),
    REDIS_CONNECT_FAILED: () => tx("无法连接 Redis，请检查地址和端口。"),
    REDIS_COMMAND_BLOCKED: () => tx("该命令不在首版允许范围内。命令台仅支持已登记的只读命令。"),
    REDIS_CLUSTER_UNSUPPORTED: () => tx("首版不支持 Redis Cluster，请连接独立节点。"),
    REDIS_CREDENTIAL_TARGET_CHANGED: () => tx("连接目标已变化，请重新输入并保存密码。"),
    REDIS_CREDENTIAL_FAILED: () => tx("无法访问系统凭据库，请重新输入密码或检查系统权限。"),
    REDIS_CREDENTIAL_MISSING: () => tx("未找到保存的 Redis 密码，请重新输入。"),
    REDIS_CREDENTIAL_SIZE: () => tx("密码过长，最多支持 2048 字节。"),
    REDIS_CREDENTIAL_UNAVAILABLE: () => tx("当前平台不支持保存 Redis 密码，请使用临时密码。"),
    REDIS_CONNECTION_LIMIT: () => tx("最多同时打开 8 个 Redis 连接，请先断开其他连接。"),
    REDIS_VALUE_LIMIT: () => tx("值超过 1 MB，不能完整编辑。"),
    REDIS_REPLY_LIMIT: () => tx("返回数据超过限制，请缩小查询范围。"),
    REDIS_KEY_LIMIT: () => tx("Key 或字段名超过 4096 字节。"),
    REDIS_INPUT_LIMIT: () => tx("输入超过允许范围。"),
    REDIS_INVALID_CONFIG: () => tx("Redis 连接配置无效。"),
    REDIS_INVALID_TTL: () => tx("TTL 必须是 1 到 3153600000 之间的整数秒。"),
    REDIS_WRITE_FAILED: () => tx("Redis 拒绝了写入，请检查权限和服务端版本。"),
  };
  for (const [code, message] of Object.entries(errors)) if (value.includes(code)) return message();
  if (value.includes("REDIS_SERVER:"))
    return tx("Redis 返回错误：{code}", { code: value.split("REDIS_SERVER:")[1].trim() });
  if (value.includes("SSH_"))
    return tx("SSH 隧道失败。请先确认主机指纹，并检查密钥、ssh-agent 和转发权限。");
  return tx("Redis 操作失败，请检查连接后重试。");
}
export function redisEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
export function redisDisplay(value: RedisBlob): string {
  if (value.text !== null) return value.text + (value.truncated ? " …" : "");
  const bytes = atob(value.data);
  return (
    [...bytes.slice(0, 256)]
      .map((byte) => byte.charCodeAt(0).toString(16).padStart(2, "0"))
      .join(" ") + (bytes.length > 256 ? " …" : "")
  );
}
/** Parses tokens without shell evaluation; Rust still authorizes commands. 仅解析词元，不经 Shell 执行；命令仍由 Rust 授权。 */
export function redisArguments(text: string): string[] {
  const args: string[] = [];
  let value = "",
    quote = "",
    escaped = false,
    started = false;
  for (const char of text.trim()) {
    if (escaped) {
      value += char;
      escaped = false;
      started = true;
    } else if (char === "\\") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(value);
        value = "";
        started = false;
      }
    } else {
      value += char;
      started = true;
    }
  }
  if (quote || escaped) throw new Error(tx("命令引号或转义不完整。"));
  if (started) args.push(value);
  return args;
}
export interface RedisStatus {
  connected: boolean;
  dirty: boolean;
  opening: boolean;
}
let statuses: Record<string, RedisStatus> = {};
const listeners = new Set<() => void>();
let guardQueue = Promise.resolve();
export const redisSnapshot = () => statuses;
export function subscribeRedis(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function redisStatus(id: string, status: RedisStatus) {
  statuses = { ...statuses, [id]: status };
  listeners.forEach((listener) => listener());
}
export function redisGuard(id: string, active: boolean): Promise<void> {
  const next = guardQueue.catch(() => {}).then(() => invoke<void>("redis_guard", { id, active }));
  guardQueue = next;
  return next;
}
