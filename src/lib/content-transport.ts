import type { JSONValue } from "./core-contract.generated.ts";

export const contentWriteMethods = new Set([
  "files_clipboard",
  "github_create_pr",
  "github_form_guard",
  "github_session_action",
  "redis_connect",
  "redis_reconnect",
  "redis_request",
  "redis_writable",
  "redis_disconnect",
  "redis_guard",
  "redis_credential",
  "redis_profile_save",
  "redis_profile_remove",
  "redis_pick_ca",
  "redis_exit",
  "database_connect",
  "database_request",
  "database_disconnect",
  "database_guard",
  "database_credential",
  "database_components",
  "database_profile_save",
  "database_profile_remove",
  "database_export_sql",
  "database_export_result",
  "editor_drafts_import",
  "editor_drafts_put",
  "editor_drafts_remove",
  "git_favorites_import",
  "git_favorites_accept_shared",
  "git_favorites_write",
  "file_save",
  "file_copy",
  "file_mutate",
  "ssh_file_save",
  "ssh_file_mutate",
  "git_switch_branch",
  "git_rollback_file",
  "git_switch_remote_branch",
  "git_branch_action",
  "git_reference_action",
  "create_worktree",
  "delete_worktree",
  "content_font_adjust",
  "content_settings_patch",
]);

export const editorDraftMethods: Record<string, string> = {
  editor_drafts_list: "editor.drafts.list",
  editor_drafts_document: "editor.drafts.document",
  editor_drafts_import: "editor.drafts.import",
  editor_drafts_put: "editor.drafts.putDocument",
  editor_drafts_remove: "editor.drafts.removeDocument",
};
export const gitMethods: Record<string, string> = {
  git_branch: "git.branch",
  git_branches: "git.branches",
  git_switch_branch: "git.switchBranch",
  git_rollback_file: "git.rollbackFile",
  git_remote_branches: "git.remoteBranches",
  git_switch_remote_branch: "git.switchRemoteBranch",
  git_branch_action: "git.branchAction",
  git_file_status: "git.fileStatus",
  git_snapshot: "git.snapshot",
  git_diff: "git.diff",
  git_history: "git.history",
  git_files: "git.files",
  git_references: "git.references",
  git_reference_action: "git.referenceAction",
  git_working_comparison: "git.workingComparison",
  project_worktrees: "git.worktrees.list",
  create_worktree: "git.worktrees.create",
  delete_worktree: "git.worktrees.delete",
  worktree_suggestion: "git.worktrees.suggestion",
};
export const gitFavoriteMethods: Record<string, string> = {
  git_favorites_read: "git.favorites.read",
  git_favorites_import: "git.favorites.import",
  git_favorites_accept_shared: "git.favorites.acceptShared",
  git_favorites_write: "git.favorites.write",
};
const contentMethods = new Set([
  "files_clipboard",
  "files_context",
  "files_mode",
  "files_toolbar",
  "github_repositories",
  "github_read",
  "github_prepare_pr",
  "github_create_pr",
  "github_form_guard",
  "github_session_action",
  "github_context",
  "redis_profiles",
  "redis_profile_save",
  "redis_profile_remove",
  "redis_connect",
  "redis_reconnect",
  "redis_request",
  "redis_writable",
  "redis_disconnect",
  "redis_guard",
  "redis_credential",
  "redis_pick_ca",
  "redis_exit",
  "database_connect",
  "database_request",
  "database_disconnect",
  "database_guard",
  "database_credential",
  "database_components",
  "database_profiles",
  "database_profile_save",
  "database_profile_remove",
  "database_export_sql",
  "database_export_result",
  "git_favorites_recovery_open",
  ...Object.keys(editorDraftMethods),
  ...Object.keys(gitMethods),
  ...Object.keys(gitFavoriteMethods),
  "content_open_file",
  "content_copy_text",
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
  "content_editor_state",
  "editor_guard",
  "editor_exit",
  "editor_prepare_result",
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
  cancel(document: string, id: string): void | Promise<void>;
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
export function contentErrorText(reason: unknown): string {
  const text = String(reason);
  const code = reason && typeof reason === "object" ? (reason as { code?: unknown }).code : null;
  return typeof code === "string" && code !== "HOST_ERROR" && !text.includes(code)
    ? `${code}: ${text}`
    : text;
}
export class ContentScope {
  private closed = false;
  private pending = new Map<string, () => void>();
  private subscriptions = new Set<() => void>();
  private port: ContentPort;
  readonly document: string;
  private timeout: number;
  private timeouts: Readonly<Record<string, number>>;
  constructor(
    port: ContentPort,
    document: string,
    timeout = 15000,
    timeouts: Readonly<Record<string, number>> = {},
  ) {
    this.port = port;
    this.document = document;
    this.timeout = timeout;
    this.timeouts = { ...timeouts };
    if (!document || document.length > 128 || !Number.isFinite(timeout) || timeout <= 0)
      throw new ContentFailure("INVALID_SCOPE", "Invalid content document or timeout");
    if (
      Object.values(this.timeouts).some(
        (value) => !Number.isFinite(value) || value <= 0 || value > 900000,
      )
    )
      throw new ContentFailure("INVALID_SCOPE", "Invalid content operation timeout");
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
        // A dispatched write retains its caller's guard until the port drains it.
        // 已分发写入保留调用方保护，直到端口确认操作结束。
        if (cancel && started) {
          try {
            const drained = this.port.cancel(this.document, id);
            if (drained) {
              const failure =
                error instanceof ContentFailure
                  ? new ContentFailure(
                      error.code,
                      `${error.message}. Dispatched write may have completed; reload before retrying.`,
                    )
                  : error;
              void drained.then(
                () => reject(failure),
                () => reject(failure),
              );
              return;
            }
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
        this.timeouts[method] ?? this.timeout,
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
    if (
      ![
        "editor-close-request",
        "editor-prepare-quit",
        "editor-resume",
        "editor-repository-refresh",
        "file-focus-line",
        "content-font-adjust",
        "files-frozen",
        "files-mode-changed",
        "files-settings-changed",
        "github-frozen",
        "github-context-changed",
        "github-settings-changed",
        "database-component-progress",
        "database-components-changed",
        "database-frozen",
        "database-host-error",
        "database-settings-changed",
        "redis-close-request",
        "redis-frozen",
        "redis-host-error",
        "redis-settings-changed",
      ].includes(kind)
    )
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
