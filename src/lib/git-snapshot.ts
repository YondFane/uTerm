export interface GitChange {
  path: string;
  original: string | null;
  index: string;
  working: string;
}

export interface GitSnapshot {
  root: string;
  branch: string;
  head?: string | null;
  references: string[];
  changes: GitChange[];
  truncated: boolean;
}

export function gitFilePath(directory: string, root: string, path: string): string | null {
  const normalize = (value: string) =>
    value
      .replace(/^\\\\\?\\UNC\\/i, "//")
      .replace(/^\\\\\?\\/, "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
  const prefix = `${normalize(directory)}/`;
  const target = `${normalize(root)}/${path}`;
  const windows = /^[a-z]:\//i.test(target) || target.startsWith("//");
  if (
    !(windows ? target.toLowerCase().startsWith(prefix.toLowerCase()) : target.startsWith(prefix))
  )
    return null;
  const relative = target.slice(prefix.length);
  return relative && relative.split("/").every((part) => part && part !== "." && part !== "..")
    ? relative
    : null;
}

export function sameGitSnapshot(previous: GitSnapshot | null, next: GitSnapshot): boolean {
  if (
    !previous ||
    previous.root !== next.root ||
    previous.branch !== next.branch ||
    previous.head !== next.head ||
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
