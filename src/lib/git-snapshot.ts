export interface GitChange {
  path: string;
  original: string | null;
  index: string;
  working: string;
}

export interface GitSnapshot {
  root: string;
  branch: string;
  references: string[];
  changes: GitChange[];
  truncated: boolean;
}

export function sameGitSnapshot(previous: GitSnapshot | null, next: GitSnapshot): boolean {
  if (
    !previous ||
    previous.root !== next.root ||
    previous.branch !== next.branch ||
    previous.truncated !== next.truncated ||
    previous.references.length !== next.references.length ||
    previous.changes.length !== next.changes.length
  ) {
    return false;
  }
  for (let index = 0; index < next.references.length; index++) {
    if (previous.references[index] !== next.references[index]) return false;
  }
  for (let index = 0; index < next.changes.length; index++) {
    const before = previous.changes[index];
    const after = next.changes[index];
    if (
      before.path !== after.path ||
      before.original !== after.original ||
      before.index !== after.index ||
      before.working !== after.working
    ) {
      return false;
    }
  }
  return true;
}
