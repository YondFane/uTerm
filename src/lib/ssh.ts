import { tx } from "./i18n.ts";
import { validSshHost, validSshIpv6, type SshConnection, type SshTarget } from "./workspace.ts";

export function parseQuickSsh(input: string): Omit<SshConnection, "id" | "sessions"> | null {
  let address = input.trim();
  if (address.startsWith("ssh://")) address = address.slice(6).replace(/\/$/, "");
  if (!address || /[\s/%?#\\]/.test(address)) return null;
  const pieces = address.split("@");
  if (pieces.length > 2) return null;
  const username = pieces.length === 2 ? pieces[0] : undefined;
  if (username !== undefined && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(username)) return null;
  const endpoint = pieces.at(-1)!;
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::([0-9]+))?$/.exec(endpoint);
  const plain = /^([^:]+)(?::([0-9]+))?$/.exec(endpoint);
  if (endpoint.startsWith("[") && !bracketed) return null;
  if (!bracketed && !plain && !validSshIpv6(endpoint)) return null;
  const host = bracketed?.[1] ?? plain?.[1] ?? endpoint;
  const portText = bracketed?.[2] ?? plain?.[2];
  const port = portText === undefined ? undefined : Number(portText);
  if (
    !validSshHost(host) ||
    host.includes("@") ||
    (host.includes(":") && !validSshIpv6(host)) ||
    /[\[\]]/.test(host) ||
    (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
  )
    return null;
  const direct = !!username || port !== undefined || host.includes(":") || /^[0-9.]+$/.test(host);
  return {
    name: input.trim(),
    host,
    ...(username ? { username } : {}),
    ...(direct ? { mode: "direct", port: port ?? 22 } : { mode: "alias" }),
    authentication: "config",
    os: "posix",
    root: "",
    temporary: true,
  };
}
export function matchesSsh(connection: SshConnection, query: string): boolean {
  return [connection.name, connection.host, connection.username ?? ""].some((value) =>
    value.toLowerCase().includes(query.trim().toLowerCase()),
  );
}
export interface SshTunnelStatus {
  id: string;
  connection_id: string;
  state: "starting" | "running" | "error";
  error?: string | null;
}

export type TerminalStatus =
  "idle" | "starting" | "running" | "exited" | "closing" | "disconnected";
export type SshFileStatus = "idle" | "connecting" | "connected" | "disconnecting" | "error";
export interface ResolvedSsh {
  hostname: string;
  username: string;
  port: string;
  proxy: boolean;
}
export function sshEndpoint(target: SshTarget, resolved?: ResolvedSsh | null): string {
  const host = resolved?.hostname ?? target.host;
  const user = resolved?.username ?? target.username;
  const port = resolved?.port ?? target.port;
  const address = host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
  return (user ? user + "@" : "") + address + (port ? ":" + port : "");
}
export function sshTerminalLabel(status?: TerminalStatus): string {
  return {
    idle: tx("SSH 进程未启动"),
    starting: tx("正在启动 SSH 进程"),
    running: tx("SSH 进程运行中"),
    exited: tx("SSH 会话已结束"),
    closing: tx("正在关闭"),
    disconnected: tx("终端附着已断开"),
  }[status ?? "starting"];
}
export function sshFilesLabel(status: SshFileStatus): string {
  return {
    idle: tx("文件尚未连接"),
    connecting: tx("正在连接远程文件…"),
    connected: tx("SFTP 已连接"),
    disconnecting: tx("正在断开文件连接…"),
    error: tx("文件连接失败"),
  }[status];
}
