import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CoreResponse, JSONValue } from "./core-contract.generated.ts";
import {
  contentWriteMethods,
  editorDraftMethods,
  gitFavoriteMethods,
  pdfMarkMethods,
} from "./content-transport.ts";
import type { ContentPort } from "./content-transport.ts";

export { isTauri };
const pendingWrites = new Map<string, Promise<void>>();
const requestKey = (document: string, id: string) => JSON.stringify([document, id]);
export const tauriContentPort: ContentPort = {
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
      let result: unknown;
      if (
        Object.hasOwn(editorDraftMethods, message.method) ||
        Object.hasOwn(gitFavoriteMethods, message.method) ||
        Object.hasOwn(pdfMarkMethods, message.method)
      ) {
        const reply = JSON.parse(
          await invoke<string>("shared_core_request", {
            request: JSON.stringify({
              version: 1,
              id: message.id,
              method:
                editorDraftMethods[message.method] ??
                gitFavoriteMethods[message.method] ??
                pdfMarkMethods[message.method],
              params: message.params,
            }),
          }),
        ) as CoreResponse;
        if (reply.version !== 1 || reply.id !== message.id)
          throw Object.assign(Error("Invalid shared content response"), { code: "INVALID_REPLY" });
        if (reply.error)
          throw Object.assign(Error(reply.error.message), { code: reply.error.code });
        result = reply.result ?? null;
      } else result = await invoke(message.method, message.params);
      return { version: 1, id: message.id, document: message.document, result };
    } catch (reason) {
      const messageText = reason instanceof Error ? reason.message : String(reason);
      return {
        version: 1,
        id: message.id,
        document: message.document,
        error: {
          code:
            (reason as { code?: string })?.code ??
            (messageText.startsWith("CONFLICT:") ? "CONFLICT" : "HOST_ERROR"),
          message: messageText,
        },
      };
    } finally {
      if (complete) {
        pendingWrites.delete(key);
        complete();
      }
    }
  },
  // IPC cannot stop an ongoing write; retain its caller until the actual reply.
  // IPC 无法停止执行中的写入；保留调用方直到实际回复。
  cancel(document, id) {
    return pendingWrites.get(requestKey(document, id));
  },
  subscribe(kind, document, receive) {
    return listen(kind, (event) =>
      receive({ version: 1, document, kind, payload: (event.payload ?? null) as JSONValue }),
    );
  },
};

export function applyTauriWindowAppearance(blur: boolean): Promise<void> {
  return isTauri() ? invoke("window_appearance", { blur }) : Promise.resolve();
}
