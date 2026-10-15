import { translate } from "./i18n.ts";
import type { GitChange } from "./git-snapshot";

export interface DiffCell {
  text: string;
  line: number;
  kind: "context" | "added" | "removed";
}
export interface DiffRow {
  left?: DiffCell;
  right?: DiffCell;
  header?: string;
}

export function hasCurrentWorkingDiff(
  changes: readonly GitChange[],
  path: string,
  mode: string,
): boolean {
  const change = changes.find((candidate) => candidate.path === path);
  if (!change) return false;
  if (mode === "staged") return change.index !== " " && change.index !== "?";
  return mode === "working" && change.working !== " ";
}

export function isStaleWorkingDiffError(reason: unknown): boolean {
  return ["zh-Hans", "en"].some((language) =>
    String(reason).includes(translate(language as "zh-Hans" | "en", "文件已变化，请刷新列表。")),
  );
}

export function sideBySideDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let removed: DiffCell[] = [];
  let added: DiffCell[] = [];
  function flush() {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      rows.push({ left: removed[index], right: added[index] });
    }
    removed = [];
    added = [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
      rows.push({ header: line });
    } else if (oldRemaining > 0 && line.startsWith("-")) {
      removed.push({ text: line.slice(1), line: oldLine++, kind: "removed" });
      oldRemaining--;
    } else if (newRemaining > 0 && line.startsWith("+")) {
      added.push({ text: line.slice(1), line: newLine++, kind: "added" });
      newRemaining--;
    } else if (oldRemaining > 0 && newRemaining > 0 && line.startsWith(" ")) {
      flush();
      rows.push({
        left: { text: line.slice(1), line: oldLine++, kind: "context" },
        right: { text: line.slice(1), line: newLine++, kind: "context" },
      });
      oldRemaining--;
      newRemaining--;
    } else {
      flush();
      rows.push({ header: line });
    }
  }
  flush();
  return rows;
}
