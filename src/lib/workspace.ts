import { validDatabaseConfig, type DatabaseConfig } from "./database.ts";
import { tx } from "./i18n.ts";
import { validRedisConfig, type RedisConfig } from "./redis.ts";
export interface SshOptions {
  mode?: "alias" | "direct";
  port?: number;
  username?: string;
  authentication?: "config" | "key" | "password";
  identity_file?: string;
  credential_id?: string | null;
  remember_password?: boolean;
  jump_host?: string;
}
export interface SshTarget extends SshOptions {
  connection_id: string;
  workspace_id: string;
  name: string;
  host: string;
  os: "posix" | "windows";
  root: string;
}
export interface SshConnection extends SshOptions {
  temporary?: boolean;
  forwards?: SshForward[];
  id: string;
  name: string;
  host: string;
  os: "posix" | "windows";
  root: string;
  sessions: SessionConfig[];
  splitGroups?: SplitNode[];
}
export interface SshForward {
  id: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
}
export function validSshJump(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  if (!value) return true;
  const match =
    /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[0-9a-fA-F:.]+\])(?::([0-9]{1,5}))?$/.exec(
      value,
    );
  const ipv6 = value.match(/\[([^\]]+)\]/)?.[1];
  return (
    !!match &&
    (!ipv6 || validSshIpv6(ipv6)) &&
    (!match[1] || (Number(match[1]) > 0 && Number(match[1]) <= 65535))
  );
}
export function validSshIpv6(host: string): boolean {
  try {
    return new URL(`http://[${host}]/`).hostname.includes(":");
  } catch {
    return false;
  }
}
export function validSshForward(value: unknown): value is SshForward {
  const rule = value as SshForward;
  return (
    !!rule &&
    Object.keys(rule).every((key) =>
      ["id", "local_port", "remote_host", "remote_port"].includes(key),
    ) &&
    typeof rule.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rule.id) &&
    [rule.local_port, rule.remote_port].every(
      (port) => Number.isInteger(port) && port > 0 && port <= 65535,
    ) &&
    validSshHost(rule.remote_host) &&
    (!rule.remote_host.includes(":") || validSshIpv6(rule.remote_host)) &&
    !/[@\[\]]/.test(rule.remote_host)
  );
}
const sshOptionKeys = [
  "mode",
  "port",
  "username",
  "authentication",
  "identity_file",
  "credential_id",
  "remember_password",
  "jump_host",
] as const;
export function sshOptions(value: SshOptions): SshOptions {
  return Object.fromEntries(
    sshOptionKeys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
  );
}
export function sshTargetFor(connection: SshConnection, workspaceId: string): SshTarget {
  return {
    connection_id: connection.id,
    workspace_id: workspaceId,
    name: connection.name,
    host: connection.host,
    os: connection.os,
    root: connection.root,
    ...sshOptions(connection),
  };
}
function validSshOptions(value: SshOptions & { host: string }): boolean {
  const clean = (v: unknown, limit: number) =>
    typeof v === "string" && v.length <= limit && !/[\x00-\x1f\x7f]/.test(v);
  return (
    (value.mode === undefined || ["alias", "direct"].includes(value.mode)) &&
    (value.port === undefined ||
      (Number.isInteger(value.port) && value.port > 0 && value.port <= 65535)) &&
    (value.username === undefined ||
      (clean(value.username, 512) && value.username.trim() === value.username)) &&
    (value.identity_file === undefined || clean(value.identity_file, 4096)) &&
    (value.authentication === undefined ||
      ["config", "key", "password"].includes(value.authentication)) &&
    (value.credential_id === undefined ||
      value.credential_id === null ||
      (typeof value.credential_id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value.credential_id,
        ))) &&
    (value.remember_password === undefined || typeof value.remember_password === "boolean") &&
    (value.jump_host === undefined || validSshJump(value.jump_host)) &&
    !(value.authentication === "password" && value.jump_host) &&
    (value.mode !== "direct" ||
      (typeof value.host === "string" && !value.host.includes("@") && value.port !== undefined))
  );
}
export function validSshHost(host: unknown): host is string {
  return (
    typeof host === "string" &&
    host.length <= 255 &&
    /^[a-zA-Z0-9_.@:[\]-]+$/.test(host) &&
    !host.startsWith("-")
  );
}
export function validSshTarget(value: unknown): value is SshTarget {
  const target = value as SshTarget;
  return (
    !!target &&
    Object.keys(target).every((key) =>
      ["connection_id", "workspace_id", "name", "host", "os", "root", ...sshOptionKeys].includes(
        key,
      ),
    ) &&
    validSshOptions(target) &&
    typeof target.connection_id === "string" &&
    !!target.connection_id &&
    typeof target.workspace_id === "string" &&
    !!target.workspace_id &&
    typeof target.name === "string" &&
    !!target.name.trim() &&
    validSshHost(target.host) &&
    ["posix", "windows"].includes(target.os) &&
    typeof target.root === "string" &&
    target.root.length <= 4096 &&
    !/[\0\r\n]/.test(target.root)
  );
}
export interface SessionConfig {
  ssh?: SshTarget;
  issue?: { url: string; title: string };
  id: string;
  name: string;
  shell: "default" | "cmd";
  agent?: string;
  directory?: string;
  worktreeId?: string;
  pinned?: boolean;
}
export interface Worktree {
  id: string;
  name: string;
  path: string;
  branch: string;
  pinned?: boolean;
  collapsed?: boolean;
  missing?: boolean;
}
export interface Project {
  id: string;
  name: string;
  directory: string;
  sessions: SessionConfig[];
  workspaceId?: string;
  pinned?: boolean;
  splitGroups?: SplitNode[];
  worktrees?: Worktree[];
  collapsed?: boolean;
}
export interface Workspace {
  version: 7;
  groups?: WorkspaceGroup[];
  selectedWorkspace?: string;
  selectedWorktree?: string | null;
  projects: Project[];
  selectedProject: string | null;
  selectedSession: string | null;
}
export interface WorkspaceGroup {
  redisConnections?: RedisConfig[];
  databaseConnections?: DatabaseConfig[];
  sshConnections?: SshConnection[];
  id: string;
  name: string;
  selectedProject: string | null;
  selectedSession: string | null;
  selectedWorktree?: string | null;
  terminals?: SessionConfig[];
  chats?: SessionConfig[];
  terminalSplits?: SplitNode[];
  chatSplits?: SplitNode[];
  terminalsCollapsed?: boolean;
  chatsCollapsed?: boolean;
}
export const workspaceKey = "uterm.desktop.workspace.v1";

