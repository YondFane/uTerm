import type {
  CoreEditorDraftSnapshot,
  CoreEditorRecoveryCatalog,
} from "./core-contract.generated.ts";
import { ContentFailure } from "./content-transport.ts";
import { draftKey } from "./file-document.ts";
import type { EditorRecoveryOptions } from "./editor-drafts.ts";

type Call = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type DraftStorage = Pick<Storage, "getItem" | "setItem">;
export const editorDraftReceiptKey = `${draftKey}.shared-v1`;
let activeRecovery: EditorRecoveryOptions | undefined;
export function sharedEditorRecovery(): EditorRecoveryOptions | undefined {
  return activeRecovery;
}
export function enableSharedEditorRecovery(
  snapshot: CoreEditorDraftSnapshot,
  legacy: string | null,
): void {
  let initialFile: EditorRecoveryOptions["initialFile"];
  try {
    const previous = JSON.parse(legacy ?? "null");
    const draft = snapshot.document.drafts.find(
      (item) => item.directory === previous?.directory && item.path === previous?.path,
    );
    if (draft) initialFile = { directory: draft.directory, path: draft.path };
  } catch {}
  activeRecovery = { initialFile };
}
interface Receipt {
  version: 1;
  legacyDigest: string;
  sharedSourceDigest: string | null;
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function acknowledged(
  raw: string | null,
  legacyDigest: string,
  sourceDigest: string | null,
): boolean {
  try {
    const value = JSON.parse(raw ?? "null") as Receipt | null;
    return (
      value?.version === 1 &&
      value.legacyDigest === legacyDigest &&
      value.sharedSourceDigest === sourceDigest
    );
  } catch {
    return false;
  }
}

export class EditorDraftHandoff {
  readonly legacy: string | null;
  private sourceDigest?: string;
  private conflicting = false;
  get canAcceptShared(): boolean {
    return this.conflicting;
  }
  private readonly call: Call;
  private readonly storage: DraftStorage;
  constructor(call: Call, storage: DraftStorage) {
    this.call = call;
    this.storage = storage;
    this.legacy = storage.getItem(draftKey);
  }
  private unchanged(): void {
    if (this.storage.getItem(draftKey) !== this.legacy)
      throw new ContentFailure(
        "MIGRATION_CHANGED",
        "The old editor draft changed. Reload before choosing recovery data.",
      );
  }
  private async retain(): Promise<void> {
    this.unchanged();
    if (this.legacy === null) return;
    this.sourceDigest ??= await digest(this.legacy);
    this.unchanged();
    const key = `${draftKey}.shared-v1-backup.${this.sourceDigest}`;
    const existing = this.storage.getItem(key);
    if (existing !== null && existing !== this.legacy)
      throw new ContentFailure(
        "DRAFT_BACKUP_CONFLICT",
        "The versioned old editor draft backup differs; original data was retained.",
      );
    if (existing === null) this.storage.setItem(key, this.legacy);
    if (this.storage.getItem(key) !== this.legacy)
      throw new ContentFailure(
        "DRAFT_BACKUP_FAILED",
        "The old editor draft backup could not be verified.",
      );
  }
  private activate(snapshot: CoreEditorDraftSnapshot): CoreEditorDraftSnapshot {
    this.unchanged();
    if (this.sourceDigest) {
      const receipt: Receipt = {
        version: 1,
        legacyDigest: this.sourceDigest,
        sharedSourceDigest: snapshot.document.sourceDigest ?? null,
      };
      this.storage.setItem(editorDraftReceiptKey, JSON.stringify(receipt));
      if (
        !acknowledged(
          this.storage.getItem(editorDraftReceiptKey),
          receipt.legacyDigest,
          receipt.sharedSourceDigest,
        )
      )
        throw new ContentFailure(
          "DRAFT_RECEIPT_FAILED",
          "The editor draft handoff could not be recorded. Old data was retained.",
        );
      this.unchanged();
    }
    return snapshot;
  }
  async initialize(): Promise<CoreEditorDraftSnapshot> {
    this.conflicting = false;
    await this.retain();
    let snapshot: CoreEditorDraftSnapshot;
    try {
      snapshot = (await this.call("editor.drafts.read")) as CoreEditorDraftSnapshot;
    } catch (reason) {
      if ((reason as { code?: string }).code !== "DRAFTS_NOT_IMPORTED") throw reason;
      snapshot = (await this.call("editor.drafts.import", {
        legacy: this.legacy,
      })) as CoreEditorDraftSnapshot;
      return this.activate(snapshot);
    }
    if (this.legacy === null) return this.activate(snapshot);
    if (
      acknowledged(
        this.storage.getItem(editorDraftReceiptKey),
        this.sourceDigest!,
        snapshot.document.sourceDigest ?? null,
      )
    ) {
      const catalog = (await this.call("editor.drafts.recovery.list")) as CoreEditorRecoveryCatalog;
      if (catalog.sources.includes(this.sourceDigest!)) {
        this.unchanged();
        return snapshot;
      }
    }
    try {
      snapshot = (await this.call("editor.drafts.import", {
        legacy: this.legacy,
      })) as CoreEditorDraftSnapshot;
    } catch (reason) {
      this.conflicting = (reason as { code?: string }).code === "MIGRATION_CONFLICT";
      throw reason;
    }
    return this.activate(snapshot);
  }
  async acceptShared(): Promise<CoreEditorDraftSnapshot> {
    this.unchanged();
    if (!this.conflicting || !this.sourceDigest)
      throw new ContentFailure(
        "MIGRATION_CHOICE",
        "Read and retain both draft sources before choosing shared drafts.",
      );
    const catalog = (await this.call("editor.drafts.recovery.list")) as CoreEditorRecoveryCatalog;
    if (!catalog.sources.includes(this.sourceDigest))
      throw new ContentFailure(
        "MIGRATION_SOURCE_MISSING",
        "The old draft source has not been retained by the shared core.",
      );
    const snapshot = (await this.call("editor.drafts.read")) as CoreEditorDraftSnapshot;
    return this.activate(snapshot);
  }
}
