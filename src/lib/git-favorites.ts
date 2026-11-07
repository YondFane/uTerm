import type { CoreGitFavorites } from "./core-contract.generated.ts";
import { ContentFailure } from "./content-transport.ts";

type Call = <T>(method: string, params: Record<string, unknown>) => Promise<T>;
type StoragePort = Pick<Storage, "getItem" | "setItem">;
async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export class SharedGitFavorites {
  private readonly key: string;
  private readonly directory: string;
  private readonly call: Call;
  private readonly storage?: StoragePort;
  private readonly legacy: string | null;
  private legacyDigest?: string;
  private snapshot?: CoreGitFavorites;
  private closed = false;
  private pending = false;
  private epoch = 0;
  private conflicting = false;
  private sharedExists = false;
  private wakeClosed!: () => void;
  private readonly closedSignal = new Promise<void>((resolve) => {
    this.wakeClosed = resolve;
  });
  constructor(directory: string, repository: string, call: Call, storage?: StoragePort) {
    this.directory = directory;
    this.call = call;
    this.storage = storage;
    this.key = `uterm.git.favorites:${repository}`;
    this.legacy = storage?.getItem(this.key) ?? null;
  }
  get canAcceptShared(): boolean {
    return this.conflicting && this.legacy !== null && !this.closed;
  }
  get oldSource(): string | null {
    return this.legacy;
  }
  get hasSharedData(): boolean {
    return this.sharedExists;
  }
  private unchanged(): void {
    if (this.closed) throw new ContentFailure("CLOSED", "Git favorites are closed");
    if (this.storage && this.storage.getItem(this.key) !== this.legacy)
      throw new ContentFailure(
        "MIGRATION_CHANGED",
        "Old Git favorites changed. Reload before choosing recovery data.",
      );
  }
  private async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<CoreGitFavorites> {
    for (let attempt = 0; ; attempt++) {
      this.unchanged();
      try {
        const result = await this.call<CoreGitFavorites>(method, {
          directory: this.directory,
          ...params,
        });
        if (this.closed) throw new ContentFailure("CLOSED", "Git favorites are closed");
        return result;
      } catch (reason) {
        if (this.closed) throw new ContentFailure("CLOSED", "Git favorites are closed");
        if (
          method !== "git_favorites_read" ||
          (reason as { code?: string }).code !== "WRITER_BUSY" ||
          attempt >= 6 ||
          this.closed
        )
          throw reason;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.min(20 * 2 ** attempt, 160));
          }),
          this.closedSignal,
        ]);
        clearTimeout(timer);
      }
    }
  }
  private async retain(): Promise<void> {
    this.unchanged();
    if (!this.storage || this.legacy === null) return;
    this.legacyDigest ??= await digest(this.legacy);
    this.unchanged();
    const key = `${this.key}.shared-v1-backup.${this.legacyDigest}`;
    const existing = this.storage.getItem(key);
    if (existing !== null && existing !== this.legacy)
      throw new ContentFailure(
        "FAVORITES_BACKUP_CONFLICT",
        "The old Git favorite backup differs; original data was retained.",
      );
    if (existing === null) this.storage.setItem(key, this.legacy);
    if (this.storage.getItem(key) !== this.legacy)
      throw new ContentFailure(
        "FAVORITES_BACKUP_FAILED",
        "The old Git favorite backup could not be verified.",
      );
  }
  private activate(snapshot: CoreGitFavorites): CoreGitFavorites {
    this.unchanged();
    if (this.storage && this.legacyDigest) {
      const key = `${this.key}.shared-v1`;
      const receipt = JSON.stringify({
        version: 1,
        legacyDigest: this.legacyDigest,
        sourceDigest: snapshot.sourceDigest,
      });
      this.storage.setItem(key, receipt);
      if (this.storage.getItem(key) !== receipt)
        throw new ContentFailure(
          "FAVORITES_BACKUP_FAILED",
          "The Git favorite handoff could not be verified.",
        );
    }
    this.snapshot = snapshot;
    this.sharedExists = snapshot.revision !== null;
    this.conflicting = false;
    return snapshot;
  }
  async initialize(): Promise<CoreGitFavorites> {
    await this.retain();
    try {
      if (this.storage && this.legacyDigest) {
        const current = await this.request("git_favorites_read");
        this.sharedExists = current.revision !== null;
        let receipt: {
          version?: number;
          legacyDigest?: string;
          sourceDigest?: string | null;
        } | null = null;
        try {
          receipt = JSON.parse(this.storage.getItem(`${this.key}.shared-v1`) ?? "null");
        } catch {}
        if (
          receipt?.version === 1 &&
          receipt.legacyDigest === this.legacyDigest &&
          receipt.sourceDigest === current.sourceDigest
        )
          return this.activate(
            await this.request("git_favorites_accept_shared", { legacy: this.legacy }),
          );
      }
      return this.activate(
        await this.request(
          "git_favorites_import",
          this.legacy === null ? {} : { legacy: this.legacy },
        ),
      );
    } catch (reason) {
      this.conflicting = ["FAVORITES_SOURCE_CONFLICT", "INVALID_FAVORITES"].includes(
        (reason as { code?: string }).code ?? "",
      );
      throw reason;
    }
  }
  async acceptShared(): Promise<CoreGitFavorites> {
    if (!this.canAcceptShared || this.legacy === null)
      throw new ContentFailure(
        "FAVORITES_SOURCE_CONFLICT",
        "Archive old Git favorites before continuing",
      );
    return this.activate(
      await this.request("git_favorites_accept_shared", { legacy: this.legacy }),
    );
  }
  async refresh(): Promise<CoreGitFavorites> {
    if (!this.snapshot) return this.initialize();
    const epoch = this.epoch;
    const snapshot = await this.request("git_favorites_read");
    if (epoch === this.epoch && !this.pending) this.snapshot = snapshot;
    return this.snapshot;
  }
  async write(references: string[]): Promise<CoreGitFavorites> {
    this.unchanged();
    if (!this.snapshot || this.pending)
      throw new ContentFailure("FAVORITES_BUSY", "Finish loading or saving Git favorites first.");
    this.pending = true;
    this.epoch++;
    try {
      this.snapshot = await this.request("git_favorites_write", {
        expectedRevision: this.snapshot.revision,
        references,
      });
      this.unchanged();
      return this.snapshot;
    } finally {
      this.pending = false;
    }
  }
  close(): void {
    this.closed = true;
    this.wakeClosed();
  }
}
