// Generated from uterm-core Rust DTOs; run pnpm contracts:generate.
// 由 uterm-core Rust DTO 生成；执行 pnpm contracts:generate。
export type JSONValue =
  null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

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

export interface CoreSnapshot {
  document: CoreDocument;
  revision: string;
}
