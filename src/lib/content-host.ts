import { ContentScope } from "./content-transport.ts";
import { applyTauriWindowAppearance, isTauri, tauriContentPort } from "./tauri-content.ts";
import { webKitContentPort, type WebKitHandler } from "./webkit-content.ts";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

declare global {
  interface Window {
    utermContentDocument?: string;
    utermContentLanguage?: "system" | "zh-Hans" | "en";
    webkit?: { messageHandlers?: { utermContent?: WebKitHandler } };
  }
}
export type ContentInvoker = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
export function createContentScope(): ContentScope {
  const handler = window.webkit?.messageHandlers?.utermContent;
  return new ContentScope(
    handler ? webKitContentPort(handler, window) : tauriContentPort,
    handler ? (window.utermContentDocument ?? "") : crypto.randomUUID(),
    15000,
    {
      database_connect: 60000,
      database_request: 60000,
      database_components: 600000,
      database_credential: 180000,
      database_export_sql: 180000,
      database_export_result: 180000,
    },
  );
}
let scope: ContentScope | undefined;
function current(): ContentScope {
  if (!scope) {
    scope = createContentScope();
    window.addEventListener("pagehide", () => scope?.close(), { once: true });
  }
  return scope;
}
export function isContentHost(): boolean {
  return !!window.webkit?.messageHandlers?.utermContent || isTauri();
}
export function contentInvoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  return current().call(method, params);
}
export function copyContentText(text: string): Promise<void> {
  return window.webkit?.messageHandlers?.utermContent
    ? contentInvoke("content_copy_text", { text })
    : isTauri()
      ? writeText(text)
      : navigator.clipboard.writeText(text);
}
export function listenContent<T = unknown>(
  kind: string,
  receive: (payload: T) => void,
): Promise<() => void> {
  return current().subscribe(kind, (payload) => receive(payload as T));
}

export function applyContentWindowAppearance(blur: boolean): Promise<void> {
  return window.webkit?.messageHandlers?.utermContent
    ? Promise.resolve()
    : applyTauriWindowAppearance(blur);
}
