import type { ContentPort, ContentReply } from "./content-transport.ts";
import { contentWriteMethods } from "./content-transport.ts";
export interface WebKitHandler {
  postMessage(message: unknown): Promise<ContentReply>;
}
export function webKitContentPort(handler: WebKitHandler, target: EventTarget): ContentPort {
  const pendingWrites = new Map<string, Promise<void>>();
  const requestKey = (document: string, id: string) => JSON.stringify([document, id]);
  return {
    async request(message) {
      const key = requestKey(message.document, message.id);
      let complete: (() => void) | undefined;
      if (contentWriteMethods.has(message.method))
        pendingWrites.set(
          key,
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
        );
      try {
        return await handler.postMessage({ kind: "request", ...message });
      } finally {
        if (complete) {
          pendingWrites.delete(key);
          complete();
        }
      }
    },
    cancel(document, id) {
      // A cancellation acknowledgement does not mean a dispatched native write has stopped.
      // 取消确认不代表已分发的原生写入已经停止。
      void Promise.resolve()
        .then(() => handler.postMessage({ kind: "cancel", version: 1, document, id }))
        .catch(() => {});
      return pendingWrites.get(requestKey(document, id));
    },
    async subscribe(_kind, _document, receive) {
      const listener = (event: Event) => receive((event as CustomEvent).detail);
      target.addEventListener("uterm-content-event", listener);
      return () => target.removeEventListener("uterm-content-event", listener);
    },
  };
}
