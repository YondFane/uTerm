import { availableAgents } from "../lib/settings";
import { localizeMessage } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { tx } from "../lib/i18n";
import { useSettings } from "../lib/SettingsContext";
import type { MouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  ordered,
  reorderProject,
  selectProject,
  selectSession,
  sessionRosters,
  splitGroup,
  switchWorkspace,
} from "../lib/workspace";
import type { Project, SessionConfig, SessionRoster, Workspace, Worktree } from "../lib/workspace";
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
}: {
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
  useUiLanguage();

  const { settings, save } = useSettings();
  const draggedProject = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const suppressProjectClick = useRef(false);
  const [projectDrop, setProjectDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [dragError, setDragError] = useState("");
  const [popover, setPopover] = useState<"workspace" | "add" | null>(null);
  const [activeFolded, setActiveFolded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
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
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
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
  const projects = ordered(
    workspace?.projects.filter((project) => project.workspaceId === workspace.selectedWorkspace) ??
      [],
  );
  if (settings.projectOrder === "name")
    projects.sort(
      (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.name.localeCompare(b.name),
    );
  const rosters = workspace
    ? sessionRosters(workspace).filter(
        (roster) => roster.workspaceId === workspace.selectedWorkspace,
      )
    : [];
  const openMenu = (event: MouseEvent, kind: SidebarMenu["kind"], id: string, project: string) => {
    event.preventDefault();
    setPopover(null);
    menu({ kind, id, project, x: event.clientX, y: event.clientY });
  };
  function moreButton(kind: SidebarMenu["kind"], id: string, project: string, name: string) {
    return (
      <button
        className="icon-button"
        aria-label={tx("{p0}的操作", { p0: name })}
        title={tx("更多操作")}
        onClick={(event) => openMenu(event, kind, id, project)}
      >
        <SidebarIcon name="more" />
      </button>
    );
  }
  function quickActions(project: Project, worktree?: Worktree) {
    return (
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
        {moreButton(
          worktree ? "worktree" : "project",
          worktree?.id ?? project.id,
          project.id,
          worktree?.name ?? project.name,
        )}
      </div>
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
          <span>{session.name}</span>
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
          className="icon-button session-close"
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
    const source = projects.find((item) => item.id === sourceId);
    if (!source) return null;
    for (const row of document.querySelectorAll<HTMLElement>(".folder-row[data-project-id]")) {
      const target = projects.find((item) => item.id === row.dataset.projectId);
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
        onContextMenu={(event) =>
          openMenu(event, worktree ? "worktree" : "project", item.id, project.id)
        }
      >
        <button
          className="folder-toggle icon-button"
          aria-label={`${folded ? tx("展开") : tx("折叠")}${item.name}`}
          aria-expanded={!folded}
          onClick={() => {
            if (active) {
              setActiveFolded((previous) => ({
                ...previous,
                [activeKey(project, worktree)]: !folded,
              }));
              return;
            }
            projectChange(project, (value) =>
              worktree
                ? {
                    ...value,
                    worktrees: value.worktrees?.map((entry) =>
                      entry.id === worktree.id ? { ...entry, collapsed: !entry.collapsed } : entry,
                    ),
                  }
                : { ...value, collapsed: !value.collapsed },
            );
          }}
        >
          <SidebarIcon name={folded ? "folderClosed" : "folder"} />
          <span className={`folder-chevron${folded ? "" : " expanded"}`}>
            <SidebarIcon name="chevron" />
          </span>
        </button>
        <button
          className="row-label"
          disabled={active && activityDisabled}
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
              ? `${worktree.path}${worktree.missing ? tx(" — 目录不可用") : ""}`
              : project.directory
          }
          onClick={() => {
            if (!worktree && suppressProjectClick.current) {
              suppressProjectClick.current = false;
              return;
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
          <span>{item.name}</span>
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
    const roster = rosters.find((roster) => roster.id === project.id);
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
    const roster = rosters.find((roster) => roster.id === project.id);
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
    const project = projects.find((project) => project.id === roster.projectId);
    if (project?.pinned || project?.sessions.length) continue;
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
  ) {
    const folders = section ? sectionFolders(section) : [];
    const allFoldersCollapsed = folders.length > 0 && folders.every((folder) => folder.collapsed);
    return (
      <div className="section-header">
        <button className="section-toggle" aria-expanded={!isCollapsed} onClick={toggle}>
          {name}
          <span className={isCollapsed ? "" : "expanded"}>
            <SidebarIcon name="chevron" />
          </span>
        </button>
        {section && (
          <button
            className="icon-button section-action"
            aria-label={tx("{p0}：{p1}项目会话", {
              p0: name,
              p1: allFoldersCollapsed ? tx("全部展开") : tx("全部折叠"),
            })}
            title={allFoldersCollapsed ? tx("全部展开项目会话") : tx("全部折叠项目会话")}
            aria-expanded={!allFoldersCollapsed}
            disabled={!folders.length}
            onClick={() => setSectionCollapsed(section, !allFoldersCollapsed)}
          >
            <ToolbarIcon name={allFoldersCollapsed ? "expandAll" : "collapseAll"} />
          </button>
        )}
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
    triggerRef.current = event.currentTarget;
    setPopover((previous) => (previous === value ? null : value));
  }
  function act(action: () => void) {
    setPopover(null);
    action();
  }
  return (
    <aside id="workspace-sidebar" className="sidebar" aria-label={tx("工作区")} hidden={!visible}>
      {resizeHandle}
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
          onClick={() => act(toggleVisibility)}
        >
          <SidebarIcon name="sidebar" />
        </button>
      </header>
      <nav className="project-list" aria-label={tx("项目与会话")}>
        {activeProjects.length > 0 && (
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
        {pinned.length > 0 && (
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
        {looseSection("terminals")}
        {looseSection("chats")}
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
      </nav>
      <footer className="sidebar-footer">
        <button
          className="icon-button"
          disabled={!runtime || !workspace}
          aria-label={tx("添加项目或会话")}
          title={tx("添加项目或会话")}
          aria-haspopup="menu"
          aria-expanded={popover === "add"}
          onClick={(event) => togglePopover(event, "add")}
        >
          <SidebarIcon name="plus" />
        </button>
        {footerActions}
      </footer>
      {popover && (
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
                  : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
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
              <button role="menuitem" onClick={() => act(addProject)}>
                <SidebarIcon name="folder" />
                {tx("添加项目…")}
              </button>
              <button role="menuitem" onClick={() => act(() => addLoose("terminals"))}>
                <SessionIcon />
                {tx("新建终端")}
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
            </>
          )}
        </div>
      )}
    </aside>
  );
}
