import { gitFilePath, type GitSnapshot } from "./git-snapshot.ts";

export type GitFileState = "modified" | "added" | "untracked" | "deleted" | "renamed" | "conflict";

export type GitTreeSnapshot = Pick<GitSnapshot, "root" | "changes" | "truncated">;

const priority: Record<GitFileState, number> = {
  untracked: 0,
  added: 1,
  deleted: 2,
  renamed: 3,
  modified: 4,
  conflict: 5,
};

export function gitFileKey(directory: string, path: string): string {
  return /^[a-z]:[\\/]|^\\\\|^\/\//i.test(directory)
    ? path.replace(/\\/g, "/").toLowerCase()
    : path;
}

function fileState(index: string, working: string): GitFileState | null {
  const values = [index, working];
  if (values.includes("U") || index + working === "AA" || index + working === "DD")
    return "conflict";
  if (values.includes("M") || values.includes("T")) return "modified";
  if (values.includes("R")) return "renamed";
  if (values.includes("D")) return "deleted";
  if (values.includes("A") || values.includes("C")) return "added";
  if (values.includes("?")) return "untracked";
  return null;
}

export function gitFileStates(
  directory: string,
  snapshot: GitTreeSnapshot | null,
): ReadonlyMap<string, GitFileState> {
  const states = new Map<string, GitFileState>();
  if (!snapshot) return states;
  const root = snapshot.root;
  function collect(path: string, state: GitFileState, parentsOnly = false) {
    // Git reports embedded untracked repositories as directory entries with a trailing slash.
    // Git 会将未跟踪的内嵌仓库报告为带末尾斜杠的目录项。
    const relative = gitFilePath(directory, root, path.endsWith("/") ? path.slice(0, -1) : path);
    if (!relative) return;
    const parts = relative.split("/");
    if (parentsOnly) parts.pop();
    while (parts.length) {
      const key = gitFileKey(directory, parts.join("/"));
      const previous = states.get(key);
      if (!previous || priority[state] > priority[previous]) states.set(key, state);
      parts.pop();
    }
  }
  for (const change of snapshot.changes) {
    const state = fileState(change.index, change.working);
    if (state) collect(change.path, state);
    if (change.original && [change.index, change.working].includes("R")) {
      // The original location may contain a new file; only its parent folders inherit deletion.
      // 原位置可能已有新文件，仅向原路径的父目录汇总删除状态。
      collect(change.original, "deleted", true);
    }
  }
  return states;
}
