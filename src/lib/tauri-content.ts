import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { JSONValue } from "./core-contract.generated.ts";
import type { ContentPort } from "./content-transport.ts";

export { isTauri };
export const tauriContentPort: ContentPort = {
  async request(message) {
    try {
      const result = await invoke(message.method, message.params);
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
    }
  },
  // Existing IPC cannot interrupt a committed file write; ContentScope discards late replies.
  // 现有 IPC 不能中断已提交的文件写入；ContentScope 丢弃迟到响应。
  cancel() {},
  subscribe(kind, document, receive) {
    return listen(kind, (event) =>
      receive({ version: 1, document, kind, payload: (event.payload ?? null) as JSONValue }),
    );
  },
};

export function applyTauriWindowAppearance(blur: boolean): Promise<void> {
  return isTauri() ? invoke("window_appearance", { blur }) : Promise.resolve();
}
