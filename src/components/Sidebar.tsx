import type { DatabaseConfig, DatabaseStatus } from "../lib/database";
import type { RedisConfig, RedisStatus } from "../lib/redis";
import { availableAgents } from "../lib/settings";
import { localizeMessage } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { tx } from "../lib/i18n";
import { matchesSsh } from "../lib/ssh";
import { useSettings } from "../lib/SettingsContext";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ordered,
  reorderProject,
  selectProject,
  selectSession,
  sessionRosters,
  splitGroup,
  switchWorkspace,
} from "../lib/workspace";
import type {
  Project,
  SessionConfig,
  SessionRoster,
  Workspace,
  Worktree,
  SshConnection,
} from "../lib/workspace";
import type { RuntimeInfo } from "../lib/desktop";
import {
  AgentStatusIndicator,
  agentNames,
  SessionIcon,
  SidebarIcon,
  ToolbarIcon,
} from "./SidebarIcon";

export interface SidebarMenu {
  kind: "project" | "worktree" | "session";
  id: string;
  project: string;
  x: number;
  y: number;
}
type ConnectionRemoval = { workspaceId: string } & (
  | { kind: "ssh"; connection: SshConnection }
  | { kind: "redis"; connection: RedisConfig }
  | { kind: "database"; connection: DatabaseConfig }
);
type SidebarView = "all" | "projects" | "ssh" | "redis" | "database";
export function Sidebar({
  resizeHandle,
  visible,
  toggleVisibility,
  closeSession,
  workspace,
  runtime,
  update,
  focus,
  menu,
  addProject,
  newWorkspace,
  renameWorkspace,
  addLoose,
  addSession,
  agentStates,
  detectedAgents,
  unreadCompletedSessions,
  onSessionViewed,
  onActivitySession,
  activityDisabled = false,
  footerActions,
  addSsh,
  quickSsh,
  editSsh,
  selectSsh,
  newSshTerminal,
  removeSsh,
  canRemoveSsh,
  canEditSsh,
  addRedis,
  editRedis,
  selectRedis,
  removeRedis,
  redisStatuses = {},
  selectedRedisId,
  addDatabase,
  editDatabase,
  selectDatabase,
  removeDatabase,
  manageDatabase,
  databaseStatuses = {},
  selectedDatabaseId,
}: {
  addDatabase?: () => void;
  editDatabase?: (connection: DatabaseConfig) => void;
  selectDatabase?: (connection: DatabaseConfig) => void;
  removeDatabase?: (connection: DatabaseConfig) => void;
  manageDatabase?: () => void;
  databaseStatuses?: Record<string, DatabaseStatus>;
  selectedDatabaseId?: string | null;
  addRedis?: () => void;
  editRedis?: (connection: RedisConfig) => void;
  selectRedis?: (connection: RedisConfig) => void;
  removeRedis?: (connection: RedisConfig) => void;
  redisStatuses?: Record<string, RedisStatus>;
  selectedRedisId?: string | null;
  addSsh?: () => void;
  quickSsh?: () => void;
  editSsh?: (connection: SshConnection) => void;
  selectSsh?: (connection: SshConnection) => void;
  newSshTerminal?: (connection: SshConnection) => void;
  removeSsh?: (connection: SshConnection) => void;
  canRemoveSsh?: (connection: SshConnection) => boolean;
  canEditSsh?: (connection: SshConnection) => boolean;
  resizeHandle?: ReactNode;
  closeSession: (id: string) => void;
  visible: boolean;
  toggleVisibility: () => void;
  footerActions: ReactNode;
  agentStates: Record<string, string>;
  detectedAgents: Record<string, string>;
  unreadCompletedSessions: ReadonlySet<string>;
  onSessionViewed: (id: string) => void;
  onActivitySession: (id: string) => void;
  activityDisabled?: boolean;
  workspace: Workspace | null;
  runtime: RuntimeInfo | null;
  update: (change: (state: Workspace) => Workspace) => void;
  focus: () => void;
  menu: (menu: SidebarMenu) => void;
  addProject: () => void;
  newWorkspace: () => void;
  renameWorkspace: () => void;
  addLoose: (kind: "terminals" | "chats", agent?: SessionConfig["agent"]) => void;
  addSession: (project: string, worktree?: string, agent?: SessionConfig["agent"]) => void;
}) {
  const [sshQuery, setSshQuery] = useState("");
  useUiLanguage();

  const { settings, save } = useSettings();
  const [sidebarView, setSidebarView] = useState<SidebarView>("all");
  const navigationRef = useRef<HTMLElement>(null);
  const floatingActions = useRef<HTMLDivElement | null>(null);
  const navigation = settings.sidebarStyle === "navigation";
  const showSsh = navigation || settings.showSshConnections;
  const showRedis = navigation || settings.showRedisConnections;
  const showDatabase = navigation || settings.showDatabaseConnections;
  const viewAvailable = {
    all: true,
    projects: true,
    ssh: !!addSsh && showSsh,
    redis: !!addRedis && showRedis,
    database: !!addDatabase && showDatabase,
  };
  const shownView = viewAvailable[sidebarView] ? sidebarView : "all";
  useEffect(() => {
    setSidebarView(shownView);
  }, [shownView]);
  const showing = (view: SidebarView) => !navigation || shownView === "all" || shownView === view;
  const draggedProject = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const suppressProjectClick = useRef(false);
  const [projectDrop, setProjectDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [dragError, setDragError] = useState("");
  const [visibilityError, setVisibilityError] = useState("");
  const [popover, setPopover] = useState<"workspace" | "add" | null>(null);
  const [connectionMenu, setConnectionMenu] = useState<{
    kind: "ssh" | "redis" | "database" | "project" | "worktree";
    id: string;
    workspaceId: string;
    trigger: HTMLButtonElement;
    x: number;
    y: number;
  } | null>(null);
  const connectionMenuRef = useRef<HTMLDivElement>(null);
  const [activeFolded, setActiveFolded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [removal, setRemoval] = useState<ConnectionRemoval | null>(null);
  const removalDialog = useRef<HTMLDialogElement>(null);
  const cancelRemoval = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  function hideQuickActions(restoreFocus = true) {
    const actions = floatingActions.current;
    if (!actions) return;
    if (restoreFocus && actions.contains(document.activeElement))
      actions.parentElement?.querySelector<HTMLButtonElement>(".row-label")?.focus();
    floatingActions.current = null;
    if (actions.matches(":popover-open")) actions.hidePopover();
    actions.removeAttribute("popover");
    actions.style.removeProperty("left");
    actions.style.removeProperty("top");
  }
  function showQuickActions(row: HTMLDivElement) {
    const actions = row.querySelector<HTMLDivElement>(".row-actions");
    if (!actions?.showPopover || actions === floatingActions.current) return;
    hideQuickActions();
    floatingActions.current = actions;
    actions.setAttribute("popover", "manual");
    actions.showPopover();
    const bounds = actions.getBoundingClientRect();
    const anchor = row.getBoundingClientRect();
    if (anchor.width >= bounds.width + 96) {
      hideQuickActions(false);
      return;
    }
    // The top layer keeps quick actions clear of narrow labels and the scrolling list's clip.
    // 顶层显示让快捷操作避开窄行标签，同时不受滚动列表裁剪。
    actions.style.left = `${Math.max(8, Math.min(anchor.right - 4, window.innerWidth - bounds.width - 8))}px`;
    actions.style.top = `${Math.max(8, Math.min(anchor.top + (anchor.height - bounds.height) / 2, window.innerHeight - bounds.height - 8))}px`;
  }
  useEffect(() => {
    hideQuickActions();
    const dismiss = (event: Event) => {
      const actions = floatingActions.current;
      if (!actions) return;
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      if (event.type === "pointerdown" && actions.parentElement?.contains(event.target as Node))
        return;
      if (event.type === "scroll" && actions.contains(event.target as Node)) return;
      hideQuickActions();
    };
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      hideQuickActions();
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", dismiss, true);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [visible, workspace?.selectedWorkspace, settings.sidebarStyle]);
  useEffect(() => {
    if (!visible && (!navigation || popover === "workspace")) setPopover(null);
  }, [visible, navigation, popover]);
  function toggleConnections(
    key: "showSshConnections" | "showRedisConnections" | "showDatabaseConnections",
  ) {
    try {
      save({ ...settings, [key]: !settings[key] }, runtime?.platform === "macos");
      setVisibilityError("");
    } catch (reason) {
      setVisibilityError(String(reason));
    }
  }
  useLayoutEffect(() => {
    if (!popover || !popoverRef.current || !triggerRef.current) return;
    const popup = popoverRef.current;
    const bounds = popup.getBoundingClientRect();
    const anchor = triggerRef.current.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
    const top = popover === "workspace" ? anchor.bottom + 4 : anchor.top - bounds.height - 4;
    popup.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8))}px`;
  });
  useEffect(() => {
    if (!popover) return;
    popoverRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        !popoverRef.current?.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      )
        setPopover(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPopover(null);
        triggerRef.current?.focus();
      }
    };
    const moved = (event: Event) => {
      if (event.type !== "scroll" || !popoverRef.current?.contains(event.target as Node))
        setPopover(null);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    document.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [popover]);
  const activeKey = (project: Project, worktree?: Worktree) =>
    JSON.stringify([project.id, worktree?.id ?? null]);
  useEffect(() => {
    const keys = new Set(
      (workspace?.projects ?? [])
        .filter((project) => project.sessions.length > 0)
        .flatMap((project) => [
          activeKey(project),
          ...(project.worktrees ?? []).map((worktree) => activeKey(project, worktree)),
        ]),
    );
    setActiveFolded((previous) => {
      const entries = Object.entries(previous).filter(([key]) => keys.has(key));
      return entries.length === Object.keys(previous).length
        ? previous
        : Object.fromEntries(entries);
    });
  }, [workspace?.projects]);
  function folderCollapsed(project: Project, worktree?: Worktree) {
    if (!project.sessions.length) return !!(worktree ?? project).collapsed;
    return (
      activeFolded[activeKey(project, worktree)] ??
      (worktree && !project.sessions.some((session) => session.worktreeId === worktree.id)
        ? !!worktree.collapsed
        : false)
    );
  }
  const group = workspace?.groups?.find((group) => group.id === workspace.selectedWorkspace);
  const menuSsh =
    connectionMenu?.kind === "ssh"
      ? group?.sshConnections?.find((connection) => connection.id === connectionMenu.id)
      : undefined;
  const menuRedis =
    connectionMenu?.kind === "redis"
      ? group?.redisConnections?.find((connection) => connection.id === connectionMenu.id)
      : undefined;
  const menuDatabase =
    connectionMenu?.kind === "database"
      ? group?.databaseConnections?.find((connection) => connection.id === connectionMenu.id)
      : undefined;
  const quickProject =
    connectionMenu?.kind === "project" || connectionMenu?.kind === "worktree"
      ? workspace?.projects.find(
          (project) =>
            project.workspaceId === group?.id &&
            (connectionMenu.kind === "project"
              ? project.id === connectionMenu.id
              : project.worktrees?.some((worktree) => worktree.id === connectionMenu.id)),
        )
      : undefined;
  const quickWorktree =
    connectionMenu?.kind === "worktree"
      ? quickProject?.worktrees?.find((worktree) => worktree.id === connectionMenu.id)
      : undefined;
  const connectionMenuVisible = !!(
    visible &&
    group?.id === connectionMenu?.workspaceId &&
    ((menuSsh && showSsh && !collapsed.ssh) ||
      (menuRedis && showRedis && !collapsed.redis) ||
      (menuDatabase && showDatabase && !collapsed.database) ||
      quickProject)
  );
  const redisRetained = menuRedis && redisStatuses[menuRedis.id];
  const databaseRetained = menuDatabase && databaseStatuses[menuDatabase.id];
  const connectionActions = menuSsh
    ? [
        {
          label: tx("新建 SSH 终端"),
          disabled: activityDisabled || !newSshTerminal,
          run: () => newSshTerminal?.(menuSsh),
        },
        {
          label: tx("编辑 SSH 连接"),
          disabled: canEditSsh?.(menuSsh) === false || !editSsh,
          run: () => editSsh?.(menuSsh),
        },
      ]
    : menuRedis
      ? [
          {
            label: tx("编辑 Redis 连接"),
            disabled:
              !!(redisRetained?.connected || redisRetained?.dirty || redisRetained?.opening) ||
              !editRedis,
            run: () => editRedis?.(menuRedis),
          },
        ]
      : menuDatabase
        ? [
            {
              label: tx("编辑数据库连接"),
              disabled:
                !!(
                  databaseRetained?.connected ||
                  databaseRetained?.busy ||
                  databaseRetained?.dirty
                ) || !editDatabase,
              run: () => editDatabase?.(menuDatabase),
            },
          ]
        : quickProject
          ? [
              {
                label: tx("新建终端"),
                disabled: !!quickWorktree?.missing,
                run: () => addSession(quickProject.id, quickWorktree?.id),
              },
              ...availableAgents(settings, runtime?.agents ?? []).map((agent) => ({
                label: tx("新建 {p0} 会话", {
                  p0:
                    runtime?.agent_definitions.find((item) => item.id === agent)?.name ??
                    agentNames[agent] ??
                    agent,
                }),
                disabled: !!quickWorktree?.missing,
                run: () => addSession(quickProject.id, quickWorktree?.id, agent),
              })),
            ]
          : [];
  useLayoutEffect(() => {
    if (!connectionMenuVisible || !connectionMenu || !connectionMenuRef.current) return;
    const popup = connectionMenuRef.current;
    const bounds = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(connectionMenu.x, window.innerWidth - bounds.width - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(connectionMenu.y, window.innerHeight - bounds.height - 8))}px`;
  });
  useEffect(() => {
    if (!connectionMenu) return;
    if (!connectionMenuVisible) {
      setConnectionMenu(null);
      return;
    }
    const popup = connectionMenuRef.current;
    (popup?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? popup)?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!connectionMenuRef.current?.contains(event.target as Node)) setConnectionMenu(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setConnectionMenu(null);
      connectionMenu.trigger.focus();
    };
    const moved = (event: Event) => {
      if (event.type !== "scroll" || !connectionMenuRef.current?.contains(event.target as Node))
        setConnectionMenu(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape, true);
    document.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    window.addEventListener("blur", moved);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
      window.removeEventListener("blur", moved);
    };
  }, [connectionMenu, connectionMenuVisible]);
  function openConnectionMenu(
    event: MouseEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>,
    kind: "ssh" | "redis" | "database",
    id: string,
  ) {
    if ("key" in event && event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
      return;
    const trigger = event.currentTarget.querySelector<HTMLButtonElement>(".row-label");
    if (!group || !trigger) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = trigger.getBoundingClientRect();
    setPopover(null);
    setConnectionMenu({
      kind,
      id,
      workspaceId: group.id,
      trigger,
      x: "key" in event ? bounds.left : event.clientX,
      y: "key" in event ? bounds.bottom : event.clientY,
    });
  }
  const removalAllowed =
    !!removal &&
    visible &&
    removal.workspaceId === group?.id &&
    (removal.kind === "ssh"
      ? showSsh &&
        group.sshConnections?.includes(removal.connection) &&
        !!removeSsh &&
        !!canRemoveSsh?.(removal.connection)
      : removal.kind === "redis"
        ? showRedis &&
          group.redisConnections?.includes(removal.connection) &&
          !!removeRedis &&
          !redisStatuses[removal.connection.id]?.connected &&
          !redisStatuses[removal.connection.id]?.opening &&
          !redisStatuses[removal.connection.id]?.dirty
        : showDatabase &&
          group.databaseConnections?.includes(removal.connection) &&
          !!removeDatabase &&
          !databaseStatuses[removal.connection.id]?.connected &&
          !databaseStatuses[removal.connection.id]?.busy &&
          !databaseStatuses[removal.connection.id]?.dirty);
  useEffect(() => {
    if (!removal) return;
    if (!removalAllowed) {
      setRemoval(null);
      return;
    }
    const dialog = removalDialog.current;
    const origin = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    cancelRemoval.current?.focus();
    return () => {
      dialog?.close();
      origin?.focus();
    };
  }, [removal, removalAllowed]);
  function confirmRemoval() {
    if (!removal || !removalAllowed) return;
    setRemoval(null);
    if (removal.kind === "ssh") removeSsh?.(removal.connection);
    else if (removal.kind === "redis") removeRedis?.(removal.connection);
    else removeDatabase?.(removal.connection);
  }
  const projects = useMemo(() => {
    const projects = ordered(
      workspace?.projects.filter(
        (project) => project.workspaceId === workspace.selectedWorkspace,
      ) ?? [],
    );
    if (settings.projectOrder === "name")
      projects.sort(
        (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.name.localeCompare(b.name),
      );
    return projects;
  }, [workspace?.projects, workspace?.selectedWorkspace, settings.projectOrder]);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const rosters = workspace
    ? sessionRosters(workspace).filter(
        (roster) => roster.workspaceId === workspace.selectedWorkspace,
      )
    : [];
  const rosterById = new Map<string, SessionRoster>();
  // Project IDs may share names with generated rosters; retain the original first-match precedence.
  // 项目标识可能与自动生成的会话分组重名，保留原来首项优先的查找顺序。
  for (const roster of rosters) {
    if (!rosterById.has(roster.id)) rosterById.set(roster.id, roster);
  }
  const openMenu = (event: MouseEvent, kind: SidebarMenu["kind"], id: string, project: string) => {
    event.preventDefault();
    setPopover(null);
    setConnectionMenu(null);
    menu({ kind, id, project, x: event.clientX, y: event.clientY });
  };
  function quickActions(project: Project, worktree?: Worktree) {
    return (
      <>
        <div className="row-actions">
          <button
            className="icon-button"
            disabled={worktree?.missing}
            aria-label={tx("在{p0}中新建终端", { p0: worktree?.name ?? project.name })}
            title={tx("新建终端")}
            onClick={() => addSession(project.id, worktree?.id)}
          >
            <SessionIcon />
          </button>
          {availableAgents(settings, runtime?.agents ?? []).map((agent) => (
            <button
              key={agent}
              className="icon-button"
              disabled={worktree?.missing}
              aria-label={tx("在{p0}中新建 {p1} 会话", {
                p0: worktree?.name ?? project.name,
                p1:
                  runtime?.agent_definitions.find((item) => item.id === agent)?.name ??
                  agentNames[agent] ??
                  agent,
              })}
              title={tx("新建 {p0} 会话", {
                p0:
                  runtime?.agent_definitions.find((item) => item.id === agent)?.name ??
                  agentNames[agent] ??
                  agent,
              })}
              onClick={() => addSession(project.id, worktree?.id, agent)}
            >
              <SessionIcon agent={agent} />
            </button>
          ))}
        </div>
        <button
          className="icon-button row-more"
          aria-label={tx("更多操作：{p0}", { p0: worktree?.name ?? project.name })}
          title={tx("更多操作：{p0}", { p0: worktree?.name ?? project.name })}
          aria-haspopup="menu"
          aria-expanded={
            connectionMenu?.kind === (worktree ? "worktree" : "project") &&
            connectionMenu.id === (worktree?.id ?? project.id)
          }
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            setPopover(null);
            setConnectionMenu({
              kind: worktree ? "worktree" : "project",
              id: worktree?.id ?? project.id,
              workspaceId: project.workspaceId!,
              trigger: event.currentTarget,
              x: bounds.right,
              y: bounds.top,
            });
          }}
        >
          <SidebarIcon name="more" />
        </button>
      </>
    );
  }
  function sessionRow(
    session: SessionConfig,
    roster: SessionRoster,
    depth = 0,
    breadcrumb?: string,
    active = false,
  ) {
    const completedUnread = unreadCompletedSessions.has(session.id);
    return (
      <div
        key={session.id}
        className={`sidebar-row session-row${session.id === workspace?.selectedSession ? " selected" : ""}${completedUnread ? " completion-unread" : ""}`}
        style={{ "--depth": depth } as React.CSSProperties}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          event.stopPropagation();
          closeSession(session.id);
        }}
        onContextMenu={(event) => openMenu(event, "session", session.id, roster.id)}
      >
        <button
          className="row-label"
          disabled={active && activityDisabled}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData("application/x-uterm-session", session.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          title={breadcrumb ? `${breadcrumb} / ${session.name}` : session.name}
          aria-current={session.id === workspace?.selectedSession ? "true" : undefined}
          onClick={() => {
            if (active) {
              onActivitySession(session.id);
              return;
            }
            update((previous) => selectSession(previous, session.id));
            onSessionViewed(session.id);
            focus();
          }}
        >
          <span className="session-icon-frame">
            <SessionIcon agent={session.agent ?? detectedAgents[session.id]} />
          </span>
          <span className="sidebar-row-name">{session.name}</span>
          {(session.agent || agentStates[session.id]) && (
            <AgentStatusIndicator state={agentStates[session.id]} />
          )}
          {splitGroup(roster, session.id) && (
            <span className="group-mark" title={tx("已分组")}>
              Ⅱ
            </span>
          )}
        </button>
        <button
          className="icon-button session-close row-close"
          aria-label={tx("关闭会话：{p0}", { p0: session.name })}
          title={tx("关闭会话")}
          onClick={() => closeSession(session.id)}
        >
          <ToolbarIcon name="close" />
        </button>
      </div>
    );
  }
  function projectChange(project: Project, change: (value: Project) => Project) {
    update((previous) => ({
      ...previous,
      projects: previous.projects.map((item) => (item.id === project.id ? change(item) : item)),
    }));
  }
  function projectTarget(sourceId: string, x: number, y: number) {
    const source = projectById.get(sourceId);
    if (!source) return null;
    for (const row of document.querySelectorAll<HTMLElement>(".folder-row[data-project-id]")) {
      const target = projectById.get(row.dataset.projectId ?? "");
      const box = row.getBoundingClientRect();
      if (
        target &&
        target.id !== sourceId &&
        !!target.pinned === !!source.pinned &&
        target.sessions.length > 0 === source.sessions.length > 0 &&
        x >= box.left &&
        x <= box.right &&
        y >= box.top &&
        y <= box.bottom
      )
        return { id: target.id, after: y > box.top + box.height / 2 };
    }
    return null;
  }
  function folderRow(project: Project, depth: number, worktree?: Worktree) {
    const item = worktree ?? project;
    const active = project.sessions.length > 0;
    const hasOpenSessions = worktree
      ? project.sessions.some((session) => session.worktreeId === worktree.id)
      : active;
    const folded = folderCollapsed(project, worktree);
    const selected =
      workspace?.selectedProject === project.id &&
      (workspace.selectedWorktree ?? undefined) === worktree?.id &&
      !workspace.selectedSession;
    return (
      <div
        className={`sidebar-row folder-row${selected ? " selected" : ""}${!worktree && projectDrop?.id === project.id ? (projectDrop.after ? " project-drop-after" : " project-drop-before") : ""}`}
        data-project-id={worktree ? undefined : project.id}
        style={{ "--depth": depth } as React.CSSProperties}
        onPointerEnter={(event) => showQuickActions(event.currentTarget)}
        onPointerLeave={(event) => {
          if (!event.currentTarget.contains(document.activeElement)) hideQuickActions();
        }}
        onFocusCapture={(event) => {
          if (!(event.target as HTMLElement).closest(".row-more"))
            showQuickActions(event.currentTarget);
        }}
        onBlurCapture={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null) &&
            !event.currentTarget.matches(":hover")
          )
            hideQuickActions();
        }}
        onContextMenu={(event) =>
          openMenu(event, worktree ? "worktree" : "project", item.id, project.id)
        }
      >
        <button
          className="row-label"
          disabled={active && activityDisabled}
          aria-expanded={!folded}
          aria-description={hasOpenSessions ? tx("有未关闭的会话") : undefined}
          onPointerDown={
            worktree
              ? undefined
              : (event) => {
                  if (event.button !== 0) return;
                  suppressProjectClick.current = false;
                  draggedProject.current = {
                    id: project.id,
                    x: event.clientX,
                    y: event.clientY,
                    moved: false,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }
          }
          onPointerMove={
            worktree
              ? undefined
              : (event) => {
                  const drag = draggedProject.current;
                  if (!drag) return;
                  if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5 && !drag.moved)
                    return;
                  drag.moved = true;
                  suppressProjectClick.current = true;
                  setProjectDrop(projectTarget(drag.id, event.clientX, event.clientY));
                }
          }
          onPointerUp={
            worktree
              ? undefined
              : (event) => {
                  const drag = draggedProject.current;
                  const target = drag?.moved
                    ? projectTarget(drag.id, event.clientX, event.clientY)
                    : null;
                  draggedProject.current = null;
                  setProjectDrop(null);
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  if (!drag || !target) return;
                  try {
                    // Preserve the visible order when switching from alphabetical to manual sorting.
                    if (settings.projectOrder !== "manual")
                      save({ ...settings, projectOrder: "manual" }, runtime?.platform === "macos");
                    update((previous) => {
                      const visibleIds = projects.map((item) => item.id);
                      const current = new Map(previous.projects.map((item) => [item.id, item]));
                      const visible = visibleIds.flatMap((id) =>
                        current.has(id) ? [current.get(id)!] : [],
                      );
                      let index = 0;
                      const baseline = {
                        ...previous,
                        projects: previous.projects.map((item) =>
                          visibleIds.includes(item.id) ? visible[index++] : item,
                        ),
                      };
                      return reorderProject(baseline, drag.id, target.id, target.after);
                    });
                    setDragError("");
                  } catch (reason) {
                    setDragError(String(reason));
                  }
                }
          }
          onLostPointerCapture={() => {
            draggedProject.current = null;
            setProjectDrop(null);
          }}
          onPointerCancel={() => {
            draggedProject.current = null;
            setProjectDrop(null);
          }}
          title={
            worktree
              ? `${worktree.name} — ${worktree.path}${worktree.missing ? tx(" — 目录不可用") : ""}`
              : `${project.name} — ${project.directory}`
          }
          onClick={() => {
            if (!worktree && suppressProjectClick.current) {
              suppressProjectClick.current = false;
              return;
            }
            if (active) {
              setActiveFolded((previous) => ({
                ...previous,
                [activeKey(project, worktree)]: !folded,
              }));
            } else {
              projectChange(project, (value) =>
                worktree
                  ? {
                      ...value,
                      worktrees: value.worktrees?.map((entry) =>
                        entry.id === worktree.id ? { ...entry, collapsed: !folded } : entry,
                      ),
                    }
                  : { ...value, collapsed: !folded },
              );
            }
            if (active) {
              const sessions = worktree
                ? project.sessions.filter((session) => session.worktreeId === worktree.id)
                : project.sessions;
              const session =
                sessions.find((item) => item.id === workspace?.selectedSession) ?? sessions[0];
              if (session) {
                onActivitySession(session.id);
                return;
              }
            }
            update((previous) => selectProject(previous, project.id, worktree?.id));
            focus();
          }}
        >
          <span
            className="sidebar-resource-icon"
            data-resource-active={hasOpenSessions || undefined}
            aria-hidden="true"
          >
            <SidebarIcon name={folded ? "folderClosed" : "folder"} />
          </span>
          <span className="sidebar-row-name">{item.name}</span>
          {worktree && (
            <span className="worktree-mark">
              <SidebarIcon name="branch" />
            </span>
          )}
          {worktree?.missing && (
            <span className="missing-mark" title={tx("目录不可用")}>
              !
            </span>
          )}
        </button>
        {quickActions(project, worktree)}
      </div>
    );
  }
  function worktreeBlock(project: Project, worktree: Worktree, pinnedParent = false, depth = 0) {
    const roster = rosterById.get(project.id);
    if (!roster) return null;
    return (
      <div key={worktree.id}>
        {folderRow(project, depth, worktree)}
        {!folderCollapsed(project, worktree) &&
          ordered(
            project.sessions.filter(
              (session) =>
                session.worktreeId === worktree.id &&
                (project.sessions.length > 0 || pinnedParent || worktree.pinned || !session.pinned),
            ),
          ).map((session) =>
            sessionRow(
              session,
              roster,
              depth + 1,
              `${project.name}/${worktree.name}`,
              project.sessions.length > 0,
            ),
          )}
      </div>
    );
  }
  function projectBlock(project: Project) {
    const roster = rosterById.get(project.id);
    if (!roster) return null;
    return (
      <div key={project.id}>
        {folderRow(project, 0)}
        {!folderCollapsed(project) && (
          <>
            {ordered(project.sessions.filter((session) => !session.worktreeId)).map((session) =>
              sessionRow(session, roster, 1, project.name, project.sessions.length > 0),
            )}
            {ordered(
              (project.worktrees ?? []).filter(
                (worktree) => project.sessions.length > 0 || project.pinned || !worktree.pinned,
              ),
            ).map((worktree) => worktreeBlock(project, worktree, project.pinned, 1))}
          </>
        )}
      </div>
    );
  }
  const inactiveProjects = projects.filter((project) => !project.sessions.length);
  const activeProjects = projects.filter((project) => project.sessions.length > 0);
  const pinned: ReactNode[] = inactiveProjects
    .filter((project) => project.pinned)
    .map(projectBlock);
  for (const project of inactiveProjects.filter((project) => !project.pinned)) {
    pinned.push(
      ...ordered(project.worktrees ?? [])
        .filter((worktree) => worktree.pinned)
        .map((worktree) => worktreeBlock(project, worktree)),
    );
  }
  for (const roster of rosters) {
    const project = roster.projectId === null ? undefined : projectById.get(roster.projectId);
    if (roster.kind === "ssh" || project?.pinned || project?.sessions.length) continue;
    for (const session of roster.sessions.filter(
      (session) =>
        session.pinned &&
        !project?.worktrees?.find((worktree) => worktree.id === session.worktreeId)?.pinned,
    )) {
      pinned.push(
        sessionRow(
          session,
          roster,
          0,
          project?.name ?? (roster.kind === "chats" ? tx("聊天") : tx("终端")),
        ),
      );
    }
  }
  function setSectionCollapsed(section: "active" | "pinned" | "projects", folded: boolean) {
    if (section === "active") {
      setActiveFolded((previous) => ({
        ...previous,
        ...Object.fromEntries(
          activeProjects.flatMap((project) => [
            [activeKey(project), folded],
            ...(project.worktrees ?? []).map((worktree) => [activeKey(project, worktree), folded]),
          ]),
        ),
      }));
      return;
    }
    update((previous) => ({
      ...previous,
      projects: previous.projects.map((project) => {
        if (project.workspaceId !== previous.selectedWorkspace || project.sessions.length)
          return project;
        const inSection = !!project.pinned === (section === "pinned");
        return {
          ...project,
          collapsed: inSection ? folded : project.collapsed,
          // Pinned worktrees of unpinned projects belong to the pinned section.
          // 未置顶项目中的置顶 Worktree 属于已固定区域。
          worktrees: project.worktrees?.map((worktree) =>
            (project.pinned || worktree.pinned ? "pinned" : "projects") === section
              ? { ...worktree, collapsed: folded }
              : worktree,
          ),
        };
      }),
    }));
  }
  function sectionFolders(section: "active" | "pinned" | "projects") {
    if (section === "active")
      return activeProjects.flatMap((project) => [
        { collapsed: folderCollapsed(project) },
        ...(project.worktrees ?? []).map((worktree) => ({
          collapsed: folderCollapsed(project, worktree),
        })),
      ]);
    const roots = inactiveProjects.filter((project) => !!project.pinned === (section === "pinned"));
    const pinnedWorktrees =
      section === "pinned"
        ? inactiveProjects
            .filter((project) => !project.pinned)
            .flatMap((project) => (project.worktrees ?? []).filter((worktree) => worktree.pinned))
        : [];
    return [...roots, ...pinnedWorktrees];
  }
  function sectionHeader(
    name: string,
    isCollapsed: boolean,
    toggle: () => void,
    section?: "active" | "pinned" | "projects",
    actions?: ReactNode,
  ) {
    const folders = section ? sectionFolders(section) : [];
    const allFoldersCollapsed = folders.length > 0 && folders.every((folder) => folder.collapsed);
    return (
      <div className="section-header">
        <button
          className="section-toggle"
          title={name}
          aria-expanded={!isCollapsed}
          onClick={toggle}
        >
          <span className="section-name">{name}</span>
          <span className={isCollapsed ? "" : "expanded"}>
            <SidebarIcon name="chevron" />
          </span>
        </button>
        {section && folders.length > 0 && (
          <button
            className="icon-button section-action"
            aria-label={tx("{p0}：{p1}项目会话", {
              p0: name,
              p1: allFoldersCollapsed ? tx("全部展开") : tx("全部折叠"),
            })}
            title={allFoldersCollapsed ? tx("全部展开项目会话") : tx("全部折叠项目会话")}
            aria-expanded={!allFoldersCollapsed}
            onClick={() => setSectionCollapsed(section, !allFoldersCollapsed)}
          >
            <ToolbarIcon name={allFoldersCollapsed ? "expandAll" : "collapseAll"} />
          </button>
        )}
        {actions && <div className="section-header-actions">{actions}</div>}
      </div>
    );
  }
  function looseSection(kind: "terminals" | "chats") {
    const roster = rosters.find((roster) => roster.kind === kind);
    if (!group || !roster || !roster.sessions.some((session) => !session.pinned)) return null;
    const folded = kind === "terminals" ? group.terminalsCollapsed : group.chatsCollapsed;
    return (
      <section
        className="sidebar-section"
        aria-label={kind === "terminals" ? tx("独立终端") : tx("聊天")}
      >
        {sectionHeader(kind === "terminals" ? tx("终端") : tx("聊天"), !!folded, () =>
          update((previous) => ({
            ...previous,
            groups: previous.groups?.map((item) =>
              item.id !== group.id
                ? item
                : kind === "terminals"
                  ? { ...item, terminalsCollapsed: !folded }
                  : { ...item, chatsCollapsed: !folded },
            ),
          })),
        )}
        {!folded &&
          roster.sessions
            .filter((session) => !session.pinned)
            .map((session) => sessionRow(session, roster))}
      </section>
    );
  }
  function togglePopover(event: MouseEvent<HTMLButtonElement>, value: "workspace" | "add") {
    setConnectionMenu(null);
    triggerRef.current = event.currentTarget;
    setPopover((previous) => (previous === value ? null : value));
  }
  function act(action: () => void) {
    setPopover(null);
    action();
  }
  function navigationButton(view: SidebarView, name: string, icon: ReactNode) {
    return (
      <button
        className="sidebar-rail-button"
        aria-label={name}
        title={name}
        aria-pressed={shownView === view}
        aria-controls="sidebar-sections"
        onClick={() => {
          setPopover(null);
          setConnectionMenu(null);
          setSidebarView(view);
          if (!visible) toggleVisibility();
        }}
      >
        {icon}
      </button>
    );
  }
  const addButton = (
    <button
      className={`sidebar-add ${navigation ? "toolbar-icon-button" : "icon-button"}`}
      disabled={!runtime || !workspace}
      aria-label={tx("添加项目或会话")}
      title={tx("添加项目或会话")}
      aria-haspopup="menu"
      aria-expanded={popover === "add"}
      onClick={(event) => togglePopover(event, "add")}
    >
      <SidebarIcon name="plus" />
    </button>
  );
  return (
    <aside
      id="workspace-sidebar"
      className="sidebar"
      data-sidebar-style={settings.sidebarStyle}
      data-sidebar-collapsed={(navigation && !visible) || undefined}
      aria-label={tx("工作区")}
      hidden={!visible && !navigation}
    >
      {resizeHandle}
      {navigation && (
        <nav ref={navigationRef} className="sidebar-rail" aria-label={tx("侧栏导航")}>
          <div className="sidebar-rail-items">
            {navigationButton("all", tx("全部"), <SidebarIcon name="home" />)}
            {navigationButton("projects", tx("项目与会话"), <SidebarIcon name="folder" />)}
            {viewAvailable.ssh &&
              navigationButton("ssh", tx("SSH 连接"), <SidebarIcon name="terminal" />)}
            {viewAvailable.redis &&
              navigationButton("redis", tx("Redis 连接"), <SidebarIcon name="database" />)}
            {viewAvailable.database &&
              navigationButton("database", tx("数据库连接"), <SidebarIcon name="sqlDatabase" />)}
          </div>
          <div className="sidebar-rail-footer">
            {addButton}
            {footerActions}
          </div>
        </nav>
      )}
      <div className="sidebar-main" hidden={!visible}>
        <header className="sidebar-header" data-tauri-drag-region>
          <button
            className="workspace-switcher"
            disabled={!workspace}
            aria-label={tx("切换工作区")}
            aria-haspopup="menu"
            aria-expanded={popover === "workspace"}
            title={group?.name}
            onClick={(event) => togglePopover(event, "workspace")}
          >
            <span>{group?.name ?? tx("工作区")}</span>
          </button>
          <button
            className="icon-button sidebar-toggle"
            aria-label={tx("隐藏侧栏")}
            title={tx("隐藏侧栏")}
            aria-expanded={true}
            aria-controls="workspace-sidebar"
            onClick={() => {
              if (navigation)
                navigationRef.current
                  ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
                  ?.focus();
              act(toggleVisibility);
            }}
          >
            <SidebarIcon name="sidebar" />
          </button>
        </header>
        <nav id="sidebar-sections" className="project-list" aria-label={tx("项目与会话")}>
          {showing("projects") && activeProjects.length > 0 && (
            <section className="sidebar-section" aria-label={tx("活动")}>
              {sectionHeader(
                tx("活动"),
                !!collapsed.active,
                () => setCollapsed((value) => ({ ...value, active: !value.active })),
                "active",
              )}
              {!collapsed.active && activeProjects.map(projectBlock)}
            </section>
          )}
          {showing("projects") && pinned.length > 0 && (
            <section className="sidebar-section" aria-label={tx("已固定")}>
              {sectionHeader(
                tx("已固定"),
                !!collapsed.pinned,
                () => setCollapsed((value) => ({ ...value, pinned: !value.pinned })),
                "pinned",
              )}
              {!collapsed.pinned && pinned}
            </section>
          )}
          {dragError && <p role="alert">{localizeMessage(dragError)}</p>}
          {visibilityError && <p role="alert">{localizeMessage(visibilityError)}</p>}
          {showing("ssh") && addSsh && showSsh && (
            <section className="sidebar-section" aria-label={tx("SSH")}>
              {sectionHeader(
                tx("SSH"),
                !!collapsed.ssh,
                () => setCollapsed((value) => ({ ...value, ssh: !value.ssh })),
                undefined,
                <button
                  className="icon-button"
                  aria-label={tx("添加 SSH 连接")}
                  title={tx("添加 SSH 连接")}
                  disabled={!runtime}
                  onClick={addSsh}
                >
                  <SidebarIcon name="plus" />
                </button>,
              )}
              {!collapsed.ssh && (
                <div className="ssh-sidebar-tools">
                  {quickSsh && (
                    <button disabled={!runtime || activityDisabled} onClick={quickSsh}>
                      {tx("快速 SSH 连接")}
                    </button>
                  )}
                  <input
                    type="search"
                    aria-label={tx("搜索 SSH 主机")}
                    placeholder={tx("搜索 SSH 主机")}
                    value={sshQuery}
                    onChange={(event) => setSshQuery(event.target.value)}
                  />
                  {sshQuery.trim() &&
                    !(group?.sshConnections ?? []).some((item) => matchesSsh(item, sshQuery)) && (
                      <p className="muted">{tx("没有匹配的 SSH 主机")}</p>
                    )}
                </div>
              )}
              {!collapsed.ssh &&
                (group?.sshConnections ?? [])
                  .filter((connection) => matchesSsh(connection, sshQuery))
                  .map((connection) => {
                    const roster = rosterById.get(`ssh:${connection.id}`)!;
                    return (
                      <div key={connection.id} className="ssh-connection">
                        <div
                          className="sidebar-row"
                          onContextMenu={(event) => openConnectionMenu(event, "ssh", connection.id)}
                          onKeyDown={(event) => openConnectionMenu(event, "ssh", connection.id)}
                        >
                          <button
                            className="row-label"
                            title={`${connection.name} — ${connection.host} · ${connection.root || tx("服务端登录目录")}`}
                            aria-description={
                              connection.sessions.length ? tx("有未关闭的会话") : undefined
                            }
                            disabled={activityDisabled}
                            onClick={() => selectSsh?.(connection)}
                          >
                            <span
                              className="sidebar-resource-icon"
                              data-resource-active={connection.sessions.length > 0 || undefined}
                              aria-hidden="true"
                            >
                              <SessionIcon />
                            </span>
                            <span className="sidebar-row-name">
                              {connection.name}
                              {connection.temporary ? " · " + tx("临时") : ""}
                            </span>
                          </button>
                          <button
                            className="icon-button row-close"
                            aria-label={tx("移除 SSH 连接：{p0}", { p0: connection.name })}
                            title={tx("移除 SSH 连接")}
                            disabled={!canRemoveSsh?.(connection)}
                            onClick={() =>
                              setRemoval({ kind: "ssh", connection, workspaceId: group!.id })
                            }
                          >
                            <ToolbarIcon name="close" />
                          </button>
                        </div>
                        {ordered(connection.sessions).map((session) =>
                          sessionRow(session, roster, 1, connection.name, true),
                        )}
                      </div>
                    );
                  })}
            </section>
          )}
          {showing("redis") && addRedis && showRedis && (
            <section className="sidebar-section" aria-label={tx("Redis")}>
              {sectionHeader(
                tx("Redis"),
                !!collapsed.redis,
                () => setCollapsed((value) => ({ ...value, redis: !value.redis })),
                undefined,
                <button
                  className="icon-button"
                  aria-label={tx("添加 Redis 连接")}
                  title={tx("添加 Redis 连接")}
                  disabled={!runtime}
                  onClick={addRedis}
                >
                  <SidebarIcon name="plus" />
                </button>,
              )}
              {!collapsed.redis &&
                (group?.redisConnections ?? []).map((connection) => {
                  const status = redisStatuses[connection.id];
                  const retained = status?.connected || status?.dirty || status?.opening;
                  return (
                    <div
                      className={`sidebar-row${selectedRedisId === connection.id ? " selected" : ""}`}
                      key={connection.id}
                      onContextMenu={(event) => openConnectionMenu(event, "redis", connection.id)}
                      onKeyDown={(event) => openConnectionMenu(event, "redis", connection.id)}
                    >
                      <button
                        className="row-label"
                        title={`${connection.name} — ${connection.host}:${connection.port}`}
                        aria-description={status?.connected ? tx("已连接") : undefined}
                        disabled={activityDisabled}
                        onClick={() => selectRedis?.(connection)}
                      >
                        <span
                          className="sidebar-resource-icon"
                          data-resource-active={status?.connected || undefined}
                          aria-hidden="true"
                        >
                          <span
                            className="redis-sidebar-icon"
                            data-connected={status?.connected || undefined}
                          >
                            {"R"}
                          </span>
                        </span>
                        <span className="sidebar-row-name">
                          {connection.name}
                          {status?.dirty ? " *" : ""}
                        </span>
                      </button>
                      <button
                        className="icon-button row-close"
                        title={tx("移除 Redis 连接")}
                        aria-label={tx("移除 Redis 连接：{name}", { name: connection.name })}
                        disabled={!!retained}
                        onClick={() =>
                          setRemoval({ kind: "redis", connection, workspaceId: group!.id })
                        }
                      >
                        <ToolbarIcon name="close" />
                      </button>
                    </div>
                  );
                })}
            </section>
          )}
          {showing("database") && addDatabase && showDatabase && (
            <section className="sidebar-section" aria-label={tx("数据库")}>
              {sectionHeader(
                tx("数据库"),
                !!collapsed.database,
                () => setCollapsed((value) => ({ ...value, database: !value.database })),
                undefined,
                <>
                  <button
                    className="icon-button"
                    aria-label={tx("数据库组件")}
                    title={tx("数据库组件")}
                    disabled={!runtime}
                    onClick={manageDatabase}
                  >
                    <ToolbarIcon name="settings" />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={tx("添加数据库连接")}
                    title={tx("添加数据库连接")}
                    disabled={!runtime}
                    onClick={addDatabase}
                  >
                    <SidebarIcon name="plus" />
                  </button>
                </>,
              )}
              {!collapsed.database &&
                (group?.databaseConnections ?? []).map((connection) => {
                  const status = databaseStatuses[connection.id];
                  const retained = status?.connected || status?.busy || status?.dirty;
                  return (
                    <div
                      className={`sidebar-row${selectedDatabaseId === connection.id ? " selected" : ""}`}
                      key={connection.id}
                      onContextMenu={(event) =>
                        openConnectionMenu(event, "database", connection.id)
                      }
                      onKeyDown={(event) => openConnectionMenu(event, "database", connection.id)}
                    >
                      <button
                        className="row-label"
                        title={`${connection.name} — ${connection.host}:${connection.port}`}
                        aria-description={status?.connected ? tx("已连接") : undefined}
                        disabled={activityDisabled}
                        onClick={() => selectDatabase?.(connection)}
                      >
                        <span
                          className="sidebar-resource-icon"
                          data-resource-active={status?.connected || undefined}
                          aria-hidden="true"
                        >
                          <SidebarIcon name="sqlDatabase" />
                        </span>
                        <span className="sidebar-row-name">
                          {connection.name}
                          {status?.dirty ? " *" : ""}
                        </span>
                      </button>
                      <button
                        className="icon-button row-close"
                        title={tx("移除数据库连接")}
                        aria-label={tx("移除数据库连接：{name}", { name: connection.name })}
                        disabled={!!retained}
                        onClick={() =>
                          setRemoval({ kind: "database", connection, workspaceId: group!.id })
                        }
                      >
                        <ToolbarIcon name="close" />
                      </button>
                    </div>
                  );
                })}
            </section>
          )}
          {showing("projects") && looseSection("terminals")}
          {showing("projects") && looseSection("chats")}
          {showing("projects") && (
            <section className="sidebar-section" aria-label={tx("项目")}>
              {sectionHeader(
                tx("项目"),
                !!collapsed.projects,
                () => setCollapsed((value) => ({ ...value, projects: !value.projects })),
                "projects",
              )}
              {!collapsed.projects &&
                inactiveProjects.filter((project) => !project.pinned).map(projectBlock)}
              {!projects.length && (
                <button className="sidebar-empty" disabled={!runtime} onClick={addProject}>
                  {tx("添加项目…")}
                </button>
              )}
            </section>
          )}
        </nav>
        {!navigation && (
          <footer className="sidebar-footer">
            {addButton}
            <div className="sidebar-connection-toggles">
              {addSsh && (
                <button
                  className="sidebar-connection-toggle"
                  aria-label={tx("SSH 连接")}
                  aria-pressed={settings.showSshConnections}
                  title={settings.showSshConnections ? tx("隐藏 SSH 连接") : tx("显示 SSH 连接")}
                  onClick={() => toggleConnections("showSshConnections")}
                >
                  <SidebarIcon name="terminal" />
                </button>
              )}
              {addRedis && (
                <button
                  className="sidebar-connection-toggle"
                  aria-label={tx("Redis 连接")}
                  aria-pressed={settings.showRedisConnections}
                  title={
                    settings.showRedisConnections ? tx("隐藏 Redis 连接") : tx("显示 Redis 连接")
                  }
                  onClick={() => toggleConnections("showRedisConnections")}
                >
                  <SidebarIcon name="database" />
                </button>
              )}
              {addDatabase && (
                <button
                  className="sidebar-connection-toggle"
                  aria-label={tx("数据库连接")}
                  aria-pressed={settings.showDatabaseConnections}
                  title={
                    settings.showDatabaseConnections ? tx("隐藏数据库连接") : tx("显示数据库连接")
                  }
                  onClick={() => toggleConnections("showDatabaseConnections")}
                >
                  <SidebarIcon name="sqlDatabase" />
                </button>
              )}
            </div>
            {footerActions}
          </footer>
        )}
      </div>
      {removal && (
        <dialog
          ref={removalDialog}
          className="name-dialog connection-removal-dialog"
          aria-labelledby="connection-removal-title"
          aria-describedby="connection-removal-description"
          onCancel={(event) => {
            event.preventDefault();
            setRemoval(null);
          }}
        >
          <h2 id="connection-removal-title">
            {removal.kind === "ssh"
              ? tx("移除 SSH 连接")
              : removal.kind === "redis"
                ? tx("移除 Redis 连接")
                : tx("移除数据库连接")}
          </h2>
          <p id="connection-removal-description">
            {tx("确定移除连接“{name}”？此操作会删除保存的连接配置及其已记住的密码。", {
              name: removal.connection.name,
            })}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              confirmRemoval();
            }}
          >
            <div>
              <button ref={cancelRemoval} type="button" onClick={() => setRemoval(null)}>
                {tx("取消")}
              </button>
              <button type="submit" disabled={!removalAllowed}>
                {tx("确认移除")}
              </button>
            </div>
          </form>
        </dialog>
      )}
      {connectionMenuVisible &&
        createPortal(
          <div
            ref={connectionMenuRef}
            role="menu"
            aria-label={tx("侧栏操作")}
            className="context-menu"
            style={{ maxWidth: "calc(100vw - 16px)" }}
            tabIndex={-1}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (event.key === "Tab") {
                setConnectionMenu(null);
                connectionMenu?.trigger.focus();
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              );
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                      buttons.length
              ]?.focus();
            }}
          >
            {connectionActions.map((action) => (
              <button
                key={action.label}
                role="menuitem"
                disabled={action.disabled}
                onClick={() => {
                  setConnectionMenu(null);
                  action.run();
                }}
              >
                {action.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
      {popover &&
        createPortal(
          <div
            ref={popoverRef}
            role="menu"
            aria-label={popover === "workspace" ? tx("工作区菜单") : tx("添加菜单")}
            className={`sidebar-popover context-menu ${popover}`}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) return;
              if (event.key === "Tab") {
                setPopover(null);
                return;
              }
              event.preventDefault();
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              );
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                      buttons.length
              ]?.focus();
            }}
          >
            {popover === "workspace" ? (
              <>
                {workspace?.groups?.map((item) => (
                  <button
                    key={item.id}
                    role="menuitemradio"
                    aria-checked={item.id === group?.id}
                    onClick={() =>
                      act(() => update((previous) => switchWorkspace(previous, item.id)))
                    }
                  >
                    <span className="menu-check">{item.id === group?.id ? "✓" : ""}</span>
                    {item.name}
                  </button>
                ))}
                <hr />
                <button role="menuitem" onClick={() => act(newWorkspace)}>
                  {tx("新建工作区…")}
                </button>
                <button role="menuitem" onClick={() => act(renameWorkspace)}>
                  {tx("重命名工作区…")}
                </button>
                {(workspace?.groups?.length ?? 0) > 1 &&
                  !projects.length &&
                  !group?.sshConnections?.length &&
                  !group?.redisConnections?.length &&
                  !group?.databaseConnections?.length &&
                  !rosters.some((roster) => roster.sessions.length) && (
                    <button
                      role="menuitem"
                      onClick={() =>
                        act(() =>
                          update((previous) => {
                            const target = previous.groups?.find(
                              (item) => item.id !== previous.selectedWorkspace,
                            );
                            if (!target) return previous;
                            const next = switchWorkspace(previous, target.id);
                            return {
                              ...next,
                              groups: next.groups?.filter(
                                (item) => item.id !== previous.selectedWorkspace,
                              ),
                            };
                          }),
                        )
                      }
                    >
                      {tx("移除工作区")}
                    </button>
                  )}
              </>
            ) : (
              <>
                <button role="menuitem" onClick={() => act(() => addLoose("terminals"))}>
                  <SessionIcon />
                  {tx("新建终端")}
                </button>
                <button role="menuitem" onClick={() => act(addProject)}>
                  <SidebarIcon name="folder" />
                  {tx("添加项目…")}
                </button>
                {availableAgents(settings, runtime?.agents ?? []).map((agent) => (
                  <button
                    key={agent}
                    role="menuitem"
                    onClick={() => act(() => addLoose("chats", agent))}
                  >
                    <SessionIcon agent={agent} />
                    {tx("新建 {p0} 聊天", {
                      p0:
                        runtime?.agent_definitions.find((item) => item.id === agent)?.name ??
                        agentNames[agent] ??
                        agent,
                    })}
                  </button>
                ))}
                {addSsh && showSsh && (
                  <button role="menuitem" onClick={() => act(addSsh)}>
                    <SessionIcon />
                    {tx("添加 SSH 连接")}
                  </button>
                )}
                {addRedis && showRedis && (
                  <button role="menuitem" onClick={() => act(addRedis)}>
                    <SidebarIcon name="database" />
                    {tx("添加 Redis 连接")}
                  </button>
                )}
                {addDatabase && showDatabase && (
                  <button role="menuitem" onClick={() => act(addDatabase)}>
                    <SidebarIcon name="sqlDatabase" />
                    {tx("添加数据库连接")}
                  </button>
                )}
              </>
            )}
          </div>,
          document.body,
        )}
    </aside>
  );
}
