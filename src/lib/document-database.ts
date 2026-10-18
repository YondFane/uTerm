import type { DatabaseKind } from "./database.ts";

export interface DatabaseDocument {
  value: string;
  identity: string;
  version?: string;
}
export interface DocumentResult {
  names?: string[];
  documents?: DatabaseDocument[];
  more?: boolean;
  metadata?: string;
  affected?: number;
}
export const documentQuery = (kind: DatabaseKind) =>
  kind === "elasticsearch"
    ? '{\n  "query": { "match_all": {} }\n}'
    : '{\n  "filter": {},\n  "sort": { "_id": 1 }\n}';

export function validDocumentJson(text: string): boolean {
  if (text.length > 262144) return false;
  try {
    const value: unknown = JSON.parse(text);
    return !!value && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}
