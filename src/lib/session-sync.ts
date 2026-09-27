import { tx } from "./i18n.ts";
export function sessionSyncErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /^connection timed out\.?$/i.test(message.trim())
    ? ""
    : tx("无法同步本机会话：{p0}", { p0: message });
}
