import { UpdateInstallDialog } from "./components/UpdateInstallDialog";
import { getUiLanguage, localizeMessage } from "./lib/i18n";
import { useUiLanguage } from "./lib/useUiLanguage";
import { tx } from "./lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { sessionSyncErrorMessage } from "./lib/session-sync";
import type { CSSProperties } from "react";
import {
  hasInspectorContent,
  inspectorLayout,
  inspectorDragLayout,
  inspectorResizeWidth,
} from "./lib/inspector-layout";
import { CommandPalette } from "./components/CommandPalette";
import { useUpdates } from "./lib/useUpdates";
import { SettingsPanel } from "./components/SettingsPanel";
import { BreakReminder } from "./components/BreakReminder";
import { useSettings } from "./lib/SettingsContext";
import { activeLanguage, translate } from "./lib/i18n";
import { quotaAgent, remainingUsage, scheduleUsageRefresh, type UsageWindow } from "./lib/usage";
import {
  availableAgents,
  binding,
  chord,
  commands,
  sessionLink,
  sessionFromLink,
  shortcutLabel,
} from "./lib/settings";
import type { CommandId } from "./lib/settings";
import { isDirty } from "./lib/file-document";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { agentNames, SidebarIcon, ToolbarIcon } from "./components/SidebarIcon";
import { sendNotification, isPermissionGranted } from "@tauri-apps/plugin-notification";
import { AgentPanel, notificationKey } from "./components/AgentPanel";
import { GitHubPanel } from "./components/GitHubPanel";
import { DirectoryPanel } from "./components/DirectoryPanel";
import { GitPanel } from "./components/GitPanel";
import { BranchSelector } from "./components/BranchSelector";
import { ProjectMenuActions } from "./components/ProjectMenuActions";
import { FilePanel } from "./components/FilePanel";
import type { FileMode } from "./components/FilePanel";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { DeferredFileEditor } from "./components/DeferredFileEditor";
import { useFileDocument } from "./lib/useFileDocument";
import { Sidebar } from "./components/Sidebar";
import type { SidebarMenu } from "./components/Sidebar";
import { TerminalWorkspace } from "./components/TerminalWorkspace";
import { getRuntimeInfo, isDesktop } from "./lib/desktop";
import type { RuntimeInfo } from "./lib/desktop";
import { buildTaskbarSnapshot, taskbarSnapshotSignature } from "./lib/taskbar";
import {
  emptyWorkspace,
  createWorkspaceGroup,
  readWorkspace,
  removeSession,
  selectProject,
  workspaceKey,
  switchWorkspace,
  reorder,
  moveProject,
  removeProject,
  splitGroup,
  selectedRoster,
  nextSessionToClose,
  cycleSession,
  sessionRosters,
  sessionEntries,
  updateRoster,
  selectSession,
  groupableSessions,
  reconcileWorktrees,
  reconcileLocalSessionSnapshot,
  groupSessions,
  ungroupSession,
  neighborPane,
} from "./lib/workspace";
import type {
  PaneDirection,
  Project,
  SessionConfig,
  SplitAxis,
  Worktree,
  Workspace,
  LocalSessionSnapshot,
} from "./lib/workspace";

import { sidebarLayout, panelCollapseWidth } from "./lib/sidebar-layout";

