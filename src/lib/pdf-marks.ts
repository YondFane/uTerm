import { contentInvoke, isContentHost } from "./content-host";
import { tx } from "./i18n";

export interface PdfMark {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PdfMarkTarget {
  directory: string;
  path: string;
  version: string;
}
interface Snapshot {
  revision: string;
  marks: PdfMark[];
}
type Change = { kind: "add"; mark: PdfMark } | { kind: "remove"; id: string };
const fields = ["id", "page", "x", "y", "width", "height"] as const;

export function parsePdfMarks(value: unknown): PdfMark[] {
  if (!Array.isArray(value) || value.length > 2000)
    throw Error(tx("PDF 高亮记录无效，原记录已保留。"));
  const ids = new Set<string>();
  return value.map((mark) => {
    if (
      !mark ||
      typeof mark !== "object" ||
      Object.keys(mark).some((key) => !fields.includes(key as (typeof fields)[number])) ||
      typeof mark.id !== "string" ||
      !mark.id ||
      mark.id.length > 200 ||
      mark.id.includes("\0") ||
      ids.has(mark.id) ||
      !Number.isInteger(mark.page) ||
      mark.page <= 0 ||
      mark.page > 0xffffffff ||
      ![mark.x, mark.y, mark.width, mark.height].every(
        (n) => Number.isFinite(n) && n >= 0 && n <= 1,
      ) ||
      mark.x + mark.width > 1 + 1e-8 ||
      mark.y + mark.height > 1 + 1e-8
    )
      throw Error(tx("PDF 高亮记录无效，原记录已保留。"));
    ids.add(mark.id);
    return Object.fromEntries(fields.map((key) => [key, mark[key]])) as unknown as PdfMark;
  });
}
function key(target: PdfMarkTarget): string {
  return `uterm.pdf.marks:${target.directory}/${target.path}:${target.version}`;
}
function snapshot(value: unknown): Snapshot {
  const row = value as Snapshot;
  if (!row || typeof row.revision !== "string" || !/^[a-f0-9]{64}$/i.test(row.revision))
    throw Error(tx("PDF 高亮记录无效，原记录已保留。"));
  return { revision: row.revision, marks: parsePdfMarks(row.marks) };
}
async function read(target: PdfMarkTarget): Promise<Snapshot> {
  if (isContentHost()) return snapshot(await contentInvoke("pdf_marks_read", { ...target }));
  const revision = localStorage.getItem(key(target)) ?? "[]";
  return { revision, marks: parsePdfMarks(JSON.parse(revision)) };
}
async function write(target: PdfMarkTarget, expected: string, marks: PdfMark[]): Promise<Snapshot> {
  if (isContentHost())
    return snapshot(
      await contentInvoke("pdf_marks_write", { ...target, expectedRevision: expected, marks }),
    );
  const current = localStorage.getItem(key(target)) ?? "[]";
  if (current !== expected)
    throw Object.assign(Error(tx("高亮已被其他窗口修改，请明确重试。")), { code: "CONFLICT" });
  const revision = JSON.stringify(marks);
  localStorage.setItem(key(target), revision);
  return { revision, marks: structuredClone(marks) };
}

export class PdfMarkSession {
  private snapshot?: Snapshot;
  private pending?: Change;
  private busy = false;
  private readonly target: PdfMarkTarget;
  constructor(target: PdfMarkTarget) {
    this.target = { directory: target.directory, path: target.path, version: target.version };
  }
  get hasPending(): boolean {
    return this.pending !== undefined;
  }
  private apply(marks: PdfMark[], change: Change): PdfMark[] {
    if (change.kind === "remove") return marks.filter((mark) => mark.id !== change.id);
    const existing = marks.find((mark) => mark.id === change.mark.id);
    if (existing) {
      if (
        existing.page !== change.mark.page ||
        (["x", "y", "width", "height"] as const).some(
          (key) => Math.abs(existing[key] - change.mark[key]) > 1e-12,
        )
      )
        throw Object.assign(Error(tx("高亮已被其他窗口修改，请明确重试。")), { code: "CONFLICT" });
      return marks;
    }
    return [...marks, change.mark];
  }
  preview(): PdfMark[] {
    const marks = this.snapshot?.marks ?? [];
    try {
      return structuredClone(this.pending ? this.apply(marks, this.pending) : marks);
    } catch {
      return structuredClone(marks);
    }
  }
  committed(): PdfMark[] {
    return structuredClone(this.snapshot?.marks ?? []);
  }
  async load(): Promise<PdfMark[]> {
    if (this.busy || this.pending) throw Error(tx("请先重试或取消未保存的高亮。"));
    this.busy = true;
    try {
      this.snapshot = await read(this.target);
      return this.preview();
    } finally {
      this.busy = false;
    }
  }
  private async change(change: Change, refresh = false): Promise<PdfMark[]> {
    if (this.busy || (!refresh && this.pending)) throw Error(tx("请先重试或取消未保存的高亮。"));
    this.busy = true;
    try {
      if (refresh) this.snapshot = await read(this.target);
      if (!this.snapshot) throw Error(tx("高亮记录无法读取，未覆盖原记录。"));
      const values = this.apply(this.snapshot.marks, change);
      if (values.length > 2000)
        throw Error(tx("当前文件最多保存 2,000 个高亮，请先删除部分高亮。"));
      const next = parsePdfMarks(values);
      this.pending = structuredClone(change);
      this.snapshot = await write(this.target, this.snapshot.revision, next);
      this.pending = undefined;
      return this.preview();
    } finally {
      this.busy = false;
    }
  }
  add(mark: PdfMark): Promise<PdfMark[]> {
    return this.change({ kind: "add", mark: parsePdfMarks([mark])[0] });
  }
  remove(id: string): Promise<PdfMark[]> {
    return this.change({ kind: "remove", id });
  }
  async retry(): Promise<PdfMark[]> {
    // Only an explicit retry rereads and reapplies this one change, preserving other windows' marks.
    // 只有明确重试才重读并重新应用这一项修改，保留其他窗口的高亮。
    return this.pending ? this.change(this.pending, true) : this.load();
  }
  discard(): PdfMark[] {
    if (this.busy) throw Error(tx("请先重试或取消未保存的高亮。"));
    this.pending = undefined;
    return this.preview();
  }
}
