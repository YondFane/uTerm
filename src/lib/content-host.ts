import { ContentScope } from "./content-transport.ts";
import { isTauri, tauriContentPort } from "./tauri-content.ts";
import { webKitContentPort, type WebKitHandler } from "./webkit-content.ts";

declare global {
  interface Window {
    utermContentDocument?: string;
    webkit?: { messageHandlers?: { utermContent?: WebKitHandler } };
  }
}
export type ContentInvoker = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
export function createContentScope(): ContentScope {
  const handler = window.webkit?.messageHandlers?.utermContent;
  return new ContentScope(
    handler ? webKitContentPort(handler, window) : tauriContentPort,
    handler ? (window.utermContentDocument ?? "") : crypto.randomUUID(),
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
export function listenContent(kind: string, receive: () => void): Promise<() => void> {
  return current().subscribe(kind, receive);
}