export interface LocalHostSession {
  id: string;
  directory: string;
  shell: string;
  agent: string | null;
  ssh?: SshTarget;
}
export interface LocalSessionSnapshot {
  sessions: LocalHostSession[];
  closed: string[];
}

export function reconcileLocalSessionSnapshot(
  workspace: Workspace,
  snapshot: LocalSessionSnapshot,
): Workspace {
  const closed = new Set(snapshot.closed);
  let next = workspace;
  for (const roster of sessionRosters(workspace)) {
    for (const session of roster.sessions) {
      if (closed.has(session.id)) next = removeSession(next, session.id);
    }
  }
  return reconcileLocalSessions(
    next,
    snapshot.sessions.filter((session) => !closed.has(session.id)),
  );
}

function localPathKey(path: string): string {
  const normalized = path
    .replace(/^\\\\\?\\UNC\\/i, "//")
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export function reconcileLocalSessions(
  workspace: Workspace,
  discovered: LocalHostSession[],
): Workspace {
  const known = new Set(
    sessionRosters(workspace).flatMap((roster) => roster.sessions.map((session) => session.id)),
  );
  let result = workspace;
  for (const item of discovered) {
    if (item.ssh) continue;
    if (known.has(item.id)) continue;
    known.add(item.id);
    const path = localPathKey(item.directory);
    const project = result.projects.find(
      (project) =>
        localPathKey(project.directory) === path ||
        project.worktrees?.some((tree) => localPathKey(tree.path) === path),
    );
    const tree = project?.worktrees?.find((tree) => localPathKey(tree.path) === path);
    const session: SessionConfig = {
      id: item.id,
      pinned: false,
      name:
        item.agent ||
        item.directory
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() ||
        item.id,
      shell: item.shell === "cmd" ? "cmd" : "default",
      directory: item.directory,
      ...(item.agent ? { agent: item.agent } : {}),
      ...(tree ? { worktreeId: tree.id } : {}),
    };
    if (project) {
      result = {
        ...result,
        projects: result.projects.map((value) =>
          value.id === project.id ? { ...value, sessions: [...value.sessions, session] } : value,
        ),
      };
    } else {
      const group =
        result.groups?.find((group) => group.id === result.selectedWorkspace) ?? result.groups?.[0];
      if (!group) continue;
      const key = item.agent ? "chats" : "terminals";
      result = {
        ...result,
        groups: result.groups?.map((value) =>
          value.id === group.id ? { ...value, [key]: [...(value[key] ?? []), session] } : value,
        ),
      };
    }
  }
  return result;
}
export function reconcileSshSessions(
  workspace: Workspace,
  snapshot: LocalSessionSnapshot,
): Workspace {
  let next = workspace;
  const known = new Set(
    sessionRosters(workspace).flatMap((roster) => roster.sessions.map((session) => session.id)),
  );
  for (const id of snapshot.closed) next = removeSession(next, id);
  for (const item of snapshot.sessions) {
    const target = item.ssh;
    if (
      !target ||
      !validSshTarget(target) ||
      known.has(item.id) ||
      snapshot.closed.includes(item.id)
    )
      continue;
    const group = next.groups?.find((group) => group.id === target.workspace_id);
    if (!group) continue;
    let connection = group.sshConnections?.find(
      (connection) => connection.id === target.connection_id,
    );
    if (!connection) {
      connection = {
        id: target.connection_id,
        name: target.name,
        host: target.host,
        os: target.os,
        root: target.root,
        sessions: [],
        ...sshOptions(target),
      };
      const restored = connection;
      next = {
        ...next,
        groups: next.groups?.map((group) =>
          group.id === target.workspace_id
            ? { ...group, sshConnections: [...(group.sshConnections ?? []), restored] }
            : group,
        ),
      };
    }
    known.add(item.id);
    next = updateRoster(next, `ssh:${connection.id}`, (roster) => ({
      ...roster,
      sessions: [
        ...roster.sessions,
        {
          id: item.id,
          name: target.name,
          shell: "default",
          directory: item.directory,
          ssh: target,
        },
      ],
    }));
  }
  return next;
}
export const createWorkspaceGroup = (id: string, name: string): WorkspaceGroup => ({
  id,
  name,
  selectedProject: null,
  selectedSession: null,
  selectedWorktree: null,
  redisConnections: [],
  databaseConnections: [],
  sshConnections: [],
  terminals: [],
  chats: [],
  terminalSplits: [],
  chatSplits: [],
  terminalsCollapsed: false,
  chatsCollapsed: false,
});
export const emptyWorkspace = (): Workspace => ({
  version: 7,
  groups: [createWorkspaceGroup("local", tx("本地工作区"))],
  selectedWorkspace: "local",
  projects: [],
  selectedProject: null,
  selectedSession: null,
});

export function readWorkspace(serialized: string | null): Workspace {
  if (serialized === null) return emptyWorkspace();
  const value = JSON.parse(serialized) as Workspace;
  const ids = new Set<string>();
  const identifier = (id: unknown) =>
    typeof id === "string" && id.length > 0 && !ids.has(id) && !!ids.add(id);
  const text = (item: unknown) => typeof item === "string" && item.trim().length > 0;
  if (
    !value ||
    ![3, 4, 5, 6, 7].includes(value.version) ||
    !Array.isArray(value.projects) ||
    !value.projects.every(
      (project) =>
        project &&
        identifier(project.id) &&
        text(project.name) &&
        text(project.directory) &&
        Array.isArray(project.sessions) &&
        project.sessions.every(
          (session) =>
            session &&
            identifier(session.id) &&
            text(session.name) &&
            ["default", "cmd"].includes(session.shell),
        ),
    )
  )
    throw new Error(tx("工作区数据无效，原数据已保留。"));
  const groups = value.groups;
  if (
    !Array.isArray(groups) ||
    !groups.length ||
    !groups.every((group) => group && identifier(group.id) && text(group.name))
  )
    throw new Error(tx("工作区列表无效，原数据已保留。"));
  if (value.projects.some((project) => !groups.some((group) => group.id === project.workspaceId)))
    throw new Error(tx("项目所属工作区不存在，原数据已保留。"));
  function readSessions(sessions: SessionConfig[], validateIds: boolean): SessionConfig[] {
    if (!Array.isArray(sessions)) throw new Error(tx("会话列表无效，原数据已保留。"));
    return sessions.flatMap((session) => {
      if (
        !session ||
        Object.keys(session).some(
          (key) =>
            ![
              "id",
              "name",
              "shell",
              "agent",
              "directory",
              "worktreeId",
              "pinned",
              "issue",
              "ssh",
            ].includes(key),
        ) ||
        (validateIds && !identifier(session.id)) ||
        !text(session.name) ||
        !["default", "cmd"].includes(session.shell) ||
        (session.agent !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(session.agent)) ||
        (session.directory !== undefined && !text(session.directory)) ||
        (session.worktreeId !== undefined && !text(session.worktreeId)) ||
        (session.ssh !== undefined &&
          (!validSshTarget(session.ssh) ||
            session.agent !== undefined ||
            session.worktreeId !== undefined))
      )
        throw new Error(tx("会话配置无效，原数据已保留。"));
      if (
        session.issue &&
        (typeof session.issue.title !== "string" ||
          !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/\d+$/.test(
            session.issue.url,
          ))
      )
        throw new Error(tx("会话关联链接无效。"));
      return [
        {
          id: session.id,
          name: session.name,
          shell: session.shell,
          pinned: session.pinned === true,
          ...(session.ssh ? { ssh: session.ssh } : {}),
          ...(session.issue ? { issue: session.issue } : {}),
          ...(session.agent ? { agent: session.agent } : {}),
          ...(session.directory ? { directory: session.directory } : {}),
          ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
        },
      ];
    });
  }
  const selectedWorkspace =
    groups.find((group) => group.id === value.selectedWorkspace)?.id ?? groups[0].id;
  const projects: Project[] = value.projects.map((project) => {
    if (project.worktrees !== undefined && !Array.isArray(project.worktrees))
      throw new Error(tx("Worktree 列表无效。"));
    const worktrees = (project.worktrees ?? []).map((worktree) => {
      if (
        !worktree ||
        !identifier(worktree.id) ||
        !text(worktree.path) ||
        !text(worktree.name) ||
        typeof worktree.branch !== "string"
      )
        throw new Error(tx("Worktree 数据无效。"));
      return {
        id: worktree.id,
        name: worktree.name,
        path: worktree.path,
        branch: worktree.branch,
        pinned: worktree.pinned === true,
        collapsed: worktree.collapsed === true,
        missing: worktree.missing === true,
      };
    });
    const sessions = readSessions(project.sessions, false);
    if (sessions.some((session) => session.ssh))
      throw new Error(tx("SSH 连接数据无效，原数据已保留。"));
    if (
      sessions.some(
        (session) =>
          session.worktreeId && !worktrees.some((worktree) => worktree.id === session.worktreeId),
      )
    )
      throw new Error(tx("会话所属 Worktree 不存在。"));
    const splitGroups = readSplitGroups(project.splitGroups, sessions);
    for (const root of splitGroups) {
      if (
        new Set(
          leaves(root).map(
            (id) => sessions.find((session) => session.id === id)?.worktreeId ?? "root",
          ),
        ).size !== 1
      )
        throw new Error(tx("分组不能跨越 Worktree。"));
    }
    return {
      id: project.id,
      name: project.name,
      directory: project.directory,
      workspaceId: project.workspaceId,
      pinned: project.pinned === true,
      collapsed: project.collapsed === true,
      worktrees,
      sessions,
      splitGroups,
    };
  });
  const restoredGroups = groups.map((group) => {
    const terminals = readSessions(group.terminals ?? [], true),
      chats = readSessions(group.chats ?? [], true);
    if (
      [...terminals, ...chats].some((session) => !session.directory || session.worktreeId) ||
      chats.some((session) => !session.agent)
    )
      throw new Error(tx("独立会话的启动目录或 Agent 无效。"));
    if (
      [...terminals, ...chats].some((session) => session.ssh) ||
      (group.sshConnections !== undefined && !Array.isArray(group.sshConnections))
    )
      throw new Error(tx("SSH 连接数据无效，原数据已保留。"));
    const sshConnections = (group.sshConnections ?? []).map((connection) => {
      if (
        !connection ||
        !Object.keys(connection).every((key) =>
          [
            "id",
            "name",
            "host",
            "os",
            "root",
            "sessions",
            "splitGroups",
            "temporary",
            "forwards",
            ...sshOptionKeys,
          ].includes(key),
        ) ||
        !validSshOptions(connection) ||
        (connection.temporary !== undefined && typeof connection.temporary !== "boolean") ||
        (connection.forwards !== undefined &&
          (!Array.isArray(connection.forwards) ||
            connection.forwards.length > 16 ||
            !connection.forwards.every(validSshForward) ||
            new Set(connection.forwards.map((rule: SshForward) => rule.id)).size !==
              connection.forwards.length ||
            new Set(connection.forwards.map((rule: SshForward) => rule.local_port)).size !==
              connection.forwards.length)) ||
        !identifier(connection.id) ||
        !text(connection.name) ||
        !validSshHost(connection.host) ||
        !["posix", "windows"].includes(connection.os) ||
        typeof connection.root !== "string" ||
        connection.root.length > 4096 ||
        /[\0\r\n]/.test(connection.root)
      )
        throw new Error(tx("SSH 连接数据无效，原数据已保留。"));
      const sessions = readSessions(connection.sessions, true);
      if (
        sessions.some(
          (session) =>
            !session.directory ||
            !session.ssh ||
            session.ssh.connection_id !== connection.id ||
            session.ssh.workspace_id !== group.id,
        )
      )
        throw new Error(tx("SSH 连接数据无效，原数据已保留。"));
      return {
        id: connection.id,
        name: connection.name,
        host: connection.host,
        os: connection.os,
        root: connection.root,
        ...sshOptions(connection),
        ...(connection.temporary !== undefined ? { temporary: connection.temporary } : {}),
        ...(connection.forwards !== undefined ? { forwards: connection.forwards } : {}),
        sessions,
        splitGroups: readSplitGroups(connection.splitGroups, sessions),
      };
    });
    if (
      group.databaseConnections !== undefined &&
      (!Array.isArray(group.databaseConnections) ||
        !group.databaseConnections.every(
          (connection) => validDatabaseConfig(connection) && identifier(connection.id),
        ))
    )
      throw new Error(tx("数据库连接数据无效，原数据已保留。"));
    if (
      group.redisConnections !== undefined &&
      (!Array.isArray(group.redisConnections) ||
        !group.redisConnections.every(
          (connection) => validRedisConfig(connection) && identifier(connection.id),
        ))
    )
      throw new Error(tx("Redis 连接数据无效，原数据已保留。"));
    return {
      redisConnections: group.redisConnections ?? [],
      databaseConnections: group.databaseConnections ?? [],
      sshConnections,
      id: group.id,
      name: group.name,
      selectedProject: typeof group.selectedProject === "string" ? group.selectedProject : null,
      selectedSession: typeof group.selectedSession === "string" ? group.selectedSession : null,
      selectedWorktree: group.selectedWorktree ?? null,
      terminals,
      chats,
      terminalSplits: readSplitGroups(group.terminalSplits, terminals),
      chatSplits: readSplitGroups(group.chatSplits, chats),
      terminalsCollapsed: group.terminalsCollapsed === true,
      chatsCollapsed: group.chatsCollapsed === true,
    };
  });
  const restored: Workspace = {
    version: 7,
    groups: restoredGroups,
    selectedWorkspace,
    projects,
    selectedProject: value.selectedProject,
    selectedSession: value.selectedSession,
    selectedWorktree: value.selectedWorktree ?? null,
  };
  return normalizeSelection(restored);
}

export function selectProject(
  workspace: Workspace,
  id: string,
  worktree: string | null = null,
): Workspace {
  const project = workspace.projects.find((project) => project.id === id);
  if (!project) return workspace;
  const sessions = project.sessions.filter((session) => (session.worktreeId ?? null) === worktree);
  return {
    ...workspace,
    selectedProject: id,
    selectedWorktree: worktree,
    selectedSession: sessions.some((session) => session.id === workspace.selectedSession)
      ? workspace.selectedSession
      : (sessions[0]?.id ?? null),
  };
}

export function removeSession(workspace: Workspace, id: string): Workspace {
  const roster = sessionRosters(workspace).find((roster) =>
    roster.sessions.some((session) => session.id === id),
  );
  if (!roster) return workspace;
  const target = roster.sessions.find((session) => session.id === id);
  const peers = roster.sessions.filter((session) => session.worktreeId === target?.worktreeId);
  const index = peers.findIndex((session) => session.id === id);
  const remaining = peers.filter((session) => session.id !== id);
  const root = splitGroup(roster, id);
  const neighbor = root ? siblingPane(root, id) : null;
  const next = updateRoster(workspace, roster.id, (item) => ({
    ...item,
    sessions: item.sessions.filter((session) => session.id !== id),
    splitGroups: pruneGroups(item, id),
  }));
  return {
    ...next,
    selectedSession:
      workspace.selectedSession === id
        ? (neighbor ?? remaining[Math.min(index, remaining.length - 1)]?.id ?? null)
        : workspace.selectedSession,
  };
}

export function switchWorkspace(workspace: Workspace, id: string): Workspace {
  const target = workspace.groups?.find((group) => group.id === id);
  if (!target || workspace.selectedWorkspace === id) return workspace;
  const groups = workspace.groups?.map((group) =>
    group.id === workspace.selectedWorkspace
      ? {
          ...group,
          selectedProject: workspace.selectedProject,
          selectedSession: workspace.selectedSession,
          selectedWorktree: workspace.selectedWorktree ?? null,
        }
      : group,
  );
  return normalizeSelection({
    ...workspace,
    groups,
    selectedWorkspace: id,
    selectedProject: target.selectedProject,
    selectedSession: target.selectedSession,
    selectedWorktree: target.selectedWorktree ?? null,
  });
}

/** Cycles workspaces in stored order, restoring their selections. / 按存储顺序循环工作区并恢复各自的选择。 */
export function cycleWorkspace(workspace: Workspace, direction: 1 | -1): Workspace {
  const groups = workspace.groups ?? [];
  if (groups.length < 2) return workspace;
  const index = groups.findIndex((group) => group.id === workspace.selectedWorkspace);
  const target =
    index < 0
      ? direction === 1
        ? groups[0]
        : groups[groups.length - 1]
      : groups[(index + direction + groups.length) % groups.length];
  return switchWorkspace(workspace, target.id);
}

export function ordered<T extends { pinned?: boolean }>(items: T[]): T[] {
  return [...items.filter((item) => item.pinned), ...items.filter((item) => !item.pinned)];
}

export function canRemoveWorkspace(workspace: Workspace, id: string): boolean {
  const group = workspace.groups?.find((item) => item.id === id);
  return (
    !!group &&
    (workspace.groups?.length ?? 0) > 1 &&
    !workspace.projects.some((project) => project.workspaceId === id) &&
    !group.terminals?.length &&
    !group.chats?.length &&
    !group.sshConnections?.length &&
    !group.databaseConnections?.length &&
    !group.redisConnections?.length
  );
}

export function removeWorkspace(workspace: Workspace, id: string): Workspace {
  if (!canRemoveWorkspace(workspace, id)) return workspace;
  const remaining = (workspace.groups ?? []).filter((group) => group.id !== id);
  if (!remaining.length) return workspace;
  const next =
    workspace.selectedWorkspace === id ? switchWorkspace(workspace, remaining[0].id) : workspace;
  return { ...next, groups: next.groups?.filter((group) => group.id !== id) };
}

export function reorder<T extends { id: string; pinned?: boolean }>(
  items: T[],
  id: string,
  direction: -1 | 1,
): T[] {
  const item = items.find((item) => item.id === id);
  if (!item) return items;
  const peers = items.filter((peer) => !!peer.pinned === !!item.pinned);
  const neighbor = peers[peers.findIndex((peer) => peer.id === id) + direction];
  if (!neighbor) return items;
  return items.map((peer) => (peer.id === id ? neighbor : peer.id === neighbor.id ? item : peer));
}

export function removeProject(workspace: Workspace, id: string): Workspace {
  const project = workspace.projects.find((item) => item.id === id);
  if (!project || project.sessions.length) return workspace;
  return normalizeSelection({
    ...workspace,
    projects: workspace.projects.filter((item) => item.id !== id),
  });
}

export function reorderProject(
  workspace: Workspace,
  id: string,
  target: string,
  after: boolean,
): Workspace {
  const source = workspace.projects.find((item) => item.id === id);
  const destination = workspace.projects.find((item) => item.id === target);
  if (
    !source ||
    !destination ||
    id === target ||
    source.workspaceId !== destination.workspaceId ||
    !!source.pinned !== !!destination.pinned ||
    source.sessions.length > 0 !== destination.sessions.length > 0
  )
    return workspace;
  const projects = workspace.projects.filter((item) => item.id !== id);
  projects.splice(projects.findIndex((item) => item.id === target) + Number(after), 0, source);
  return { ...workspace, projects };
}

export function moveProject(workspace: Workspace, id: string, target: string): Workspace {
  if (!workspace.groups?.some((group) => group.id === target)) return workspace;
  return normalizeSelection({
    ...workspace,
    projects: workspace.projects.map((project) =>
      project.id === id ? { ...project, workspaceId: target } : project,
    ),
  });
}

export type SplitAxis = "horizontal" | "vertical";
export type SplitNode =
  | { kind: "leaf"; session: string }
  | {
      kind: "split";
      id: string;
      axis: SplitAxis;
      ratio: number;
      first: SplitNode;
      second: SplitNode;
    };
export type PaneDirection = "left" | "right" | "up" | "down";
export interface PaneFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Divider {
  node: Extract<SplitNode, { kind: "split" }>;
  frame: PaneFrame;
}
export const fullFrame: PaneFrame = { x: 0, y: 0, width: 1, height: 1 };
export const clampRatio = (ratio: number) =>
  Number.isFinite(ratio) ? Math.max(0.15, Math.min(0.85, ratio)) : 0.5;
export const leaves = (node: SplitNode): string[] =>
  node.kind === "leaf" ? [node.session] : [...leaves(node.first), ...leaves(node.second)];
export const splitGroup = (project: { splitGroups?: SplitNode[] }, session: string) =>
  project.splitGroups?.find((node) => leaves(node).includes(session));

function readSplitGroups(value: unknown, sessions: SessionConfig[]): SplitNode[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(tx("分组布局无效，原数据已保留。"));
  const used = new Set<string>();
  const branches = new Set<string>();
  function read(input: unknown, depth: number): SplitNode {
    if (!input || typeof input !== "object" || depth > 32)
      throw new Error(tx("分组布局无效，原数据已保留。"));
    const node = input as Record<string, unknown>;
    if (
      node.kind === "leaf" &&
      typeof node.session === "string" &&
      sessions.some((session) => session.id === node.session) &&
      !used.has(node.session)
    ) {
      used.add(node.session);
      return { kind: "leaf", session: node.session };
    }
    if (
      node.kind === "split" &&
      typeof node.id === "string" &&
      node.id &&
      !branches.has(node.id) &&
      (node.axis === "horizontal" || node.axis === "vertical") &&
      typeof node.ratio === "number" &&
      Number.isFinite(node.ratio)
    ) {
      branches.add(node.id);
      return {
        kind: "split",
        id: node.id,
        axis: node.axis,
        ratio: clampRatio(node.ratio),
        first: read(node.first, depth + 1),
        second: read(node.second, depth + 1),
      };
    }
    throw new Error(tx("分组布局包含重复或不存在的会话，原数据已保留。"));
  }
  return value.map((node) => read(node, 0)).filter((node) => node.kind === "split");
}

function siblingPane(node: SplitNode, session: string): string | null {
  if (node.kind === "leaf") return null;
  if (node.first.kind === "leaf" && node.first.session === session)
    return leaves(node.second)[0] ?? null;
  if (node.second.kind === "leaf" && node.second.session === session)
    return leaves(node.first)[0] ?? null;
  return siblingPane(node.first, session) ?? siblingPane(node.second, session);
}
export function removeLeaf(node: SplitNode, session: string): SplitNode | null {
  if (node.kind === "leaf") return node.session === session ? null : node;
  const first = removeLeaf(node.first, session),
    second = removeLeaf(node.second, session);
  return first && second ? { ...node, first, second } : (first ?? second);
}
function pruneGroups(project: { splitGroups?: SplitNode[] }, session: string): SplitNode[] {
  return (project.splitGroups ?? [])
    .map((node) => removeLeaf(node, session))
    .filter((node): node is SplitNode => node?.kind === "split");
}
export function ungroupSession(workspace: Workspace, session: string): Workspace {
  const roster = sessionRosters(workspace).find((item) =>
    item.sessions.some((entry) => entry.id === session),
  );
  if (!roster || !splitGroup(roster, session)) return workspace;
  return selectSession(
    updateRoster(workspace, roster.id, (item) => ({
      ...item,
      splitGroups: pruneGroups(item, session),
    })),
    session,
  );
}
export function groupSessions(
  workspace: Workspace,
  moved: string,
  anchor: string,
  axis?: SplitAxis,
  before = false,
): Workspace {
  const roster = sessionRosters(workspace).find((item) =>
    item.sessions.some((session) => session.id === anchor),
  );
  if (
    !roster ||
    moved === anchor ||
    !groupableSessions(workspace, moved).some((session) => session.id === anchor)
  )
    return workspace;
  function insert(node: SplitNode, parentAxis?: SplitAxis): SplitNode {
    if (node.kind === "leaf")
      return node.session !== anchor
        ? node
        : {
            kind: "split",
            id: crypto.randomUUID(),
            axis: axis ?? (parentAxis === "horizontal" ? "vertical" : "horizontal"),
            ratio: 0.5,
            first: before ? { kind: "leaf", session: moved } : node,
            second: before ? node : { kind: "leaf", session: moved },
          };
    return {
      ...node,
      first: insert(node.first, node.axis),
      second: insert(node.second, node.axis),
    };
  }
  const groups = pruneGroups(roster, moved);
  const root = groups.find((node) => leaves(node).includes(anchor));
  const next = insert(root ?? { kind: "leaf", session: anchor });
  return selectSession(
    updateRoster(workspace, roster.id, (item) => ({
      ...item,
      splitGroups: [...groups.filter((node) => node !== root), next],
    })),
    moved,
  );
}
export function resizeSplit(
  workspace: Workspace,
  roster: string,
  branch: string,
  ratio: number,
): Workspace {
  function resize(node: SplitNode): SplitNode {
    return node.kind === "leaf"
      ? node
      : {
          ...node,
          ratio: node.id === branch ? clampRatio(ratio) : node.ratio,
          first: resize(node.first),
          second: resize(node.second),
        };
  }
  return updateRoster(workspace, roster, (item) => ({
    ...item,
    splitGroups: item.splitGroups?.map(resize),
  }));
}
export function paneLayout(
  node: SplitNode,
  frame: PaneFrame = fullFrame,
): { panes: Record<string, PaneFrame>; dividers: Divider[] } {
  if (node.kind === "leaf") return { panes: { [node.session]: frame }, dividers: [] };
  const horizontal = node.axis === "horizontal",
    ratio = clampRatio(node.ratio);
  const first = paneLayout(node.first, {
    ...frame,
    width: frame.width * (horizontal ? ratio : 1),
    height: frame.height * (horizontal ? 1 : ratio),
  });
  const second = paneLayout(node.second, {
    x: frame.x + (horizontal ? frame.width * ratio : 0),
    y: frame.y + (horizontal ? 0 : frame.height * ratio),
    width: frame.width * (horizontal ? 1 - ratio : 1),
    height: frame.height * (horizontal ? 1 : 1 - ratio),
  });
  return {
    panes: { ...first.panes, ...second.panes },
    dividers: [{ node, frame }, ...first.dividers, ...second.dividers],
  };
}
export function neighborPane(
  node: SplitNode,
  session: string,
  direction: PaneDirection,
): string | null {
  const frames = paneLayout(node).panes,
    from = frames[session];
  if (!from) return null;
  const horizontal = direction === "left" || direction === "right";
  const candidates = Object.entries(frames)
    .filter(([id]) => id !== session)
    .map(([id, frame]) => {
      const gap =
        direction === "left"
          ? from.x - frame.x - frame.width
          : direction === "right"
            ? frame.x - from.x - from.width
            : direction === "up"
              ? from.y - frame.y - frame.height
              : frame.y - from.y - from.height;
      const overlap = horizontal
        ? Math.min(from.y + from.height, frame.y + frame.height) - Math.max(from.y, frame.y)
        : Math.min(from.x + from.width, frame.x + frame.width) - Math.max(from.x, frame.x);
      return {
        id,
        gap,
        overlap: overlap > 0.0001 ? 0 : 1,
        distance: Math.hypot(
          frame.x + frame.width / 2 - from.x - from.width / 2,
          frame.y + frame.height / 2 - from.y - from.height / 2,
        ),
      };
    })
    .filter((candidate) => candidate.gap >= -0.001);
  candidates.sort((a, b) => a.overlap - b.overlap || a.gap - b.gap || a.distance - b.distance);
  return candidates[0]?.id ?? null;
}

export interface SessionRoster {
  id: string;
  workspaceId: string;
  projectId: string | null;
  kind: "project" | "terminals" | "chats" | "ssh";
  connection?: SshConnection;
  sessions: SessionConfig[];
  splitGroups?: SplitNode[];
}
export function sessionRosters(workspace: Workspace): SessionRoster[] {
  return [
    ...workspace.projects.map((project) => ({
      id: project.id,
      workspaceId: project.workspaceId ?? "local",
      projectId: project.id,
      kind: "project" as const,
      sessions: project.sessions,
      splitGroups: project.splitGroups,
    })),
    ...(workspace.groups ?? []).flatMap((group) => [
      ...(group.sshConnections ?? []).map((connection) => ({
        id: `ssh:${connection.id}`,
        workspaceId: group.id,
        projectId: null,
        kind: "ssh" as const,
        sessions: connection.sessions,
        splitGroups: connection.splitGroups,
        connection,
      })),
      {
        id: `loose:${group.id}:terminals`,
        workspaceId: group.id,
        projectId: null,
        kind: "terminals" as const,
        sessions: group.terminals ?? [],
        splitGroups: group.terminalSplits,
      },
      {
        id: `loose:${group.id}:chats`,
        workspaceId: group.id,
        projectId: null,
        kind: "chats" as const,
        sessions: group.chats ?? [],
        splitGroups: group.chatSplits,
      },
    ]),
  ];
}
export function updateRoster(
  workspace: Workspace,
  id: string,
  change: (roster: SessionRoster) => SessionRoster,
): Workspace {
  const roster = sessionRosters(workspace).find((item) => item.id === id);
  if (!roster) return workspace;
  const next = change(roster);
  if (roster.projectId)
    return {
      ...workspace,
      projects: workspace.projects.map((project) =>
        project.id === roster.projectId
          ? { ...project, sessions: next.sessions, splitGroups: next.splitGroups }
          : project,
      ),
    };
  return {
    ...workspace,
    groups: workspace.groups?.map((group) =>
      group.id !== roster.workspaceId
        ? group
        : roster.kind === "ssh"
          ? {
              ...group,
              sshConnections: group.sshConnections?.map((connection) =>
                connection.id === roster.connection?.id
                  ? { ...connection, sessions: next.sessions, splitGroups: next.splitGroups }
                  : connection,
              ),
            }
          : roster.kind === "terminals"
            ? { ...group, terminals: next.sessions, terminalSplits: next.splitGroups }
            : { ...group, chats: next.sessions, chatSplits: next.splitGroups },
    ),
  };
}
export function selectedRoster(workspace: Workspace): SessionRoster | undefined {
  return sessionRosters(workspace).find(
    (roster) =>
      roster.workspaceId === workspace.selectedWorkspace &&
      (workspace.selectedSession
        ? roster.sessions.some((session) => session.id === workspace.selectedSession)
        : roster.projectId !== null && roster.projectId === workspace.selectedProject),
  );
}
export function nextSessionToClose(workspace: Workspace): string | undefined {
  const project = workspace.projects.find((item) => item.id === workspace.selectedProject);
  // Finish the selected project before traversing other projects and standalone sessions.
  // 先关闭所选项目内的会话，再遍历其他项目及独立会话。
  const preferred = project?.sessions;
  if (preferred?.length)
    return preferred.find((item) => item.id === workspace.selectedSession)?.id ?? preferred[0].id;
  if (!project && workspace.selectedSession) {
    const active = sessionRosters(workspace)
      .flatMap((item) => item.sessions)
      .find((item) => item.id === workspace.selectedSession);
    if (active) return active.id;
  }
  return (
    workspace.projects.find((item) => item.sessions.length)?.sessions[0].id ??
    sessionRosters(workspace).find((item) => item.sessions.length)?.sessions[0].id
  );
}
export function cycleSession(workspace: Workspace, direction: 1 | -1): Workspace {
  const rosters = sessionRosters(workspace);
  const sessions = (workspace.groups ?? []).flatMap((group) =>
    rosters
      .filter((roster) => roster.workspaceId === group.id)
      .flatMap((roster) =>
        roster.sessions.map((session) => ({ id: session.id, workspaceId: group.id })),
      ),
  );
  if (!sessions.length) return workspace;
  const index = sessions.findIndex((session) => session.id === workspace.selectedSession);
  const local = sessions.filter((session) => session.workspaceId === workspace.selectedWorkspace);
  const target =
    index < 0
      ? (direction === 1 ? (local[0] ?? sessions[0]) : (local.at(-1) ?? sessions.at(-1)))!
      : sessions[(index + direction + sessions.length) % sessions.length];
  // Switch the workspace first to preserve its remembered selection before selecting the session.
  // 先切换工作区以保存原工作区的选择记录，再选中目标会话。
  return selectSession(switchWorkspace(workspace, target.workspaceId), target.id);
}
export function selectSession(workspace: Workspace, id: string): Workspace {
  const roster = sessionRosters(workspace).find((item) =>
    item.sessions.some((session) => session.id === id),
  );
  if (!roster) return workspace;
  const session = roster.sessions.find((session) => session.id === id);
  return {
    ...workspace,
    selectedProject: roster.projectId,
    selectedSession: id,
    selectedWorktree: session?.worktreeId ?? null,
  };
}
export function groupableSessions(workspace: Workspace, id: string): SessionConfig[] {
  const roster = sessionRosters(workspace).find((item) =>
    item.sessions.some((session) => session.id === id),
  );
  const session = roster?.sessions.find((session) => session.id === id);
  if (!roster || !session) return [];
  const root = splitGroup(roster, id);
  return roster.sessions.filter(
    (other) =>
      other.id !== id &&
      other.worktreeId === session.worktreeId &&
      (!root || !leaves(root).includes(other.id)),
  );
}
export function sessionEntries(
  workspace: Workspace,
): { session: SessionConfig; directory: string }[] {
  return sessionRosters(workspace).flatMap((roster) =>
    roster.sessions.map((session) => {
      const project = workspace.projects.find((project) => project.id === roster.projectId);
      const directory =
        session.directory ??
        project?.worktrees?.find((worktree) => worktree.id === session.worktreeId)?.path ??
        project?.directory ??
        "";
      return { session, directory };
    }),
  );
}
function normalizeSelection(workspace: Workspace): Workspace {
  const rosters = sessionRosters(workspace).filter(
    (roster) => roster.workspaceId === (workspace.selectedWorkspace ?? "local"),
  );
  const loose = rosters.find(
    (roster) =>
      roster.projectId === null &&
      roster.sessions.some((session) => session.id === workspace.selectedSession),
  );
  if (loose) return { ...workspace, selectedProject: null, selectedWorktree: null };
  const project =
    workspace.projects.find(
      (project) =>
        project.id === workspace.selectedProject &&
        project.workspaceId === workspace.selectedWorkspace,
    ) ?? workspace.projects.find((project) => project.workspaceId === workspace.selectedWorkspace);
  if (project) {
    const worktree =
      project.worktrees?.find((item) => item.id === workspace.selectedWorktree)?.id ?? null;
    const candidates = project.sessions.filter(
      (session) => (session.worktreeId ?? null) === worktree,
    );
    const session =
      candidates.find((session) => session.id === workspace.selectedSession) ?? candidates[0];
    return {
      ...workspace,
      selectedProject: project.id,
      selectedWorktree: worktree,
      selectedSession: session?.id ?? null,
    };
  }
  const session = rosters.flatMap((roster) => roster.sessions)[0];
  return {
    ...workspace,
    selectedProject: null,
    selectedWorktree: null,
    selectedSession: session?.id ?? null,
  };
}

export function reconcileWorktrees(
  workspace: Workspace,
  projectId: string,
  discovered: { path: string; branch: string; missing: boolean }[],
): Workspace {
  const next = {
    ...workspace,
    projects: workspace.projects.map((project) => {
      if (project.id !== projectId) return project;
      const worktrees: Worktree[] = [];
      for (const previous of project.worktrees ?? []) {
        const found = discovered.find((item) => item.path === previous.path);
        if (found)
          worktrees.push({
            ...previous,
            ...found,
            name: previous.name === previous.branch ? found.branch || previous.name : previous.name,
          });
        else if (project.sessions.some((session) => session.worktreeId === previous.id))
          worktrees.push({ ...previous, missing: true });
      }
      for (const item of discovered) {
        if (!worktrees.some((previous) => previous.path === item.path))
          worktrees.push({
            ...item,
            id: crypto.randomUUID(),
            name: item.branch || item.path.split(/[\\/]/).at(-1) || "Worktree",
          });
      }
      return { ...project, worktrees };
    }),
  };
  return normalizeSelection(next);
}

export function moveSessionPane(
  workspace: Workspace,
  moved: string,
  anchor: string,
  edge: "left" | "right" | "top" | "bottom",
): Workspace {
  const roster = sessionRosters(workspace).find((item) =>
    item.sessions.some((session) => session.id === moved),
  );
  const source = roster?.sessions.find((session) => session.id === moved),
    target = roster?.sessions.find((session) => session.id === anchor);
  if (!source || !target || moved === anchor || source.worktreeId !== target.worktreeId)
    return workspace;
  return groupSessions(
    ungroupSession(workspace, moved),
    moved,
    anchor,
    edge === "left" || edge === "right" ? "horizontal" : "vertical",
    edge === "left" || edge === "top",
  );
}