export function App() {
  useUiLanguage();

  const { settings, save: saveSettings } = useSettings();
  const inspectorOnLeft = settings.inspectorPosition === "left";
  const t = (key: string) => translate(activeLanguage(settings.language), key);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [requestedSidebarWidth, setRequestedSidebarWidth] = useState(248);
  const sidebarDrag = useRef<{ x: number; width: number; collapse?: boolean } | null>(null);
  const [sidebarSnap, setSidebarSnap] = useState(false);
  const [inspectorSnap, setInspectorSnap] = useState(false);
  const [sidebarCollapseHint, setSidebarCollapseHint] = useState(false);
  const [inspectorCollapseHint, setInspectorCollapseHint] = useState(false);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [gitExpanded, setGitExpanded] = useState(false);
  const [gitDiffActive, setGitDiffActive] = useState(false);
  const [gitDiffPath, setGitDiffPath] = useState<string | null>(null);
  const changeGitExpanded = useCallback((expanded: boolean) => {
    setGitExpanded(expanded);
    setGitDiffActive(expanded);
  }, []);
  const [gitDiffTarget, setGitDiffTarget] = useState<HTMLDivElement | null>(null);
  const shellElement = useRef<HTMLDivElement>(null);
  const [shellWidth, setShellWidth] = useState(window.innerWidth);
  const [inspectorRatio, setInspectorRatio] = useState(0.35);
  const [resizingInspector, setResizingInspector] = useState(false);
  const inspectorDrag = useRef<{ x: number; width: number; collapse?: boolean } | null>(null);
  useEffect(() => {
    const shell = shellElement.current;
    if (!shell) return;
    const observer = new ResizeObserver(() => setShellWidth(shell.clientWidth));
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);
  const sidebarSize = sidebarLayout(shellWidth, requestedSidebarWidth);
  const sidebarWidth = sidebarVisible ? sidebarSize.width : 0;
  function resizeSidebar(width: number) {
    const next = sidebarLayout(shellWidth, width);
    if (next.hidden) {
      sidebarDrag.current = null;
      setResizingSidebar(false);
      setSidebarVisible(false);
    } else setRequestedSidebarWidth(next.width);
  }
  const sidebarResizeHandle = (
    <div
      className="sidebar-resizer"
      role="separator"
      tabIndex={0}
      aria-label={tx("调整左侧栏宽度")}
      aria-orientation="vertical"
      aria-valuemin={panelCollapseWidth}
      aria-valuemax={Math.round(sidebarSize.maximum)}
      aria-valuenow={Math.round(sidebarWidth)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        sidebarDrag.current = { x: event.clientX, width: sidebarWidth };
        setResizingSidebar(true);
      }}
      onPointerMove={(event) => {
        const drag = sidebarDrag.current;
        if (!drag) return;
        const next = sidebarLayout(shellWidth, drag.width + event.clientX - drag.x);
        drag.collapse = next.hidden;
        setSidebarSnap(next.hidden);
        setRequestedSidebarWidth(next.width);
      }}
      onPointerUp={(event) => {
        if (sidebarDrag.current?.collapse) {
          setRequestedSidebarWidth(sidebarDrag.current.width);
          setSidebarVisible(false);
          setSidebarCollapseHint(true);
        }
        setSidebarSnap(false);
        sidebarDrag.current = null;
        setResizingSidebar(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        setSidebarSnap(false);
        sidebarDrag.current = null;
        setResizingSidebar(false);
      }}
      onPointerCancel={() => {
        setSidebarSnap(false);
        sidebarDrag.current = null;
        setResizingSidebar(false);
      }}
      onDoubleClick={() => setRequestedSidebarWidth(248)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
        event.preventDefault();
        resizeSidebar(
          event.key === "Home"
            ? panelCollapseWidth
            : event.key === "End"
              ? sidebarSize.maximum
              : event.key === "Enter"
                ? 248
                : sidebarWidth + (event.key === "ArrowLeft" ? -24 : 24),
        );
      }}
    />
  );
  const inspectorSize = inspectorLayout(shellWidth - sidebarWidth, inspectorRatio);
  const resizeHandle = (
    <div
      className="inspector-resizer"
      role="separator"
      aria-label={tx("调整工具面板宽度")}
      aria-orientation="vertical"
      tabIndex={0}
      aria-valuemin={Math.round((inspectorSize.minimum / inspectorSize.available) * 100)}
      aria-valuemax={Math.round((inspectorSize.maximum / inspectorSize.available) * 100)}
      aria-valuenow={Math.round(inspectorSize.ratio * 100)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        inspectorDrag.current = { x: event.clientX, width: inspectorSize.width };
        setResizingInspector(true);
      }}
      onPointerMove={(event) => {
        const drag = inspectorDrag.current;
        if (!drag) return;
        const next = inspectorDragLayout(
          inspectorSize.available,
          inspectorResizeWidth(drag.width, event.clientX - drag.x, settings.inspectorPosition),
        );
        drag.collapse = next.hidden;
        setInspectorSnap(next.hidden);
        setInspectorRatio(next.ratio);
      }}
      onPointerUp={(event) => {
        if (inspectorDrag.current?.collapse) {
          setInspectorRatio(inspectorDrag.current.width / inspectorSize.available);
          if (inspectorVisible) {
            toggleInspector();
            setInspectorCollapseHint(true);
          }
        }
        setInspectorSnap(false);
        inspectorDrag.current = null;
        setResizingInspector(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        setInspectorSnap(false);
        inspectorDrag.current = null;
        setResizingInspector(false);
      }}
      onDoubleClick={() => setInspectorRatio(0.35)}
      onPointerCancel={() => {
        setInspectorSnap(false);
        inspectorDrag.current = null;
        setResizingInspector(false);
      }}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
        event.preventDefault();
        const width =
          event.key === "Home"
            ? inspectorSize.minimum
            : event.key === "End"
              ? inspectorSize.maximum
              : event.key === "Enter"
                ? inspectorSize.available * 0.35
                : inspectorResizeWidth(
                    inspectorSize.width,
                    event.key === "ArrowLeft" ? -16 : 16,
                    settings.inspectorPosition,
                  );
        setInspectorRatio(
          inspectorLayout(inspectorSize.available, width / inspectorSize.available).ratio,
        );
      }}
    />
  );

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const enabledAgents = availableAgents(settings, runtime?.agents ?? []);
  const chatAgent = enabledAgents.includes(settings.defaultAgent)
    ? settings.defaultAgent
    : enabledAgents[0];
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentStates, setAgentStates] = useState<Record<string, string>>({});
  const [unreadCompletedSessions, setUnreadCompletedSessions] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [detectedAgents, setDetectedAgents] = useState<Record<string, string>>({});
  const agentStateValues = useRef<Record<string, string>>({});
  const [repositoryRevision, setRepositoryRevision] = useState(0);
  const lastInspector = useRef<"files" | "git" | "github" | "directory">("files");
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);
  const [fileMode, setFileMode] = useState<FileMode>("tree");
  const [fileRequest, setFileRequest] = useState(0);
  const editor = useFileDocument(settings.fileTabLimit);
  useEffect(() => {
    if (editor.document) setGitDiffActive(false);
  }, [editor.document?.id]);
  const updates = useUpdates(
    editor.prepareUpdate,
    editor.restoreUpdateGuard,
    settings.automaticUpdates,
  );
  const [error, setError] = useState("");
  const [sessionSyncError, setSessionSyncError] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const currentWorkspace = useRef<Workspace | null>(null);
  const [directory, setDirectory] = useState("");
  const [shell, setShell] = useState<"default" | "cmd">("default");
  useEffect(() => {
    setShell(settings.defaultShell);
  }, [settings.defaultShell]);
  const [adding, setAdding] = useState(false);
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const [projectDirectoriesToAdd, setProjectDirectoriesToAdd] = useState<string[]>([]);
  const [showProjectDialog, setShowProjectDialog] = useState(false);
  const projectDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (showProjectDialog) projectDialog.current?.showModal();
    else projectDialog.current?.close();
  }, [showProjectDialog]);
  const [closeRequest, setCloseRequest] = useState<{ id: string; sequence: number } | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (!settingsOpen && !paletteOpen && !agentOpen && !editor.document)
      setFocusRequest((value) => value + 1);
  }, [settingsOpen, paletteOpen, agentOpen]);
  const [zoomedGroup, setZoomedGroup] = useState<string | null>(null);

  const [menu, setMenu] = useState<SidebarMenu | null>(null);
  const [editing, setEditing] = useState<{
    kind: "workspace" | "project" | "worktree" | "session" | "new";
    id: string;
    name: string;
    project?: string;
  } | null>(null);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const nameDialog = useRef<HTMLDialogElement>(null);
  const isEditing = editing !== null;
  useEffect(() => {
    if (isEditing) nameDialog.current?.showModal();
    else nameDialog.current?.close();
  }, [isEditing]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [menu]);

  async function load(cancelled: () => boolean = () => false) {
    setError("");
    try {
      const serialized = localStorage.getItem(workspaceKey);
      const saved = readWorkspace(serialized);
      if (cancelled()) return;
      currentWorkspace.current = saved;
      setWorkspace(saved);
    } catch (reason) {
      if (!cancelled()) setError(tx("无法读取工作区：{p0}", { p0: String(reason) }));
    }
  }
  useEffect(() => {
    if (!isDesktop()) {
      const empty = emptyWorkspace();
      currentWorkspace.current = empty;
      setWorkspace(empty);
      return;
    }
    let cancelled = false;
    void load(() => cancelled);
    getRuntimeInfo().then(
      (info) => {
        if (!cancelled) {
          setRuntime(info);
          setDirectory(info.home);
        }
      },
      (reason: unknown) => {
        if (!cancelled) setError(String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  function update(change: (workspace: Workspace) => Workspace) {
    const previous = currentWorkspace.current;
    if (!previous) return;
    try {
      const next = change(previous);
      // Synchronous persistence prevents an older asynchronous save from winning.
      localStorage.setItem(workspaceKey, JSON.stringify(next));
      currentWorkspace.current = next;
      setWorkspace(next);
      setError("");
    } catch (reason) {
      setError(tx("无法保存工作区：{p0}", { p0: String(reason) }));
    }
  }

  useEffect(() => {
    if (!runtime || !workspace) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const discover = async () => {
      try {
        const snapshot = await invoke<LocalSessionSnapshot>("local_session_list");
        if (cancelled) return;
        setSessionSyncError("");
        const current = currentWorkspace.current;
        if (current) {
          const next = reconcileLocalSessionSnapshot(current, snapshot);
          if (next !== current) update(() => next);
        }
      } catch (reason) {
        if (!cancelled) setSessionSyncError(sessionSyncErrorMessage(reason));
      } finally {
        if (!cancelled) timer = setTimeout(discover, 2000);
      }
    };
    void discover();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [!!runtime, !!workspace]);

  function acknowledgeCompletedSession(id: string) {
    setUnreadCompletedSessions((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
    if (agentStateValues.current[id] !== "done") return;
    void invoke("control_session", { id, action: "acknowledge" })
      .then(() => {
        if (agentStateValues.current[id] !== "done") return;
        agentStateValues.current = { ...agentStateValues.current, [id]: "idle" };
        setAgentStates(agentStateValues.current);
      })
      .catch((reason) => setError(tx("无法确认任务状态：{p0}", { p0: String(reason) })));
  }

  function revealTaskbarSession(id: string) {
    const reveal = () => {
      setGitDiffActive(false);
      const state = currentWorkspace.current;
      const target = state
        ? sessionRosters(state).find((roster) =>
            roster.sessions.some((session) => session.id === id),
          )
        : undefined;
      if (!target) {
        setError(tx("找不到此会话；它可能已被关闭。"));
        return;
      }
      update((previous) => selectSession(switchWorkspace(previous, target.workspaceId), id));
      setFocusRequest((value) => value + 1);
      acknowledgeCompletedSession(id);
    };
    if (editor.document) void editor.hide(reveal);
    else reveal();
  }

  const taskbarSelection = useRef(revealTaskbarSession);
  taskbarSelection.current = revealTaskbarSession;
  useEffect(() => {
    if (!runtime) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("taskbar-session-selected", (event) =>
      taskbarSelection.current(event.payload),
    )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((reason) => setError(tx("无法监听任务栏操作：{p0}", { p0: String(reason) })));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [!!runtime]);

  const lastTaskbarSnapshot = useRef("");
  const pendingTaskbarSnapshot = useRef("");
  useEffect(() => {
    if (!runtime || !workspace) return;
    const snapshot = buildTaskbarSnapshot(
      workspace,
      agentStates,
      detectedAgents,
      settings.language,
      undefined,
      unreadCompletedSessions,
    );
    const signature = taskbarSnapshotSignature(snapshot);
    if (signature === lastTaskbarSnapshot.current || signature === pendingTaskbarSnapshot.current)
      return;
    pendingTaskbarSnapshot.current = signature;
    let invoked = false;
    const timer = window.setTimeout(() => {
      invoked = true;
      void invoke("taskbar_sync", { snapshot })
        .then(() => {
          lastTaskbarSnapshot.current = signature;
        })
        .catch((reason) => setError(tx("无法更新任务栏：{p0}", { p0: String(reason) })))
        .finally(() => {
          if (pendingTaskbarSnapshot.current === signature) pendingTaskbarSnapshot.current = "";
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      if (!invoked && pendingTaskbarSnapshot.current === signature)
        pendingTaskbarSnapshot.current = "";
    };
  }, [runtime, workspace, agentStates, detectedAgents, settings.language, unreadCompletedSessions]);

  const projectDirectories =
    workspace?.projects.map((project) => `${project.id}:${project.directory}`).join("|") ?? "";
  useEffect(() => {
    if (!runtime) return;
    let cancelled = false;
    for (const project of currentWorkspace.current?.projects ?? []) {
      invoke<{ path: string; branch: string; missing: boolean }[]>("project_worktrees", {
        directory: project.directory,
      })
        .then((discovered) => {
          if (!cancelled)
            update((previous) => reconcileWorktrees(previous, project.id, discovered));
        })
        .catch((reason) => {
          console.warn(`Worktree discovery for ${project.directory}:`, reason);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [runtime, projectDirectories]);

  function openProjectDialog() {
    if (showProjectDialog) return;
    setProjectDirectoriesToAdd([]);
    setError("");
    setShowProjectDialog(true);
    if (runtime) void selectProjectDirectory();
  }

  async function selectProjectDirectory() {
    if (selectingDirectory) return;
    setSelectingDirectory(true);
    setError("");
    try {
      const selected = await invoke<string[] | null>("select_project_directory", {
        directory,
        title: tx("选择项目目录"),
      });
      if (selected?.length) {
        setProjectDirectoriesToAdd([...new Set(selected)]);
        setDirectory(selected[0]);
      }
    } catch (reason) {
      setError(tx("无法选择目录：{p0}", { p0: String(reason) }));
    } finally {
      setSelectingDirectory(false);
    }
  }

  async function addProject() {
    if (adding || selectingDirectory) return;
    setAdding(true);
    try {
      const targetWorkspace = currentWorkspace.current?.selectedWorkspace;
      // Validate the whole selection before persisting any project.
      // 保存项目之前先校验全部所选目录，避免部分添加。
      const resolvedDirectories: string[] = [];
      for (const path of projectDirectoriesToAdd.length ? projectDirectoriesToAdd : [directory])
        resolvedDirectories.push(await invoke<string>("project_directory", { directory: path }));
      update((previous) => {
        if (!previous.groups?.some((group) => group.id === targetWorkspace)) return previous;
        const projects = [...previous.projects];
        let selectedProject = previous.selectedProject;
        for (const resolved of new Set(resolvedDirectories)) {
          const existing = projects.find(
            (project) =>
              project.directory === resolved &&
              (project.workspaceId ?? "local") === targetWorkspace,
          );
          if (existing) {
            selectedProject = existing.id;
            continue;
          }
          const id = crypto.randomUUID();
          const name = resolved.split(/[\\/]/).filter(Boolean).at(-1) ?? resolved;
          projects.push({
            id,
            name,
            directory: resolved,
            sessions: [],
            workspaceId: targetWorkspace,
          });
          selectedProject = id;
        }
        return {
          ...switchWorkspace(previous, targetWorkspace ?? "local"),
          projects,
          selectedProject,
          selectedSession: null,
        };
      });
      setShowProjectDialog(false);
    } catch (reason) {
      setError(tx("无法添加项目：{p0}", { p0: String(reason) }));
    } finally {
      setAdding(false);
    }
  }

  async function createWorktree(project: Project) {
    if (creatingWorktree) return;
    setCreatingWorktree(true);
    try {
      const discovered = await invoke<{ path: string; branch: string; missing: boolean }[]>(
        "create_worktree",
        { directory: project.directory },
      );
      update((previous) => reconcileWorktrees(previous, project.id, discovered));
    } catch (reason) {
      setError(tx("无法创建 Worktree：{p0}", { p0: String(reason) }));
    } finally {
      setCreatingWorktree(false);
    }
  }
  async function deleteWorktree(project: Project, worktree: Worktree) {
    if (
      !window.confirm(
        tx("删除 Worktree “{p0}”及其文件夹？未提交或未跟踪的文件会阻止删除。", {
          p0: worktree.name,
        }),
      )
    )
      return;
    setMenu(null);
    try {
      const discovered = await invoke<{ path: string; branch: string; missing: boolean }[]>(
        "delete_worktree",
        { directory: project.directory, path: worktree.path },
      );
      update((previous) => reconcileWorktrees(previous, project.id, discovered));
    } catch (reason) {
      setError(tx("无法删除 Worktree：{p0}", { p0: String(reason) }));
    }
  }
  function addLoose(kind: "terminals" | "chats", agent?: SessionConfig["agent"]) {
    if (!runtime || (kind === "chats" && (!agent || !enabledAgents.includes(agent)))) return;
    const start = () => {
      setZoomedGroup(null);
      update((previous) => {
        const roster = sessionRosters(previous).find(
          (item) => item.workspaceId === previous.selectedWorkspace && item.kind === kind,
        );
        if (!roster) return previous;
        const id = crypto.randomUUID();
        const name =
          kind === "chats" && agent
            ? (runtime.agent_definitions.find((item) => item.id === agent)?.name ??
              agentNames[agent] ??
              agent)
            : tx("终端");
        const session: SessionConfig = {
          id,
          name,
          shell,
          directory: kind === "chats" ? runtime.chat_directory : runtime.home,
          ...(kind === "chats" ? { agent } : {}),
        };
        return selectSession(
          updateRoster(previous, roster.id, (item) => ({
            ...item,
            sessions: [...item.sessions, session],
          })),
          id,
        );
      });
    };
    if (editor.document) void editor.hide(start);
    else start();
  }
  function addSession(
    axis?: SplitAxis,
    target?: { project: string; worktree?: string; agent?: SessionConfig["agent"] },
  ) {
    const start = () => {
      setZoomedGroup(null);
      update((state) => {
        const previous = target ? selectProject(state, target.project, target.worktree) : state;
        const roster = selectedRoster(previous);
        if (!roster) return previous;
        const source = roster.sessions.find((session) => session.id === previous.selectedSession);
        const project = previous.projects.find((project) => project.id === roster.projectId);
        const worktreeId = source?.worktreeId ?? previous.selectedWorktree ?? undefined;
        if (worktreeId && project?.worktrees?.find((item) => item.id === worktreeId)?.missing)
          return previous;
        const id = crypto.randomUUID();
        const agent = target?.agent ?? (roster.kind === "chats" ? source?.agent : undefined);
        const name = agent
          ? (runtime?.agent_definitions.find((item) => item.id === agent)?.name ??
            agentNames[agent] ??
            agent)
          : "Terminal";
        const session: SessionConfig = {
          id,
          name,
          shell,
          ...(agent ? { agent } : {}),
          ...(worktreeId ? { worktreeId } : {}),
          ...(roster.projectId ? {} : { directory: source?.directory, agent: source?.agent }),
        };
        const next = selectSession(
          updateRoster(previous, roster.id, (item) => ({
            ...item,
            sessions: [...item.sessions, session],
          })),
          id,
        );
        return axis && previous.selectedSession
          ? groupSessions(next, id, previous.selectedSession, axis)
          : next;
      });
    };
    if (editor.document) void editor.hide(start);
    else start();
  }

  function saveName() {
    if (!editing || !editing.name.trim()) return;
    const name = editing.name.trim();
    update((previous) => {
      if (editing.kind === "new") {
        const id = crypto.randomUUID();
        return switchWorkspace(
          { ...previous, groups: [...(previous.groups ?? []), createWorkspaceGroup(id, name)] },
          id,
        );
      }
      if (editing.kind === "workspace")
        return {
          ...previous,
          groups: previous.groups?.map((group) =>
            group.id === editing.id ? { ...group, name } : group,
          ),
        };
      if (editing.kind === "session" && editing.project)
        return updateRoster(previous, editing.project, (roster) => ({
          ...roster,
          sessions: roster.sessions.map((session) =>
            session.id === editing.id ? { ...session, name } : session,
          ),
        }));
      if (editing.kind === "worktree")
        return {
          ...previous,
          projects: previous.projects.map((project) => ({
            ...project,
            worktrees: project.worktrees?.map((item) =>
              item.id === editing.id ? { ...item, name } : item,
            ),
          })),
        };
      return {
        ...previous,
        projects: previous.projects.map((project) =>
          editing.kind === "project" && project.id === editing.id
            ? { ...project, name }
            : {
                ...project,
                sessions: project.sessions.map((session) =>
                  editing.kind === "session" && session.id === editing.id
                    ? { ...session, name }
                    : session,
                ),
              },
        ),
      };
    });
    setEditing(null);
  }

  const selected = workspace?.projects.find((project) => project.id === workspace.selectedProject);
  const roster = workspace ? selectedRoster(workspace) : undefined;
  const selectedWorktree = selected?.worktrees?.find(
    (item) => item.id === workspace?.selectedWorktree,
  );
  const selectedSession = roster?.sessions.find(
    (session) => session.id === workspace?.selectedSession,
  );
  const [chatUsageWindows, setChatUsage] = useState<UsageWindow[] | null>(null);
  const [chatUsageDetailsOpen, setChatUsageDetailsOpen] = useState(false);
  const chatUsageDetailsRef = useRef<HTMLDivElement>(null);
  const chatUsage = chatUsageWindows ? remainingUsage(chatUsageWindows) : null;
  useEffect(() => {
    if (!chatUsage) setChatUsageDetailsOpen(false);
  }, [chatUsage]);
  useEffect(() => {
    const agent = quotaAgent(selectedSession?.agent);
    setChatUsageDetailsOpen(false);
    if (!agent) {
      setChatUsage(null);
      return;
    }
    let active = true;
    setChatUsage(null);
    const stop = scheduleUsageRefresh(async () => {
      try {
        const usage = await invoke<{ windows: UsageWindow[] }>("agent_usage", {
          agent,
          remote: true,
        });
        if (active) setChatUsage(usage.windows);
      } catch {
        if (active) setChatUsage(null);
      }
    }, settings.usageRefreshInterval);
    return () => {
      active = false;
      stop();
    };
  }, [selectedSession?.agent, selectedSession?.id, settings.usageRefreshInterval]);
  useEffect(() => {
    if (!chatUsageDetailsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!chatUsageDetailsRef.current?.contains(event.target as Node))
        setChatUsageDetailsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChatUsageDetailsOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [chatUsageDetailsOpen]);
  const fileDirectory =
    selectedWorktree?.path ??
    selected?.directory ??
    roster?.sessions.find((session) => session.id === workspace?.selectedSession)?.directory ??
    runtime?.home ??
    "";
  useEffect(() => {
    if (!editor.document) setFocusRequest((value) => value + 1);
  }, [editor.document?.id]);
  const activeGroup =
    roster && workspace?.selectedSession
      ? splitGroup(roster, workspace.selectedSession)
      : undefined;
  const activeGroupId = activeGroup?.kind === "split" ? activeGroup.id : null;
  const zoomed = activeGroupId !== null && activeGroupId === zoomedGroup;
  useEffect(() => {
    if (githubOpen && !selected) {
      setGithubOpen(false);
      setDirectoryOpen(false);
      setFilesOpen(true);
    }
  }, [githubOpen, selected]);
  function toggleZoom() {
    if (activeGroupId) setZoomedGroup(zoomed ? null : activeGroupId);
  }
  useEffect(() => {
    setZoomedGroup(null);
  }, [workspace?.selectedProject, workspace?.selectedWorkspace, activeGroupId]);
  function commandAvailable(id: CommandId): boolean {
    if (!runtime || !workspace || editor.transitioning || editor.pending) return false;
    if (id === "next" || id === "previous")
      return (
        !editor.document && sessionRosters(workspace).some((roster) => roster.sessions.length > 0)
      );
    if (["splitRight", "splitDown", "terminalSearch"].includes(id))
      return !!workspace.selectedSession && !editor.document;
    if (["zoom", "ungroup", "left", "right", "up", "down"].includes(id))
      return !!activeGroup && !editor.document;
    if (id === "close") return !!editor.document || !!nextSessionToClose(workspace);
    if (id === "link") return !!workspace.selectedSession && !editor.document;
    if (id === "github") return !!selected;
    if (id === "toggleInspector") return !!fileDirectory;
    if (id === "swapPanes")
      return (
        inspectorVisible &&
        !(gitOpen && gitExpanded && gitDiffActive) &&
        !resizingInspector &&
        !resizingSidebar
      );
    if (id === "chat") return !!chatAgent;
    return true;
  }
  function runCommand(id: CommandId) {
    if (!commandAvailable(id)) return;
    if (id === "palette") setPaletteOpen(true);
    else if (id === "toggleSidebar") setSidebarVisible((value) => !value);
    else if (id === "toggleInspector") toggleInspector();
    else if (id === "swapPanes") swapPanes();
    else if (id === "settings") setSettingsOpen(true);
    else if (id === "project") openProjectDialog();
    else if (id === "terminal") {
      if (roster) addSession();
      else addLoose("terminals");
    } else if (id === "chat") {
      // Project chats inherit the selected project/worktree directory through its roster.
      // 项目聊天通过所属会话集合继承当前项目或 Worktree 的工作目录。
      if (selected)
        addSession(undefined, {
          project: selected.id,
          worktree: selectedWorktree?.id,
          agent: chatAgent,
        });
      else addLoose("chats", chatAgent);
    } else if (id === "agents") setAgentOpen(true);
    else if (id === "files") {
      setGithubOpen(false);
      setDirectoryOpen(false);
      setGitOpen(false);
      setFilesOpen((value) => !value);
    } else if (id === "github") {
      setDirectoryOpen(false);
      setFilesOpen(false);
      setGitOpen(false);
      setGithubOpen((value) => !value);
    } else if (id === "git") {
      setGithubOpen(false);
      setDirectoryOpen(false);
      setFilesOpen(false);
      setGitOpen((value) => !value);
    } else if (id === "quick" || id === "search") {
      setGithubOpen(false);
      setDirectoryOpen(false);
      setGitOpen(false);
      setFilesOpen(true);
      setFileMode(id);
      setFileRequest((value) => value + 1);
    } else if (id === "splitRight" || id === "splitDown")
      addSession(id === "splitRight" ? "horizontal" : "vertical");
    else if (id === "zoom") toggleZoom();
    else if (id === "ungroup" && workspace?.selectedSession)
      update((previous) => ungroupSession(previous, previous.selectedSession ?? ""));
    else if (["left", "right", "up", "down"].includes(id) && activeGroup) {
      const neighbor = neighborPane(
        activeGroup,
        workspace?.selectedSession ?? "",
        id as PaneDirection,
      );
      if (neighbor) update((previous) => selectSession(previous, neighbor));
    } else if ((id === "next" || id === "previous") && workspace) {
      update((previous) => cycleSession(previous, id === "next" ? 1 : -1));
    } else if (id === "terminalSearch") window.dispatchEvent(new Event("uterm-search"));
    else if (id === "close" && editor.document) void editor.close();
    else if (id === "close" && workspace) {
      const target = nextSessionToClose(workspace);
      if (target) {
        const targetRoster = sessionRosters(workspace).find((item) =>
          item.sessions.some((session) => session.id === target),
        );
        if (targetRoster)
          update((previous) =>
            selectSession(switchWorkspace(previous, targetRoster.workspaceId), target),
          );
        setCloseRequest((previous) => ({
          id: target,
          sequence: (previous?.sequence ?? 0) + 1,
        }));
      }
    } else if (id === "link" && workspace?.selectedSession)
      void navigator.clipboard
        .writeText(sessionLink(workspace.selectedSession))
        .catch((reason) => setError(String(reason)));
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.repeat ||
        document.querySelector("dialog[open], .branch-menu") ||
        menu ||
        !runtime
      )
        return;
      const key = chord(event, runtime.platform === "macos");
      if (!key) return;
      const command = commands.find(
        ([id]) => binding(settings, id, runtime.platform === "macos") === key,
      );
      if (command && commandAvailable(command[0])) {
        event.preventDefault();
        event.stopImmediatePropagation();
        runCommand(command[0]);
      }
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  });
  async function handleControl(method: string, params: Record<string, unknown>) {
    const state = currentWorkspace.current;
    if (!state || !runtime) throw new Error(tx("工作区尚未加载。"));
    const entries = sessionEntries(state);
    if (method === "status")
      return {
        version: runtime.version,
        selectedSession: state.selectedSession,
        sessions: entries.length,
      };
    if (method === "projects.list")
      return state.projects.map(({ id, name, directory, workspaceId }) => ({
        id,
        name,
        directory,
        workspaceId,
      }));
    if (method === "sessions.list")
      return entries.map(({ session, directory }) => ({
        ...session,
        directory,
        state: agentStateValues.current[session.id] ?? null,
        link: sessionLink(session.id),
      }));
    if (document.querySelector("dialog[open]") || editor.transitioning || editor.pending)
      throw new Error(tx("请先完成应用中的对话框或文件操作。"));
    const id = method === "open" ? sessionFromLink(String(params.url)) : String(params.id ?? "");
    if (["sessions.focus", "open", "sessions.new"].includes(method)) {
      if (isDirty(editor.document))
        throw new Error(tx("编辑器有未保存的修改，请先保存或关闭文件。"));
      if (editor.document) await editor.hide();
    }
    if (method === "sessions.new") {
      if (typeof params.directory !== "string" || params.directory.length > 4096)
        throw new Error(tx("需要有效的绝对目录路径。"));
      if (
        params.agent !== undefined &&
        (typeof params.agent !== "string" || !runtime.agents.includes(params.agent))
      )
        throw new Error(tx("Agent 不可用。"));
      const directory = await invoke<string>("project_directory", { directory: params.directory });
      const session: SessionConfig = {
        id: crypto.randomUUID(),
        name: params.agent ? String(params.agent) : "Terminal",
        directory,
        shell: settings.defaultShell,
        ...(params.agent ? { agent: String(params.agent) } : {}),
      };
      const project = state.projects.find((item) => item.directory === directory);
      const target = project
        ? sessionRosters(state).find((item) => item.projectId === project.id)
        : sessionRosters(state).find(
            (item) =>
              item.workspaceId === state.selectedWorkspace &&
              item.kind === (params.agent ? "chats" : "terminals"),
          );
      if (!target) throw new Error(tx("找不到目标工作区。"));
      update((previous) =>
        selectSession(
          updateRoster(switchWorkspace(previous, target.workspaceId), target.id, (item) => ({
            ...item,
            sessions: [...item.sessions, session],
          })),
          session.id,
        ),
      );
      if (
        !currentWorkspace.current ||
        !sessionEntries(currentWorkspace.current).some((item) => item.session.id === session.id)
      )
        throw new Error(tx("会话配置未保存。"));
      return { id: session.id, link: sessionLink(session.id), status: "created" };
    }
    if (!entries.some((item) => item.session.id === id))
      throw new Error(tx("找不到此会话；链接可能属于其他安装版本。"));
    if (method === "sessions.focus" || method === "open") {
      const roster = sessionRosters(state).find((item) =>
        item.sessions.some((session) => session.id === id),
      );
      if (!roster) throw new Error(tx("会话所属工作区不存在。"));
      update((previous) => selectSession(switchWorkspace(previous, roster.workspaceId), id));
      setFocusRequest((value) => value + 1);
      await invoke("control_focus");
    } else if (method === "sessions.send" || method === "sessions.close") {
      if (
        method === "sessions.send" &&
        (typeof params.text !== "string" || new TextEncoder().encode(params.text).length > 65536)
      )
        throw new Error(tx("输入应为不超过 64 KB 的文本。"));
      await invoke("control_session", {
        id,
        action: method === "sessions.send" ? "send" : "close",
        text: params.text ?? null,
      });
      if (method === "sessions.close") update((previous) => removeSession(previous, id));
    } else throw new Error(tx("未知控制操作。"));
    return { id };
  }
  const controlHandler = useRef(handleControl);
  controlHandler.current = handleControl;
  useEffect(() => {
    if (!runtime || !workspace) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const request = await invoke<{
          id: string;
          method: string;
          params: Record<string, unknown>;
        } | null>("control_poll");
        if (request && !disposed) {
          let result;
          try {
            result = { result: await controlHandler.current(request.method, request.params ?? {}) };
          } catch (reason) {
            result = { error: String(reason) };
            setError(String(reason));
          }
          await invoke("control_reply", { id: request.id, result });
        }
      } catch (reason) {
        if (!disposed) setError(tx("本地控制：{p0}", { p0: String(reason) }));
      }
      if (!disposed) timer = setTimeout(() => void poll(), 250);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [!!runtime, !!workspace]);
  const menuProject = workspace?.projects.find((project) => project.id === menu?.project);
  const menuRoster = workspace
    ? sessionRosters(workspace).find((roster) => roster.id === menu?.project)
    : undefined;
  const menuItem =
    menu?.kind === "project"
      ? menuProject
      : menu?.kind === "worktree"
        ? menuProject?.worktrees?.find((item) => item.id === menu.id)
        : menuRoster?.sessions.find((session) => session.id === menu?.id);
  const menuWorktree =
    menu?.kind === "worktree"
      ? menuProject?.worktrees?.find((worktree) => worktree.id === menu.id)
      : undefined;
  const menuDirectory = menu?.kind === "project" ? menuProject?.directory : menuWorktree?.path;
  const menuWorktreeHasSessions =
    !!menuWorktree &&
    menuProject?.sessions.some((session) => session.worktreeId === menuWorktree.id);
  function editMenuItem(
    change: (item: { name: string; pinned?: boolean }) => { name: string; pinned?: boolean },
  ) {
    if (!menu) return;
    update((previous) => {
      if (menu.kind === "session")
        return updateRoster(previous, menu.project, (roster) => ({
          ...roster,
          sessions: roster.sessions.map((session) =>
            session.id === menu.id ? { ...session, ...change(session) } : session,
          ),
        }));
      return {
        ...previous,
        projects: previous.projects.map((project) =>
          project.id !== menu.project
            ? project
            : menu.kind === "project"
              ? { ...project, ...change(project) }
              : {
                  ...project,
                  worktrees: project.worktrees?.map((item) =>
                    item.id === menu.id ? { ...item, ...change(item) } : item,
                  ),
                },
        ),
      };
    });
    setMenu(null);
  }
  function moveMenuItem(direction: -1 | 1) {
    if (!menu) return;
    update((previous) => {
      if (menu.kind === "session")
        return updateRoster(previous, menu.project, (roster) => {
          const worktree = roster.sessions.find((session) => session.id === menu.id)?.worktreeId;
          const peers = reorder(
            roster.sessions.filter((session) => session.worktreeId === worktree),
            menu.id,
            direction,
          );
          let index = 0;
          return {
            ...roster,
            sessions: roster.sessions.map((session) =>
              session.worktreeId === worktree ? peers[index++] : session,
            ),
          };
        });
      if (menu.kind === "worktree")
        return {
          ...previous,
          projects: previous.projects.map((project) =>
            project.id === menu.project
              ? { ...project, worktrees: reorder(project.worktrees ?? [], menu.id, direction) }
              : project,
          ),
        };
      const peers = reorder(
        previous.projects.filter((project) => project.workspaceId === previous.selectedWorkspace),
        menu.id,
        direction,
      );
      let index = 0;
      return {
        ...previous,
        projects: previous.projects.map((project) =>
          project.workspaceId === previous.selectedWorkspace ? peers[index++] : project,
        ),
      };
    });
    setMenu(null);
  }
  const inspectorVisible = hasInspectorContent(fileDirectory, !!selected, {
    files: filesOpen,
    directory: directoryOpen,
    git: gitOpen,
    github: githubOpen,
  });
  useEffect(() => {
    if (!sidebarCollapseHint) return;
    if (sidebarVisible) {
      setSidebarCollapseHint(false);
      return;
    }
    const timer = window.setTimeout(() => setSidebarCollapseHint(false), 3000);
    return () => window.clearTimeout(timer);
  }, [sidebarCollapseHint, sidebarVisible]);
  useEffect(() => {
    if (!inspectorCollapseHint) return;
    if (inspectorVisible) {
      setInspectorCollapseHint(false);
      return;
    }
    const timer = window.setTimeout(() => setInspectorCollapseHint(false), 3000);
    return () => window.clearTimeout(timer);
  }, [inspectorCollapseHint, inspectorVisible]);
  function swapPanes() {
    if (!commandAvailable("swapPanes")) return;
    try {
      saveSettings(
        { ...settings, inspectorPosition: inspectorOnLeft ? "right" : "left" },
        runtime?.platform === "macos",
      );
    } catch (reason) {
      setError(tx("无法保存窗格位置：{p0}", { p0: String(reason) }));
    }
  }
  function toggleInspector() {
    if (inspectorVisible) {
      lastInspector.current = directoryOpen
        ? "directory"
        : githubOpen
          ? "github"
          : gitOpen
            ? "git"
            : "files";
      setFilesOpen(false);
      setGitOpen(false);
      setGithubOpen(false);
      setDirectoryOpen(false);
    } else {
      const panel =
        ["github", "git"].includes(lastInspector.current) && !selected
          ? "files"
          : lastInspector.current;
      setFilesOpen(panel === "files");
      setGitOpen(panel === "git");
      setGithubOpen(panel === "github");
      setDirectoryOpen(panel === "directory");
    }
  }
  const inspectorToggle = (
    <button
      className="toolbar-icon-button inspector-toggle"
      data-collapse-hint={(!inspectorVisible && inspectorCollapseHint) || undefined}
      aria-label={inspectorVisible ? tx("隐藏工具面板") : tx("显示工具面板")}
      title={inspectorVisible ? tx("隐藏工具面板") : tx("显示工具面板")}
      aria-expanded={inspectorVisible}
      disabled={!runtime || !fileDirectory}
      onClick={toggleInspector}
    >
      <SidebarIcon name={inspectorOnLeft ? "sidebar" : "sidebarRight"} />
    </button>
  );
  const inspectorActions = (
    <div className="inspector-switcher" role="group" aria-label={tx("工具面板")}>
      <button
        className="toolbar-icon-button"
        aria-label={tx("文件")}
        aria-pressed={filesOpen}
        disabled={!runtime || !fileDirectory}
        onClick={() => {
          setGithubOpen(false);
          setDirectoryOpen(false);
          setGitOpen(false);
          setFilesOpen(true);
        }}
        title={tx("文件")}
      >
        <ToolbarIcon name="files" />
      </button>
      <button
        className="toolbar-icon-button"
        aria-label="Git"
        aria-pressed={gitOpen}
        disabled={!selected && !roster}
        onClick={() => {
          setGithubOpen(false);
          setDirectoryOpen(false);
          setFilesOpen(false);
          setGitOpen(true);
        }}
        title="Git"
      >
        <ToolbarIcon name="git" />
      </button>
      <button
        className="toolbar-icon-button"
        aria-label="GitHub"
        disabled={!selected}
        aria-pressed={githubOpen}
        onClick={() => {
          setFilesOpen(false);
          setGitOpen(false);
          setDirectoryOpen(false);
          setGithubOpen(true);
        }}
        title="GitHub"
      >
        <ToolbarIcon name="github" />
      </button>
      <button
        className="toolbar-icon-button"
        aria-label={tx("工作目录")}
        title={tx("工作目录")}
        aria-pressed={directoryOpen}
        disabled={!runtime || !fileDirectory}
        onClick={() => {
          setFilesOpen(false);
          setGitOpen(false);
          setGithubOpen(false);
          setDirectoryOpen(true);
        }}
      >
        <ToolbarIcon name="info" />
      </button>
    </div>
  );
  return (
    <div
      ref={shellElement}
      style={
        {
          "--inspector-width": `${inspectorSize.width}px`,
          "--sidebar-width": `${sidebarWidth}px`,
          "--inspector-boundary": `${sidebarWidth + (inspectorOnLeft ? inspectorSize.width : Math.max(320, shellWidth - sidebarWidth - inspectorSize.width))}px`,
        } as CSSProperties
      }
      data-inspector-position={settings.inspectorPosition}
      data-resizing-inspector={resizingInspector || undefined}
      data-resizing-sidebar={resizingSidebar || undefined}
      data-sidebar-snap={sidebarSnap || undefined}
      data-inspector-snap={inspectorSnap || undefined}
      data-expanded-inspector={
        (inspectorVisible && gitOpen && gitExpanded && gitDiffActive) || undefined
      }
      className={`app-shell${sidebarVisible ? "" : " sidebar-hidden"}${runtime?.platform === "macos" ? " platform-macos" : ""}${inspectorVisible ? " with-inspector" : ""}${inspectorVisible && (filesOpen || directoryOpen) ? " with-files" : ""}`}
    >
      <BreakReminder />
      <Sidebar
        resizeHandle={sidebarResizeHandle}
        closeSession={(id) =>
          setCloseRequest((previous) => ({ id, sequence: (previous?.sequence ?? 0) + 1 }))
        }
        visible={sidebarVisible}
        toggleVisibility={() => {
          setMenu(null);
          setSidebarVisible((value) => !value);
        }}
        workspace={workspace}
        runtime={runtime}
        update={update}
        focus={() => {
          if (editor.document) void editor.hide();
          else setFocusRequest((value) => value + 1);
        }}
        menu={setMenu}
        addProject={openProjectDialog}
        newWorkspace={() => setEditing({ kind: "new", id: "", name: "" })}
        renameWorkspace={() =>
          setEditing({
            kind: "workspace",
            id: workspace?.selectedWorkspace ?? "",
            name:
              workspace?.groups?.find((group) => group.id === workspace.selectedWorkspace)?.name ??
              "",
          })
        }
        footerActions={
          <div className="sidebar-footer-actions">
            <button
              className="toolbar-icon-button"
              aria-label={tx("命令")}
              disabled={!runtime}
              onClick={() => setPaletteOpen(true)}
              title={tx("命令")}
            >
              <ToolbarIcon name="command" />
            </button>
            <button
              className="toolbar-icon-button"
              aria-label={tx("设置")}
              disabled={!runtime}
              onClick={() => setSettingsOpen(true)}
              title={tx("设置")}
            >
              <ToolbarIcon name="settings" />
            </button>
            <button
              className="toolbar-icon-button"
              aria-label="Agent"
              disabled={!runtime}
              aria-haspopup="dialog"
              onClick={() => setAgentOpen(true)}
              title="Agent"
            >
              <ToolbarIcon name="agent" />
            </button>
          </div>
        }
        agentStates={agentStates}
        detectedAgents={detectedAgents}
        unreadCompletedSessions={unreadCompletedSessions}
        onSessionViewed={acknowledgeCompletedSession}
        activityDisabled={editor.transitioning || editor.pending}
        onActivitySession={(id) => {
          if (!editor.transitioning && !editor.pending) revealTaskbarSession(id);
        }}
        addLoose={addLoose}
        addSession={(project, worktree, agent) =>
          addSession(undefined, { project, worktree, agent })
        }
      />
      {inspectorVisible && !(gitOpen && gitExpanded && gitDiffActive) && (
        <button
          className="pane-swap-button toolbar-icon-button"
          title={tx("交换左右窗格")}
          aria-label={tx("交换左右窗格")}
          aria-pressed={inspectorOnLeft}
          disabled={!commandAvailable("swapPanes")}
          onPointerDown={(event) => {
            if (event.button === 0) event.preventDefault();
          }}
          onClick={swapPanes}
        >
          <ToolbarIcon name="swap" />
        </button>
      )}
      <main>
        <header className="toolbar" data-tauri-drag-region>
          <div className="workspace-heading" data-tauri-drag-region>
            {!sidebarVisible && (
              <button
                className="sidebar-reopen"
                data-collapse-hint={sidebarCollapseHint || undefined}
                aria-label={tx("显示侧栏")}
                title={tx("显示侧栏")}
                aria-expanded={false}
                aria-controls="workspace-sidebar"
                onClick={() => setSidebarVisible(true)}
              >
                <SidebarIcon name="sidebar" />
              </button>
            )}
            {inspectorOnLeft && inspectorToggle}
            <h1 data-tauri-drag-region>
              {selectedWorktree
                ? `${selected?.name} / ${selectedWorktree.name}`
                : (selected?.name ?? (roster?.kind === "chats" ? tx("聊天") : tx("终端")))}
            </h1>
            {runtime && fileDirectory && (
              <BranchSelector
                key={fileDirectory}
                directory={fileDirectory}
                disabled={editor.transitioning || editor.pending}
                beforeSwitch={(action) => void editor.closeDirectory(fileDirectory, action)}
                onChanged={() => setRepositoryRevision((value) => value + 1)}
                onError={setError}
              />
            )}
          </div>
          <div className="toolbar-actions">
            {roster && (
              <div className="workspace-actions">
                {chatUsage && (
                  <div className="chat-usage-control" ref={chatUsageDetailsRef}>
                    <button
                      type="button"
                      className="chat-usage"
                      title={chatUsage.title}
                      aria-expanded={chatUsageDetailsOpen}
                      aria-controls="chat-usage-details"
                      onClick={() => setChatUsageDetailsOpen((value) => !value)}
                    >
                      {tx("剩余 {p0}%", { p0: chatUsage.percent })}
                    </button>
                    {chatUsageDetailsOpen && (
                      <div
                        className="chat-usage-popover"
                        id="chat-usage-details"
                        role="region"
                        aria-label={tx("{p0} 用量详情", {
                          p0:
                            agentNames[quotaAgent(selectedSession?.agent) ?? ""] ??
                            selectedSession?.agent ??
                            "Agent",
                        })}
                      >
                        <strong>
                          {tx("{p0} 用量详情", {
                            p0:
                              agentNames[quotaAgent(selectedSession?.agent) ?? ""] ??
                              selectedSession?.agent ??
                              "Agent",
                          })}
                        </strong>
                        {chatUsage.windows.map((window, index) => (
                          <div className="chat-usage-window" key={`${window.label}-${index}`}>
                            <span>
                              {window.seconds
                                ? tx("{p0} 小时", { p0: window.seconds / 3600 })
                                : localizeMessage(window.label)}
                            </span>
                            <b>{tx("剩余 {p0}%", { p0: window.percent })}</b>
                            <progress max="100" value={window.percent} />
                            {window.resetsAt && (
                              <small>
                                {tx("重置于 {p0}", {
                                  p0: new Date(
                                    typeof window.resetsAt === "number"
                                      ? window.resetsAt * 1000
                                      : window.resetsAt,
                                  ).toLocaleString(getUiLanguage()),
                                })}
                              </small>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {runtime?.platform === "windows" && (
                  <select
                    aria-label={tx("新会话 Shell")}
                    value={shell}
                    onChange={(event) => setShell(event.target.value as "default" | "cmd")}
                  >
                    <option value="default">PowerShell</option>
                    <option value="cmd">{tx("命令提示符")}</option>
                  </select>
                )}
                {workspace?.selectedSession && activeGroup && (
                  <button
                    className="toolbar-icon-button"
                    onClick={toggleZoom}
                    aria-label={zoomed ? tx("还原窗格") : tx("放大窗格")}
                    title={zoomed ? tx("还原窗格") : tx("放大窗格")}
                  >
                    <ToolbarIcon name={zoomed ? "restore" : "maximize"} />
                  </button>
                )}
              </div>
            )}
            {!inspectorOnLeft && inspectorToggle}
          </div>
        </header>
        {updates.available?.version && ["available", "ready"].includes(updates.phase) && (
          <div role="status" className="editor-notice">
            {tx("新版本 uTerm {p0} 可用。", { p0: updates.available.version })}
            <button onClick={() => setSettingsOpen(true)}>{tx("前往设置更新")}</button>
          </div>
        )}
        {(error || sessionSyncError) && (
          <TransientError key={error || sessionSyncError} message={error || sessionSyncError} />
        )}
        {!workspace && error && <button onClick={() => void load()}>{tx("重试读取")}</button>}
        <WorkspaceTabs
          sessions={roster?.sessions ?? []}
          documents={editor.documents.filter((item) => item.directory === fileDirectory)}
          activeFile={editor.document?.id ?? null}
          activeSession={workspace?.selectedSession ?? null}
          detectedAgents={detectedAgents}
          disabled={editor.transitioning || editor.pending}
          selectSession={revealTaskbarSession}
          selectFile={(file) => void editor.open(file.directory, file.path)}
          diff={
            gitOpen && gitExpanded && gitDiffPath
              ? { path: gitDiffPath, active: gitDiffActive }
              : undefined
          }
          selectDiff={() => void editor.hide(() => setGitDiffActive(true))}
          closeDiff={() => changeGitExpanded(false)}
          closeFile={(id) => void editor.close(undefined, id)}
        />
        <div
          className="terminal-container"
          id="workspace-content"
          role="tabpanel"
          aria-labelledby={
            gitOpen && gitExpanded && gitDiffActive
              ? "workspace-git-diff"
              : editor.document
                ? `workspace-file-${editor.document.id}`
                : workspace?.selectedSession
                  ? `workspace-session-${workspace.selectedSession}`
                  : undefined
          }
        >
          <div
            inert={!!editor.document || (gitOpen && gitExpanded && gitDiffActive)}
            className={
              editor.document || (gitOpen && gitExpanded && gitDiffActive)
                ? "terminal-behind-editor"
                : undefined
            }
          >
            {!workspace?.selectedSession && (
              <section className="welcome" aria-label={t("开始工作")}>
                <div className="welcome-content">
                  <div className="welcome-eyebrow">uTerm / {tx("工作区")}</div>
                  <h2>{selected ? selected.name : t("专注于下一行。")}</h2>
                  <p className="welcome-description">
                    {!isDesktop()
                      ? t("请在桌面应用中管理项目和会话。")
                      : !workspace
                        ? t("正在读取工作区。")
                        : t("项目、终端与 Agent，在一个工作空间中。")}
                  </p>
                  <div className="welcome-actions">
                    <button
                      className="welcome-action primary"
                      disabled={!runtime || !workspace}
                      onClick={selected ? () => addSession() : openProjectDialog}
                    >
                      <SidebarIcon name={selected ? "terminal" : "folder"} />
                      <span>
                        <strong>{selected ? tx("新建终端") : tx("打开项目")}</strong>
                        <small>
                          {selected
                            ? tx("在当前项目中启动 Shell。")
                            : tx("选择目录，开始你的工作。")}
                        </small>
                      </span>
                      <kbd>
                        {shortcutLabel(
                          binding(
                            settings,
                            selected ? "terminal" : "project",
                            runtime?.platform === "macos",
                          ),
                          runtime?.platform === "macos",
                        )}
                      </kbd>
                    </button>
                    <button
                      className="welcome-action"
                      disabled={!commandAvailable("chat")}
                      onClick={() => runCommand("chat")}
                    >
                      <ToolbarIcon name="agent" />
                      <span>
                        <strong>{t("新建聊天")}</strong>
                        <small>{t("与本地 Agent 一起处理任务。")}</small>
                      </span>
                      <kbd>
                        {shortcutLabel(
                          binding(settings, "chat", runtime?.platform === "macos"),
                          runtime?.platform === "macos",
                        )}
                      </kbd>
                    </button>
                    {!selected && (
                      <button
                        className="welcome-action"
                        disabled={!runtime || !workspace}
                        onClick={() => addLoose("terminals")}
                      >
                        <SidebarIcon name="terminal" />
                        <span>
                          <strong>{t("新建终端")}</strong>
                          <small>{t("无需项目，直接打开 Shell。")}</small>
                        </span>
                        <kbd>
                          {shortcutLabel(
                            binding(settings, "terminal", runtime?.platform === "macos"),
                            runtime?.platform === "macos",
                          )}
                        </kbd>
                      </button>
                    )}
                  </div>
                  <div className="welcome-footer">
                    <span>{t("本地运行 · 自由掌控")}</span>
                    <button disabled={!runtime} onClick={() => setPaletteOpen(true)}>
                      {t("所有命令")} ↗
                    </button>
                  </div>
                </div>
              </section>
            )}
            {runtime && workspace && (
              <TerminalWorkspace
                agentStates={agentStates}
                onSessionViewed={acknowledgeCompletedSession}
                onDetectedAgent={(id, agent) => {
                  setDetectedAgents((previous) => {
                    if (previous[id] === agent || (!agent && !(id in previous))) return previous;
                    if (!agent) {
                      const next = { ...previous };
                      delete next[id];
                      return next;
                    }
                    return { ...previous, [id]: agent };
                  });
                }}
                workspace={workspace}
                zoomed={zoomed}
                focusRequest={focusRequest}
                closeRequest={closeRequest}
                update={update}
                onAgentState={(id, state, initial) => {
                  if (agentStateValues.current[id] === state) return;
                  agentStateValues.current = { ...agentStateValues.current, [id]: state };
                  setAgentStates(agentStateValues.current);
                  const selectedSession = currentWorkspace.current?.selectedSession;
                  if (state === "done" && selectedSession !== id) {
                    setUnreadCompletedSessions((previous) => new Set(previous).add(id));
                  } else if (state !== "done") {
                    setUnreadCompletedSessions((previous) => {
                      if (!previous.has(id)) return previous;
                      const next = new Set(previous);
                      next.delete(id);
                      return next;
                    });
                  }
                  if (state === "done" && selectedSession === id) acknowledgeCompletedSession(id);
                  if (
                    !initial &&
                    !runtime.debug &&
                    ["waiting", "done"].includes(state) &&
                    localStorage.getItem(notificationKey) === "true" &&
                    (!document.hasFocus() || workspace.selectedSession !== id)
                  ) {
                    const name =
                      sessionEntries(workspace).find((entry) => entry.session.id === id)?.session
                        .name ?? "Agent";
                    void isPermissionGranted()
                      .then((granted) => {
                        if (granted)
                          sendNotification({
                            title: name,
                            body: state === "waiting" ? tx("需要你处理") : tx("任务已完成"),
                          });
                      })
                      .catch((reason) => setError(String(reason)));
                  }
                }}
                onClosed={(id) => {
                  delete agentStateValues.current[id];
                  setAgentStates({ ...agentStateValues.current });
                  setUnreadCompletedSessions((previous) => {
                    if (!previous.has(id)) return previous;
                    const next = new Set(previous);
                    next.delete(id);
                    return next;
                  });
                  setDetectedAgents((previous) => {
                    const next = { ...previous };
                    delete next[id];
                    return next;
                  });
                  update((previous) => removeSession(previous, id));
                }}
              />
            )}
          </div>
          <div
            inert={gitOpen && gitExpanded && gitDiffActive}
            hidden={gitOpen && gitExpanded && gitDiffActive}
          >
            <DeferredFileEditor editor={editor} />
          </div>
          <div
            ref={setGitDiffTarget}
            className="git-main-diff"
            hidden={!gitOpen || !gitExpanded || !gitDiffActive}
          />
          {!editor.document && editor.error && (
            <div className="file-open-error" role="alert">
              {localizeMessage(editor.error)}
              <button onClick={editor.dismissError}>{tx("关闭")}</button>
            </div>
          )}
          {!editor.document && editor.transitioning && (
            <p className="file-open-error" role="status">
              {tx("正在打开文件…")}
            </p>
          )}
        </div>
      </main>
      {directoryOpen && fileDirectory && (
        <DirectoryPanel
          key={fileDirectory}
          directory={fileDirectory}
          platform={runtime?.platform ?? ""}
          resizeHandle={resizeHandle}
          headerActions={inspectorActions}
        />
      )}
      {filesOpen && fileDirectory && (
        <FilePanel
          resizeHandle={resizeHandle}
          headerActions={inspectorActions}
          key={`${fileDirectory}:${repositoryRevision}`}
          directory={fileDirectory}
          mode={fileMode}
          request={fileRequest}
          setMode={setFileMode}
          open={(path, line) => void editor.open(fileDirectory, path, line)}
          beforeMutation={(action) => void editor.closeDirectory(fileDirectory, action)}
        />
      )}
      {githubOpen && selected && (
        <GitHubPanel
          resizeHandle={resizeHandle}
          headerActions={inspectorActions}
          key={`${fileDirectory}:${repositoryRevision}`}
          directory={fileDirectory}
          canAssociate={!!workspace?.selectedSession}
          canInsert={
            !!roster?.sessions.find((item) => item.id === workspace?.selectedSession)?.agent
          }
          associate={(item) => {
            if (workspace?.selectedSession)
              update((previous) =>
                updateRoster(previous, roster?.id ?? "", (value) => ({
                  ...value,
                  sessions: value.sessions.map((session) =>
                    session.id === workspace.selectedSession
                      ? { ...session, issue: { url: item.url, title: item.title } }
                      : session,
                  ),
                })),
              );
          }}
          insert={async (url) => {
            const id = currentWorkspace.current?.selectedSession;
            if (!id) throw new Error(tx("请先选择 Agent 会话。"));
            await invoke("control_session", { id, action: "send", text: url });
          }}
          createSession={(item) => {
            const start = () => {
              const id = crypto.randomUUID();
              update((previous) => {
                const target = selectedRoster(previous);
                if (!target) return previous;
                return selectSession(
                  updateRoster(previous, target.id, (value) => ({
                    ...value,
                    sessions: [
                      ...value.sessions,
                      {
                        id,
                        name: `#${item.number} ${item.title}`.slice(0, 100),
                        shell,
                        ...(chatAgent ? { agent: chatAgent } : {}),
                        ...(previous.selectedWorktree
                          ? { worktreeId: previous.selectedWorktree }
                          : {}),
                        issue: { url: item.url, title: item.title },
                      },
                    ],
                  })),
                  id,
                );
              });
            };
            if (editor.document) void editor.hide(start);
            else start();
          }}
        />
      )}
      {paletteOpen && runtime && (
        <CommandPalette
          mac={runtime.platform === "macos"}
          available={commandAvailable}
          run={runCommand}
          close={() => setPaletteOpen(false)}
        />
      )}
      {updates.confirmation !== null && <UpdateInstallDialog updates={updates} />}
      {settingsOpen && runtime && (
        <SettingsPanel
          runtime={runtime}
          updates={updates}
          close={() => setSettingsOpen(false)}
          reloadAgents={async () => setRuntime(await getRuntimeInfo())}
          workspace={workspace}
          updateWorkspace={update}
        />
      )}
      {gitOpen && workspace && (
        <GitPanel
          resizeHandle={resizeHandle}
          diffTarget={gitDiffTarget}
          expanded={gitExpanded}
          onExpandedChange={changeGitExpanded}
          onDiffPathChange={setGitDiffPath}
          headerActions={inspectorActions}
          key={`${fileDirectory}:${repositoryRevision}`}
          directory={fileDirectory}
        />
      )}
      {menu && menuItem && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={tx("侧栏操作")}
          className="context-menu"
          style={{
            left: Math.max(0, Math.min(menu.x, window.innerWidth - 220)),
            top: Math.max(0, Math.min(menu.y, window.innerHeight - 320)),
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              setMenu(null);
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
            ).filter((button) => button.closest('[role="menu"]') === event.currentTarget);
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
          <button
            role="menuitem"
            onClick={() => {
              setEditing({
                kind: menu.kind,
                id: menu.id,
                name: menuItem.name,
                project: menu.project,
              });
              setMenu(null);
            }}
          >
            {tx("重命名")}
          </button>
          <button
            role="menuitem"
            onClick={() => editMenuItem((item) => ({ ...item, pinned: !item.pinned }))}
          >
            {menuItem.pinned ? tx("取消置顶") : tx("置顶")}
          </button>
          {menu.kind !== "project" && (
            <>
              <button role="menuitem" onClick={() => moveMenuItem(-1)}>
                {tx("上移")}
              </button>
              <button role="menuitem" onClick={() => moveMenuItem(1)}>
                {tx("下移")}
              </button>
            </>
          )}
          {menuDirectory && (
            <button
              role="menuitem"
              disabled={menuWorktree?.missing}
              onClick={() => {
                const directory = menuDirectory;
                setMenu(null);
                void invoke("directory_open", { directory, target: "reveal" }).catch((reason) =>
                  setError(String(reason)),
                );
              }}
            >
              {tx("在文件管理器中打开")}
            </button>
          )}
          {menu.kind === "project" && menuProject && (
            <button
              role="menuitem"
              disabled={menuProject.sessions.length > 0}
              title={
                menuProject.sessions.length
                  ? tx("请先关闭项目中的所有会话")
                  : tx("从列表移除，保留本地文件")
              }
              onClick={() => {
                const id = menu.id;
                setMenu(null);
                const remove = () => update((previous) => removeProject(previous, id));
                void editor.closeDirectory(menuProject.directory, remove);
              }}
            >
              {tx("移除项目")}
            </button>
          )}
          {menu.kind === "session" && menuRoster && (
            <>
              {splitGroup(menuRoster, menu.id) && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setZoomedGroup(null);
                    update((previous) => ungroupSession(previous, menu.id));
                    setMenu(null);
                  }}
                >
                  {tx("取消分组")}
                </button>
              )}
              {(workspace ? groupableSessions(workspace, menu.id) : []).map((session) => (
                <button
                  key={session.id}
                  role="menuitem"
                  onClick={() => {
                    setZoomedGroup(null);
                    update((previous) => groupSessions(previous, menu.id, session.id));
                    setMenu(null);
                  }}
                >
                  {tx("与 {p0} 分组", { p0: session.name })}
                </button>
              ))}
            </>
          )}
          {menu.kind === "session" && (
            <button
              role="menuitem"
              onClick={() => {
                void navigator.clipboard
                  .writeText(sessionLink(menu.id))
                  .catch((reason) => setError(String(reason)));
                setMenu(null);
              }}
            >
              {tx("复制会话链接")}
            </button>
          )}
          {menu.kind === "session" && (
            <button
              role="menuitem"
              onClick={() => {
                setCloseRequest((previous) => ({
                  id: menu.id,
                  sequence: (previous?.sequence ?? 0) + 1,
                }));
                setMenu(null);
              }}
            >
              {tx("关闭会话")}
            </button>
          )}
          {menu.kind === "worktree" && (
            <>
              <button
                role="menuitem"
                disabled={menuWorktree?.missing}
                onClick={() => {
                  update((previous) => selectProject(previous, menu.project, menu.id));
                  addSession();
                  setMenu(null);
                }}
              >
                {tx("新建会话")}
              </button>
              <button
                role="menuitem"
                disabled={menuWorktree?.missing || menuWorktreeHasSessions}
                title={
                  menuWorktreeHasSessions
                    ? tx("请先关闭此 Worktree 中的所有会话")
                    : tx("删除 Worktree 及其文件夹")
                }
                onClick={() => {
                  if (menuProject && menuWorktree) void deleteWorktree(menuProject, menuWorktree);
                }}
              >
                {tx("删除 Worktree")}
              </button>
            </>
          )}
          {menu.kind === "project" && menuProject && (
            <ProjectMenuActions
              key={menuProject.id}
              directory={menuProject.directory}
              workspaces={(workspace?.groups ?? []).filter(
                (group) => group.id !== menuProject.workspaceId,
              )}
              creatingWorktree={creatingWorktree}
              createWorktree={() => void createWorktree(menuProject)}
              move={(target) => update((previous) => moveProject(previous, menu.id, target))}
              close={() => setMenu(null)}
              onError={setError}
            />
          )}
        </div>
      )}
      {agentOpen && runtime && (
        <AgentPanel
          runtime={runtime}
          close={() => setAgentOpen(false)}
          reload={async () => setRuntime(await getRuntimeInfo())}
        />
      )}
      <dialog
        ref={projectDialog}
        className="name-dialog"
        aria-labelledby="project-dialog-title"
        onCancel={(event) => {
          if (adding || selectingDirectory) event.preventDefault();
          else setShowProjectDialog(false);
        }}
      >
        {showProjectDialog && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void addProject();
            }}
          >
            <h2 id="project-dialog-title">{tx("添加项目")}</h2>
            <label>
              {tx("项目目录")}
              <input
                autoFocus
                value={directory}
                disabled={adding || selectingDirectory}
                onChange={(event) => {
                  setDirectory(event.target.value);
                  setProjectDirectoriesToAdd([]);
                }}
                placeholder={tx("输入项目绝对路径")}
              />
            </label>
            <button
              className="project-directory-picker"
              type="button"
              disabled={!runtime || adding || selectingDirectory}
              onClick={() => void selectProjectDirectory()}
            >
              {selectingDirectory ? tx("正在选择…") : tx("选择文件夹…")}
            </button>
            {projectDirectoriesToAdd.length > 0 && (
              <ul style={{ maxHeight: 200, overflow: "auto", overflowWrap: "anywhere" }}>
                {projectDirectoriesToAdd.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            )}
            {error && <p role="alert">{localizeMessage(error)}</p>}
            <div>
              <button
                type="button"
                disabled={adding || selectingDirectory}
                onClick={() => setShowProjectDialog(false)}
              >
                {tx("取消")}
              </button>
              <button
                disabled={
                  !runtime || !workspace || adding || selectingDirectory || !directory.trim()
                }
              >
                {adding ? tx("正在添加") : tx("添加")}
              </button>
            </div>
          </form>
        )}
      </dialog>
      <dialog
        ref={nameDialog}
        className="name-dialog"
        aria-labelledby="name-dialog-title"
        onCancel={() => setEditing(null)}
      >
        {editing && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              saveName();
            }}
          >
            <h2 id="name-dialog-title">
              {editing.kind === "new" ? tx("新建工作区") : tx("重命名")}
            </h2>
            <input
              autoFocus
              aria-label={tx("名称")}
              maxLength={120}
              value={editing.name}
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            />
            <div>
              <button type="button" onClick={() => setEditing(null)}>
                {tx("取消")}
              </button>
              <button disabled={!editing.name.trim()}>
                {editing.kind === "new" ? tx("创建") : tx("保存")}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
import { TransientError } from "./components/TransientError";
