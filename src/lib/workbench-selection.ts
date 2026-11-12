export interface WorkbenchSelection {
  request: string;
  group: string;
  id: string;
}

export function workbenchSelection<T extends { id: string }>(
  selection: WorkbenchSelection | null | undefined,
  consumed: string | undefined,
  workspace: string,
  groups: { id: string; profiles: T[] }[],
): { request: string; group: string; profile: T } | null {
  if (
    !selection ||
    typeof selection.request !== "string" ||
    !selection.request ||
    selection.request === consumed ||
    selection.group !== workspace
  )
    return null;
  const profile = groups
    .find((group) => group.id === selection.group)
    ?.profiles.find((profile) => profile.id === selection.id);
  return profile ? { request: selection.request, group: selection.group, profile } : null;
}
