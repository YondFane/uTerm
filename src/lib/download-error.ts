import { tx } from "./i18n.ts";

export function downloadError(reason: unknown): string | undefined {
  const code = String(reason);
  if (/DOWNLOAD_TLS/.test(code))
    return tx("下载连接的证书验证失败，请检查系统时间、证书或代理设置。");
  if (/DOWNLOAD_TIMEOUT/.test(code)) return tx("下载超时，请检查网络或代理后重试。");
  if (/DOWNLOAD_NETWORK/.test(code)) return tx("下载连接中断，请检查网络或代理后重试。");
  if (/DOWNLOAD_RATE_LIMIT|DOWNLOAD_RETRY_LATER/.test(code))
    return tx("下载源暂时限制请求，请稍后重试或手动下载。");
  if (/DOWNLOAD_SERVER/.test(code)) return tx("下载源暂时不可用，请稍后重试或手动下载。");
  if (/DOWNLOAD_NOT_FOUND/.test(code))
    return tx("下载文件不存在，请重新检查版本或使用手动下载入口。");
  if (/DOWNLOAD_ACCESS/.test(code)) return tx("下载被拒绝，请检查访问权限或代理设置，或手动下载。");
  if (/DOWNLOAD_STORAGE/.test(code)) return tx("无法读写下载缓存，请检查磁盘空间和目录权限。");
  if (/DOWNLOAD_VERIFY/.test(code)) return tx("更新签名校验失败，未安装。请重新下载官方更新包。");
  if (/DOWNLOAD_METADATA|DOWNLOAD_RESPONSE/.test(code))
    return tx("下载信息无效，请重新检查版本或使用手动下载入口。");
  if (/DOWNLOAD_CANCELLED/.test(code)) return tx("下载已取消，已保留下载进度。");
  if (/AGENT_PERMISSION/.test(code))
    return tx("Agent 安装目录不可写，请检查 npm 全局目录权限或按官方说明安装。");
  if (/AGENT_NODE_VERSION/.test(code))
    return tx("Node.js 版本不满足此 Agent 的要求，请按官方说明更新后重试。");
  if (/AGENT_INSTALL_FAILED/.test(code))
    return tx("Agent 安装失败，请查看安装输出或按官方说明安装。");
  return undefined;
}
