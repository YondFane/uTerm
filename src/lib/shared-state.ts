import { invoke } from "@tauri-apps/api/core";
import { readWorkspace, workspaceKey, type Workspace } from "./workspace";
import { readSettings, settingsKey, type Settings } from "./settings";
import type { CoreRequest, CoreResponse, CoreSnapshot, JSONValue } from "./core-contract.generated";

let snapshot: CoreSnapshot | undefined;
let tail: Promise<unknown> = Promise.resolve();
let failure: unknown;

export async function coreRequest(method: string, params: unknown = null): Promise<JSONValue> {
  const id = crypto.randomUUID();
  const request: CoreRequest = { version: 1, id, method, params: params as JSONValue };
  const response = JSON.parse(
    await invoke<string>("shared_core_request", { request: JSON.stringify(request) }),
  ) as CoreResponse;
  if (response.version !== 1 || response.id !== id) throw Error("Invalid shared core response");
  if (response.error)
    throw Object.assign(Error(response.error.message), { code: response.error.code });
  return response.result ?? null;
}

async function readSharedState(): Promise<void> {
  try {
    snapshot = (await coreRequest("snapshot.read")) as unknown as CoreSnapshot;
  } catch (reason) {
    if ((reason as { code?: string }).code !== "NOT_IMPORTED") throw reason;
    const legacy: Record<string, string> = {};
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("uterm.")) {
        const value = localStorage.getItem(key);
        if (value !== null) legacy[key] = value;
      }
    }
    snapshot = (await coreRequest("migration.import", {
      legacy,
      workspace: readWorkspace(localStorage.getItem(workspaceKey)),
      settings: readSettings(localStorage.getItem(settingsKey)),
    })) as unknown as CoreSnapshot;
  }
  failure = undefined;
}

export function initializeSharedState(): Promise<void> {
  const run = tail.then(readSharedState);
  tail = run.catch(() => {});
  return run;
}

export function sharedWorkspace(): Workspace | undefined {
  return snapshot?.document.workspace as unknown as Workspace | undefined;
}
export function sharedSettings(): Settings | undefined {
  return snapshot?.document.settings as unknown as Settings | undefined;
}
export function canonicalStateActive(): boolean {
  return snapshot !== undefined;
}

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const run = tail.then(async () => {
    if (failure) throw failure;
    try {
      return await operation();
    } catch (reason) {
      const code = (reason as { code?: string }).code;
      if (!code || ["CONFLICT", "IO", "CORRUPT_STORE", "UNSUPPORTED_SCHEMA"].includes(code))
        failure = reason;
      throw reason;
    }
  });
  tail = run.catch(() => {});
  return run;
}

export function persistWorkspace(change: (workspace: Workspace) => Workspace): Promise<Workspace> {
  return serial(async () => {
    if (!snapshot) throw Error("Shared state is not initialized");
    const next = change(structuredClone(snapshot.document.workspace) as unknown as Workspace);
    snapshot = (await coreRequest("snapshot.replace", {
      expectedRevision: snapshot.revision,
      workspace: next,
      settings: snapshot.document.settings,
    })) as unknown as CoreSnapshot;
    return snapshot.document.workspace as unknown as Workspace;
  });
}

export function refreshSharedWorktrees(id: string): Promise<Workspace> {
  return serial(async () => {
    if (!snapshot) throw Error("Shared state is not initialized");
    snapshot = (await coreRequest("project.worktrees.refresh", {
      id,
      expectedRevision: snapshot.revision,
    })) as unknown as CoreSnapshot;
    return snapshot.document.workspace as unknown as Workspace;
  });
}

export function persistSettings(change: (settings: Settings) => Settings): Promise<Settings> {
  return serial(async () => {
    if (!snapshot) throw Error("Shared state is not initialized");
    const next = change(structuredClone(snapshot.document.settings) as unknown as Settings);
    snapshot = (await coreRequest("snapshot.replace", {
      expectedRevision: snapshot.revision,
      workspace: snapshot.document.workspace,
      settings: next,
    })) as unknown as CoreSnapshot;
    return snapshot.document.settings as unknown as Settings;
  });
}

export async function flushSharedState(): Promise<void> {
  for (;;) {
    const observed = tail;
    await observed;
    if (observed === tail) break;
  }
  if (failure) throw failure;
}
