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
  const normalize = (value: string) => {
    const windows = /^[a-z]:[\\/]|^\\\\|^\/\//i.test(value);
    const normalized = value.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "");
    return (windows ? normalized.replace(/\\/g, "/") : normalized).replace(/\/+$/, "");
  };
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

export function gitReadError(reason: unknown): string {
  const message = String(reason);
  // A plain directory is an expected empty state, while other read failures remain visible.
  // 普通目录属于预期的空状态，其他读取失败仍需显示。
  return /(?:^|\n)(?:Error: )?fatal:\s*not a git repository(?:\s|\(|:|$)/i.test(message)
    ? ""
    : message;
}
