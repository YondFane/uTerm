import type {
  CoreEditorDraft,
  CoreEditorDraftCollection,
  CoreEditorDraftEntry,
} from "./core-contract.generated.ts";
import { ContentFailure } from "./content-transport.ts";

type Call = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
type Waiter = { resolve: () => void; reject: (reason: unknown) => void };
interface Pending {
  directory: string;
  path: string;
  value: CoreEditorDraft | null;
  ticket: symbol;
  failed?: symbol;
  error?: unknown;
  waiters: Waiter[];
  attempted?: CoreEditorDraft | null;
}
const fields = [
  "directory",
  "path",
  "kind",
  "text",
  "saved",
  "version",
  "line_ending",
  "bom",
] as const;
function same(left: CoreEditorDraft | null, right: CoreEditorDraft | null): boolean {
  return (
    left === right || (!!left && !!right && fields.every((field) => left[field] === right[field]))
  );
}
function key(directory: string, path: string): string {
  return JSON.stringify([directory, path]);
}
export class EditorDraftQueue {
  private ready?: Promise<CoreEditorDraftCollection>;
  private known = new Map<string, CoreEditorDraftEntry>();
  private pending = new Map<string, Pending>();
  private pump?: Promise<void>;
  private active = new Set<Waiter>();
  private rejected = new Map<string, unknown>();
  private discarding = new Set<string>();
  private initialized = false;
  private legacy?: string | null;
  private signalClose!: () => void;
  private readonly closedSignal = new Promise<void>((resolve) => {
    this.signalClose = resolve;
  });
  private closed = false;
  private call: Call;
  readonly directory?: string;
  constructor(call: Call, directory?: string) {
    this.call = call;
    this.directory = directory;
  }

