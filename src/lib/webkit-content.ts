import type { ContentPort, ContentReply } from "./content-transport.ts";
export interface WebKitHandler {
  postMessage(message: unknown): Promise<ContentReply>;
}
export function webKitContentPort(handler: WebKitHandler, target: EventTarget): ContentPort {
  return {
    request: (message) => handler.postMessage({ kind: "request", ...message }),
    cancel(document, id) {
      void handler.postMessage({ kind: "cancel", version: 1, document, id }).catch(() => {});
    },
    async subscribe(_kind, _document, receive) {
      const listener = (event: Event) => receive((event as CustomEvent).detail);
      target.addEventListener("uterm-content-event", listener);
      return () => target.removeEventListener("uterm-content-event", listener);
    },
  };
}
