export interface GitReference {
  kind: "head" | "local" | "remote" | "tag";
  name: string;
  full_name: string;
  oid: string | null;
  current: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  worktree: string | null;
  remote: string | null;
  branch: string | null;
}
export interface ReferenceCatalog {
  root?: string;
  repository: string;
  current: string | null;
  remotes: string[];
  references: GitReference[];
}
export interface ReferenceNode {
  id: string;
  label: string;
  parent?: string;
  remote?: string;
  reference?: GitReference;
  children: ReferenceNode[];
}
export interface ReferenceViewState {
  selected: string;
  search: string;
  collapsed: string[];
  folded: boolean;
}
const views = new Map<string, ReferenceViewState>();
export function referenceView(directory: string): ReferenceViewState {
  return views.get(directory) ?? { selected: "HEAD", search: "", collapsed: [], folded: false };
}
export function rememberReferenceView(directory: string, state: ReferenceViewState) {
  views.set(directory, state);
}
export function mergeRemoteReferences(
  local: GitReference[],
  advertised: { remote: string; branch: string }[],
): GitReference[] {
  const result = new Map(local.map((item) => [item.full_name, item]));
  for (const { remote, branch } of advertised) {
    const full_name = `refs/remotes/${remote}/${branch}`;
    if (!result.has(full_name))
      result.set(full_name, {
        kind: "remote",
        name: `${remote}/${branch}`,
        full_name,
        oid: null,
        current: false,
        upstream: null,
        ahead: null,
        behind: null,
        worktree: null,
        remote,
        branch,
      });
  }
  return [...result.values()];
}
export function referenceTree(
  references: GitReference[],
  favorites: ReadonlySet<string>,
  search = "",
): ReferenceNode[] {
  const groups: ReferenceNode[] = ["local", "remote", "tag"].map((id) => ({
    id,
    label: id,
    children: [],
  }));
  const result: ReferenceNode[] = [];
  const query = search.toLocaleLowerCase();
  for (const reference of references) {
    if (query && !reference.name.toLocaleLowerCase().includes(query)) continue;
    if (reference.kind === "head") {
      result.push({ id: reference.full_name, label: "HEAD", reference, children: [] });
      continue;
    }
    let parent = groups.find((group) => group.id === reference.kind)!;
    const parts =
      reference.kind === "remote" && reference.remote
        ? [reference.remote, ...(reference.branch ?? "").split("/")]
        : reference.name.split("/");
    for (const [index, label] of parts.entries()) {
      const leaf = index === parts.length - 1;
      const id = leaf ? reference.full_name : `${parent.id}/${label}`;
      let node = parent.children.find((item) => item.id === id);
      if (!node) {
        node = { id, label, parent: parent.id, children: [], ...(leaf ? { reference } : {}) };
        if (reference.kind === "remote" && index === 0) node.remote = reference.remote ?? undefined;
        parent.children.push(node);
      }
      parent = node;
    }
  }
  const sort = (nodes: ReferenceNode[]) => {
    nodes.sort(
      (a, b) =>
        Number(favorites.has(b.id)) - Number(favorites.has(a.id)) || a.label.localeCompare(b.label),
    );
    nodes.forEach((node) => sort(node.children));
  };
  groups.forEach((group) => sort(group.children));
  return [...result, ...groups.filter((group) => !query || group.children.length)];
}
export function visibleReferenceNodes(
  nodes: ReferenceNode[],
  collapsed: ReadonlySet<string>,
  searching: boolean,
): (ReferenceNode & { level: number })[] {
  return nodes.flatMap((node) => [
    { ...node, level: 1 },
    ...(!node.reference && (searching || !collapsed.has(node.id))
      ? visibleReferenceNodes(node.children, collapsed, searching).map((child) => ({
          ...child,
          level: child.level + 1,
        }))
      : []),
  ]);
}