  initialize(legacy?: string | null): Promise<CoreEditorDraftCollection> {
    if (this.closed) return Promise.reject(new ContentFailure("CLOSED", "Draft queue is closed"));
    if (!this.ready && legacy !== undefined) this.legacy = legacy;
    return (this.ready ??= Promise.race([
      (async () => {
        let result: CoreEditorDraftCollection;
        let imported = false;
        const params = { directory: this.directory ?? null };
        try {
          result = await this.call("editor_drafts_list", params);
        } catch (reason) {
          if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
          if ((reason as { code?: string }).code !== "DRAFTS_NOT_IMPORTED") throw reason;
          await this.call(
            "editor_drafts_import",
            this.legacy === undefined ? {} : { legacy: this.legacy },
          );
          imported = true;
          if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
          result = await this.call("editor_drafts_list", params);
        }
        if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
        if (!imported && typeof this.legacy === "string") {
          // An existing store must still archive and validate a fresh legacy source.
          // 已有共享库仍须备份并验证旧端的新来源。
          await this.call("editor_drafts_import", { legacy: this.legacy });
          if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
        }
        for (const entry of result.drafts)
          this.known.set(key(entry.draft.directory, entry.draft.path), entry);
        this.initialized = true;
        this.legacy = undefined;
        return result;
      })(),
      this.closedSignal.then(() => {
        throw new ContentFailure("CLOSED", "Draft queue is closed");
      }),
    ]));
  }
  async load(directory: string, path: string): Promise<CoreEditorDraftEntry | null> {
    this.checkRoot(directory);
    await this.initialize();
    if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
    const identity = key(directory, path);
    if (this.pending.has(identity) || this.discarding.has(identity))
      throw new ContentFailure("DRAFT_PENDING", "Wait for the pending draft before reloading it");
    const result = await this.call<CoreEditorDraftEntry | null>("editor_drafts_document", {
      directory,
      path,
    });
    if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
    if (result) this.known.set(identity, result);
    else this.known.delete(identity);
    return result;
  }
  put(draft: CoreEditorDraft): Promise<void> {
    return this.enqueue(draft.directory, draft.path, { ...draft });
  }
  remove(directory: string, path: string): Promise<void> {
    return this.enqueue(directory, path, null);
  }
  async discard(directory: string, path: string): Promise<void> {
    this.checkRoot(directory);
    const identity = key(directory, path);
    if (this.discarding.has(identity))
      throw new ContentFailure("DRAFT_BUSY", "This draft is already being discarded");
    this.discarding.add(identity);
    try {
      await this.initialize();
      while (this.pump && !this.closed) await Promise.race([this.pump, this.closedSignal]);
      if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
      const item = this.pending.get(identity);
      const actual = await this.call<CoreEditorDraftEntry | null>("editor_drafts_document", {
        directory,
        path,
      });
      if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
      // Explicit discard can remove our acknowledged/uncertain data, never another writer's draft.
      // 明确放弃只可删除本端已确认或未确认交付的数据，不能删除其他写入者的草稿。
      if (
        actual &&
        (actual.revision === this.known.get(identity)?.revision ||
          (item?.value && same(actual.draft, item.value)) ||
          (item?.attempted && same(actual.draft, item.attempted)))
      )
        await this.call("editor_drafts_remove", {
          directory,
          path,
          expectedDraftRevision: actual.revision,
        });
      if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
      this.pending.delete(identity);
      this.rejected.delete(identity);
      this.known.delete(identity);
    } finally {
      this.discarding.delete(identity);
    }
  }
  private checkRoot(directory: string) {
    if (this.directory !== undefined && directory !== this.directory)
      throw new ContentFailure("ROOT_DENIED", "Draft cannot select another project root");
  }
  private enqueue(directory: string, path: string, value: CoreEditorDraft | null): Promise<void> {
    try {
      if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
      this.checkRoot(directory);
      let units = value ? value.text.length + value.saved.length : 0;
      const identity = key(directory, path);
      if (this.discarding.has(identity))
        throw new ContentFailure("DRAFT_BUSY", "This draft is being discarded");
      for (const [other, pending] of this.pending)
        if (other !== identity && pending.value)
          units += pending.value.text.length + pending.value.saved.length;
      if (units > 16 * 1024 * 1024) {
        const failure = new ContentFailure(
          "DRAFT_BACKPRESSURE",
          "Draft saving is behind; save the file before continuing",
        );
        this.rejected.set(identity, failure);
        throw failure;
      }
      this.rejected.delete(identity);
      let pending = this.pending.get(identity);
      if (!pending) {
        pending = { directory, path, value, ticket: Symbol(), waiters: [] };
        this.pending.set(identity, pending);
      } else {
        // Keep the newest waiting text without changing the in-flight snapshot.
        // 只保留最新等待文本，不修改已经分发的快照。
        pending.value = value;
        pending.ticket = Symbol();
      }
      const result = new Promise<void>((resolve, reject) =>
        pending!.waiters.push({ resolve, reject }),
      );
      this.start();
      return result;
    } catch (reason) {
      return Promise.reject(reason);
    }
  }
  private start() {
    if (this.pump || this.closed) return;
    this.pump = this.run().finally(() => {
      this.pump = undefined;
      if (!this.closed && [...this.pending.values()].some((entry) => entry.failed !== entry.ticket))
        this.start();
    });
  }
  private async run() {
    try {
      await this.initialize();
    } catch (reason) {
      for (const item of this.pending.values()) {
        item.failed = item.ticket;
        item.error = reason;
        for (const waiter of item.waiters.splice(0)) waiter.reject(reason);
      }
      return;
    }
    for (;;) {
      const pair = [...this.pending].find(([, item]) => item.failed !== item.ticket);
      if (!pair || this.closed) return;
      const [identity, item] = pair;
      const ticket = item.ticket,
        value = item.value,
        waiters = item.waiters.splice(0);
      for (const waiter of waiters) this.active.add(waiter);
      try {
        let result: CoreEditorDraftEntry | null = null;
        let recovered = false;
        if (item.error !== undefined) {
          // Delivery can fail after commit; only identical data can advance the token.
          // 交付可能在提交后失败；只有确认数据完全一致才前移令牌。
          const actual = await this.call<CoreEditorDraftEntry | null>("editor_drafts_document", {
            directory: item.directory,
            path: item.path,
          });
          if (same(actual?.draft ?? null, value)) {
            result = actual;
            recovered = true;
          }
          if (
            recovered ||
            (item.attempted !== undefined && same(actual?.draft ?? null, item.attempted))
          ) {
            if (actual) this.known.set(identity, actual);
            else this.known.delete(identity);
          }
        }
        if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
        if (!recovered) {
          item.attempted = value;
          const expectedDraftRevision = this.known.get(identity)?.revision ?? null;
          result = value
            ? await this.call<CoreEditorDraftEntry>("editor_drafts_put", {
                expectedDraftRevision,
                draft: value,
              })
            : await this.call<null>("editor_drafts_remove", {
                expectedDraftRevision,
                directory: item.directory,
                path: item.path,
              });
        }
        if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
        if (result) this.known.set(identity, result);
        else this.known.delete(identity);
        item.error = undefined;
        item.failed = undefined;
        item.attempted = undefined;
        if (item.ticket === ticket) this.pending.delete(identity);
        for (const waiter of waiters) waiter.resolve();
      } catch (reason) {
        item.error = reason;
        item.failed = ticket;
        for (const waiter of waiters) waiter.reject(reason);
      } finally {
        for (const waiter of waiters) this.active.delete(waiter);
        if (!this.closed && item.ticket !== ticket && this.pending.get(identity) === item) {
          this.pending.delete(identity);
          this.pending.set(identity, item);
        }
      }
    }
  }
  async flush(): Promise<void> {
    if (this.ready && !this.initialized) await this.ready;
    while (this.pump && !this.closed) await Promise.race([this.pump, this.closedSignal]);
    if (this.closed) throw new ContentFailure("CLOSED", "Draft queue is closed");
    if (this.rejected.size) throw this.rejected.values().next().value;
    const failed = [...this.pending.values()].find((item) => item.error !== undefined);
    if (failed) throw failed.error;
  }
  async retry(): Promise<void> {
    if (!this.initialized) {
      this.ready = undefined;
      await this.initialize();
    }
    for (const item of this.pending.values()) item.failed = undefined;
    this.start();
    await this.flush();
  }
  close() {
    // A dispatched host write can commit after its delivery has been cancelled.
    // 已分发的宿主写入仍可能在结果交付取消后提交。
    this.closed = true;
    this.signalClose();
    const failure = new ContentFailure("CLOSED", "Draft queue is closed");
    for (const waiter of this.active) waiter.reject(failure);
    this.active.clear();
    for (const item of this.pending.values())
      for (const waiter of item.waiters.splice(0)) waiter.reject(failure);
    this.pending.clear();
    this.rejected.clear();
    this.known.clear();
    this.ready = undefined;
    this.legacy = undefined;
  }
}
