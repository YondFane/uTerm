import type { JSONValue } from "./core-contract.generated.ts";

export const editorDraftMethods: Record<string, string> = {
  editor_drafts_list: "editor.drafts.list",
  editor_drafts_document: "editor.drafts.document",
  editor_drafts_import: "editor.drafts.import",
  editor_drafts_put: "editor.drafts.putDocument",
  editor_drafts_remove: "editor.drafts.removeDocument",
};
const contentMethods = new Set([
  ...Object.keys(editorDraftMethods),
  "files_list",
  "file_read",
  "file_save",
  "file_copy",
  "file_mutate",
  "file_reveal",
  "files_search",
  "ssh_files_list",
  "ssh_file_read",
  "ssh_file_save",
  "ssh_file_mutate",
  "editor_guard",
  "editor_exit",
  "open_external",
  "content_context",
  "content_font_adjust",
  "content_settings_patch",
]);
export interface ContentRequest {
  version: 1;
  id: string;
  document: string;
  method: string;
  params: Record<string, unknown>;
}
export interface ContentReply {
  version: number;
  id: string;
  document: string;
  result?: unknown;
  error?: { code: string; message: string };
}
export interface ContentEvent {
  version: number;
  document: string;
  kind: string;
  payload: JSONValue;
}
export interface ContentPort {
  request(message: ContentRequest): Promise<ContentReply>;
  cancel(document: string, id: string): void;
  subscribe(
    kind: string,
    document: string,
    receive: (event: ContentEvent) => void,
  ): Promise<() => void>;
}
export class ContentFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export class ContentScope {
  private closed = false;
  private pending = new Map<string, () => void>();
  private subscriptions = new Set<() => void>();
  private port: ContentPort;
  readonly document: string;
  private timeout: number;
  constructor(port: ContentPort, document: string, timeout = 15000) {
    this.port = port;
    this.document = document;
    this.timeout = timeout;
    if (!document || document.length > 128 || !Number.isFinite(timeout) || timeout <= 0)
      throw new ContentFailure("INVALID_SCOPE", "Invalid content document or timeout");
  }
  call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (this.closed)
      return Promise.reject(new ContentFailure("CLOSED", "Content document is closed"));
    if (!contentMethods.has(method))
      return Promise.reject(new ContentFailure("METHOD_DENIED", "Content method is not allowed"));
    if (signal?.aborted)
      return Promise.reject(new ContentFailure("CANCELLED", "Content request cancelled"));
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    let message: ContentRequest;
    try {
      const serialized = JSON.stringify({
        version: 1,
        id,
        document: this.document,
        method,
        params,
      });
      if (new TextEncoder().encode(serialized).byteLength > 32 * 1024 * 1024)
        throw new ContentFailure("REQUEST_TOO_LARGE", "Content request exceeds the control limit");
      message = JSON.parse(serialized);
    } catch (reason) {
      return Promise.reject(reason);
    }
    return new Promise<T>((resolve, reject) => {
      let active = true;
      let started = false;
      const finish = (error?: unknown, value?: unknown, cancel = false) => {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.pending.delete(id);
        // Cancellation suppresses delivery; a write already running may still commit.
        // 取消抑制结果交付；已经执行的写入仍可能提交。
        if (cancel && started) {
          try {
            this.port.cancel(this.document, id);
          } catch {
            /* Delivery is already cancelled. 结果交付已取消。 */
          }
        }
        if (error !== undefined) reject(error);
        else resolve(value as T);
      };
      const aborted = () =>
        finish(new ContentFailure("CANCELLED", "Content request cancelled"), undefined, true);
      const timer = setTimeout(
        () => finish(new ContentFailure("TIMEOUT", "Content request timed out"), undefined, true),
        this.timeout,
      );
      this.pending.set(id, () =>
        finish(new ContentFailure("CLOSED", "Content document is closed"), undefined, true),
      );
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      void Promise.resolve()
        .then(async () => {
          if (!active) return;
          started = true;
          const reply = await this.port.request(message);
          if (!active) return;
          if (reply?.version !== 1 || reply.id !== id || reply.document !== this.document)
            throw new ContentFailure("INVALID_REPLY", "Mismatched content response");
          if (reply.error) {
            if (typeof reply.error.code !== "string" || typeof reply.error.message !== "string")
              throw new ContentFailure("INVALID_REPLY", "Invalid content error");
            throw new ContentFailure(reply.error.code, reply.error.message);
          }
          finish(undefined, reply.result);
        })
        .catch((reason) => finish(reason));
    });
  }
  async subscribe(kind: string, receive: (payload: JSONValue) => void): Promise<() => void> {
    if (this.closed) throw new ContentFailure("CLOSED", "Content document is closed");
    if (kind !== "editor-close-request")
      throw new ContentFailure("EVENT_DENIED", "Content event is not allowed");
    let listening = true;
    const stop = await this.port.subscribe(kind, this.document, (event) => {
      if (
        listening &&
        !this.closed &&
        event?.version === 1 &&
        event.document === this.document &&
        event.kind === kind
      )
        receive(event.payload);
    });
    const unsubscribe = () => {
      if (listening) {
        listening = false;
        this.subscriptions.delete(unsubscribe);
        stop();
      }
    };
    if (this.closed) unsubscribe();
    else this.subscriptions.add(unsubscribe);
    return unsubscribe;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of [...this.pending.values()]) cancel();
    for (const stop of [...this.subscriptions]) stop();
  }
}
