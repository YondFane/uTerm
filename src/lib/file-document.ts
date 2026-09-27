import { tx } from "./i18n.ts";
export interface FileData {
  kind: "text" | "image" | "pdf";
  text: string;
  version: string;
  line_ending: string;
  bom: boolean;
  readonly: boolean;
  notice: string | null;
}
export interface OpenFile extends FileData {
  id: number;
  directory: string;
  path: string;
  saved: string;
  line?: number;
  jump: number;
}
export function clipboardPath(path: string): string {
  const windows = path.replace(/\//g, "\\");
  if (/^\\\\\?\\[a-z]:\\/i.test(windows)) return windows.slice(4);
  if (/^\\\\\?\\UNC\\/i.test(windows)) return `\\\\${windows.slice(8)}`;
  return /^[a-z]:[\\/]|^\\\\/i.test(path) ? windows : path;
}
export function fileBytes(document: Pick<FileData, "text" | "bom">): string {
  return `${document.bom ? "\ufeff" : ""}${document.text}`;
}
export function editorText(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}
export function documentText(text: string, separator: string): string {
  return editorText(text).replace(/\n/g, separator);
}
export function isDirty(document: OpenFile | null): boolean {
  return !!document && document.kind === "text" && document.text !== document.saved;
}
export function savedVersion(current: OpenFile, snapshot: OpenFile, version: string): OpenFile {
  // Only mark the written snapshot saved; typing may have continued during the write.
  // 只将实际写入的快照标为已保存，避免覆盖写入期间用户继续输入的内容。
  return current.id === snapshot.id ? { ...current, saved: snapshot.text, version } : current;
}
export const draftKey = "uterm.desktop.editorDraft.v1";
export function readDraft(serialized: string): OpenFile {
  const value = JSON.parse(serialized);
  if (
    value?.kind !== "text" ||
    typeof value.directory !== "string" ||
    !value.directory ||
    typeof value.path !== "string" ||
    !value.path ||
    typeof value.text !== "string" ||
    typeof value.saved !== "string" ||
    value.text.length > 2 * 1024 * 1024 ||
    value.saved.length > 2 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(value.version) ||
    typeof value.bom !== "boolean" ||
    !["\n", "\r\n", "\r"].includes(value.line_ending)
  )
    throw new Error(tx("无法读取编辑器草稿，原数据已保留。"));
  return {
    id: 0,
    directory: value.directory,
    path: value.path,
    kind: "text",
    text: value.text,
    saved: value.saved,
    version: value.version,
    bom: value.bom,
    line_ending: value.line_ending,
    readonly: false,
    notice: tx("已恢复未保存的草稿。保存前会检查磁盘版本。"),
    jump: 0,
  };
}

export class DocumentSaveQueue {
  private active: Promise<boolean> | null = null;

  async run(write: () => Promise<boolean>): Promise<boolean> {
    // Every waiter must recheck: another save may have acquired the slot first.
    // 每个等待者都必须重新检查，其他保存请求可能已先占用写入位置。
    while (this.active) {
      if (!(await this.active)) return false;
    }
    const operation = Promise.resolve().then(write);
    this.active = operation;
    try {
      return await operation;
    } finally {
      if (this.active === operation) this.active = null;
    }
  }
}
