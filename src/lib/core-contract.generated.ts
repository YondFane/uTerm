// Generated from uterm-core Rust DTOs; run pnpm contracts:generate.
// 由 uterm-core Rust DTO 生成；执行 pnpm contracts:generate。
export type JSONValue =
  null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

export interface CoreActivityEvent {
  id: string;
  kind: string;
  sequence: bigint;
  source: string;
}

export interface CoreCoreError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface CoreDocument {
  legacy: Record<string, string>;
  migrationId: string;
  schemaVersion: number;
  settings: JSONValue;
  workspace: JSONValue;
}

export interface CoreEvent {
  kind: string;
  operationId: string;
  revision: string;
  version: number;
}

export interface CoreImport {
  legacy: Record<string, string>;
  settings: JSONValue;
  workspace: JSONValue;
}

export interface CoreRequest {
  id: string;
  method: string;
  params?: JSONValue;
  version: number;
}

export interface CoreResponse {
  error?: CoreCoreError | null;
  id: string;
  result?: JSONValue;
  version: number;
}

export interface CoreSessionEntry {
  directory: string;
  projectId?: string | null;
  rosterId: string;
  session: JSONValue;
  workspaceId: string;
}

export interface CoreSnapshot {
  document: CoreDocument;
  revision: string;
}

export interface CoreTerminalHeader {
  agent_activity_error: string | null;
  agent_events: CoreActivityEvent[] | null;
  agent_state: string | null;
  attachment?: string | null;
  code: number | null;
  cols: number;
  error: string | null;
  exited: boolean;
  foreground_agent: string | null;
  generation?: string | null;
  reset: boolean;
  rows: number;
  sequence: bigint;
}

export interface CoreViewSnapshot {
  layout: JSONValue;
  sessions: CoreSessionEntry[];
  snapshot: CoreSnapshot;
}
