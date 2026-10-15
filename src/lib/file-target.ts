import { invoke } from "@tauri-apps/api/core";
import { tx } from "./i18n.ts";
import { validSshTarget, type SshTarget } from "./workspace.ts";

export interface RemoteRoot {
  connection: SshTarget;
  path: string;
  identity: string;
}
export type FileTarget = { kind: "local"; directory: string } | { kind: "ssh"; root: RemoteRoot };
const prefix = "uterm-ssh:";
export function isRemoteDirectory(directory: string): boolean {
  return directory.startsWith(prefix);
}
export function fileTarget(directory: string): FileTarget {
  if (!isRemoteDirectory(directory)) return { kind: "local", directory };
  try {
    const root = JSON.parse(decodeURIComponent(directory.slice(prefix.length))) as RemoteRoot;
    if (
      !root ||
      !validSshTarget(root.connection) ||
      typeof root.path !== "string" ||
      !root.path ||
      /[\0\r\n]/.test(root.path) ||
      !/^[a-f0-9]{64}$/.test(root.identity)
    )
      throw new Error();
    return { kind: "ssh", root };
  } catch {
    throw new Error(tx("SSH 文件根目录无效，原数据已保留。"));
  }
}
export function remoteDirectory(root: RemoteRoot): string {
  const directory = prefix + encodeURIComponent(JSON.stringify(root));
  fileTarget(directory);
  return directory;
}
export function displayDirectory(directory: string): string {
  const target = fileTarget(directory);
  return target.kind === "local"
    ? directory
    : `ssh://${target.root.connection.host}/${target.root.path.replace(/^\/+/, "")}`;
}
export function sshError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  if (message.startsWith("CONFLICT:")) return message;
  const codes: Record<string, string> = {
    SSH_CONNECTION_LIMIT: tx("远程文件连接已达上限，请断开暂不使用的连接。"),
    SSH_INVALID_HOST: tx("请输入有效的 SSH Host 别名。"),
    SSH_INVALID_CONNECTION: tx("SSH 连接配置无效。"),
    SSH_NOT_INSTALLED: tx("未找到系统 OpenSSH。请先安装 OpenSSH 客户端。"),
    SSH_HOST_UPGRADE_REQUIRED: tx(
      "后台服务不支持 SSH。请先关闭全部会话，再退出并重新打开应用；已有进程未被终止。",
    ),
    SSH_SESSION_MISSING: tx("SSH 会话已结束或后台已停止。点击重新启动以建立新连接。"),
    SSH_SFTP_FAILED: tx(
      "SFTP 连接失败。请先在 SSH 终端确认主机指纹，并配置密钥或 ssh-agent 登录。",
    ),
    SSH_TIMEOUT: tx("SSH 连接超时，请检查网络后重试。"),
    SSH_CONFIG_FAILED: tx("无法读取 SSH 配置，请检查 OpenSSH 配置。"),
    SSH_TARGET_CHANGED: tx("连接目标或文件已变化，操作已停止。请重新连接并检查文件。"),
    SSH_INVALID_ROOT: tx("远程根目录无效。Windows 远端请选择本地盘符下的目录。"),
    SSH_PATH_OUTSIDE_ROOT: tx("文件路径超出所选远程根目录。"),
    SSH_SYMLINK_READONLY: tx("链接及链接内的文件不能在此修改。"),
    SSH_DISCONNECTED: tx("远程文件连接已断开，请重新连接。"),
    SSH_SAFE_REPLACE_UNSUPPORTED: tx("服务器不支持安全覆盖。请下载文件，或上传为新文件。"),
    SSH_SAFE_REPLACE_FAILED: tx("安全替换失败，原文件已保留。"),
    SSH_DESTINATION_EXISTS: tx("同名文件或目录已存在。上传覆盖需要明确勾选覆盖选项。"),
    SSH_REGULAR_FILE_REQUIRED: tx("仅支持普通文件，不支持目录传输或链接。"),
    SSH_FILE_TOO_LARGE: tx("文件超过编辑或预览上限，请使用下载功能。"),
    SSH_TRANSFER_CANCELLED: tx("传输已取消。"),
    SSH_TRANSFER_BUSY: tx("文件仍在传输。请等待完成或取消传输。"),
    SSH_SOURCE_CHANGED: tx("源文件在传输期间发生变化，请重新传输。"),
    SSH_INVALID_NAME: tx("请输入不含路径分隔符的名称。"),
    SSH_INVALID_ACTION: tx("文件操作无效。"),
  };
  const code = Object.keys(codes).find((code) => message.includes(code));
  return code ? codes[code] : message;
}
export function fileInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { directory, ...rest } = args;
  if (typeof directory !== "string") return invoke<T>(command, args);
  const target = fileTarget(directory);
  if (target.kind === "local") return invoke<T>(command, args);
  const remoteCommands: Record<string, string> = {
    files_list: "ssh_files_list",
    file_read: "ssh_file_read",
    file_save: "ssh_file_save",
    file_mutate: "ssh_file_mutate",
  };
  if (!remoteCommands[command]) return Promise.reject(new Error(tx("此操作暂不支持远程目录。")));
  return invoke<T>(remoteCommands[command], { ...rest, root: target.root }).catch((error) => {
    throw new Error(sshError(error));
  });
}
