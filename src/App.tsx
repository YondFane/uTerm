import { DatabaseConnectionDialog } from "./components/DatabaseConnectionDialog";
import { DatabaseWorkspace } from "./components/DatabaseWorkspace";
import { DatabaseComponents } from "./components/DatabaseComponents";
import {
  databaseError,
  databaseSnapshot,
  subscribeDatabase,
  type DatabaseConfig,
} from "./lib/database";
import { RedisConnectionDialog } from "./components/RedisConnectionDialog";
import { RedisWorkspace } from "./components/RedisWorkspace";
import {
  redisError,
  redisSnapshot,
  subscribeRedis,
  resolveRedisSsh,
  type RedisConfig,
} from "./lib/redis";
import { SshConnectionDialog } from "./components/SshConnectionDialog";
import { SshConnectionHeader } from "./components/SshConnectionHeader";
import { SshQuickConnect } from "./components/SshQuickConnect";
import { SshTunnels } from "./components/SshTunnels";
import type { SshFileStatus, TerminalStatus, SshTunnelStatus } from "./lib/ssh";
import { RemoteFiles, RemoteTransferShelf } from "./components/RemoteFiles";
import { fileTarget, sshError } from "./lib/file-target";
import { subscribeTransfers, transferSnapshot } from "./lib/remote-transfers";
import { reconcileSshSessions, type SshConnection, type SshTarget } from "./lib/workspace";
import { UpdateInstallDialog } from "./components/UpdateInstallDialog";
import { getUiLanguage, localizeMessage } from "./lib/i18n";
import { useUiLanguage } from "./lib/useUiLanguage";
import { tx } from "./lib/i18n";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
  commands,
  sessionLink,
  sessionFromLink,
  shortcutLabel,
  shortcutCommand,
} from "./lib/settings";
import type { CommandId } from "./lib/settings";
import { isDirty } from "./lib/file-document";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { agentNames, SidebarIcon, ToolbarIcon } from "./components/SidebarIcon";
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
import { useMacosMenu } from "./lib/useMacosMenu";
import {
  emptyWorkspace,
  sshTargetFor,
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

import { sidebarLayout, sidebarRailWidth } from "./lib/sidebar-layout";

export function App() {
  useUiLanguage();

  const { settings, save: saveSettings, resizeFont } = useSettings();
  const inspectorOnLeft = settings.inspectorPosition === "left";
  const navigationSidebar = settings.sidebarStyle === "navigation";
  const t = (key: string) => translate(activeLanguage(settings.language), key);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [requestedSidebarWidth, setRequestedSidebarWidth] = useState(248);
  const sidebarDrag = useRef<{
    x: number;
    width: number;
    restoreWidth: number;
    wasVisible: boolean;
    nextWidth: number;
    expanded: boolean;
    collapse?: boolean;
  } | null>(null);
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
  const inspectorDrag = useRef<{
    x: number;
    width: number;
    ratio: number;
    collapse?: boolean;
  } | null>(null);
  const panelPreview = useRef<(() => void) | null>(null);
  const panelFrame = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    // Preserve the live preview when task activity causes an unrelated render.
    // 任务活动触发无关渲染时，保留拖动中的实时预览。
    panelPreview.current?.();
  });
  useEffect(
    () => () => {
      if (panelFrame.current !== undefined) window.cancelAnimationFrame(panelFrame.current);
    },
    [],
  );
  useEffect(() => {
    const shell = shellElement.current;
    if (!shell) return;
    const observer = new ResizeObserver(() => setShellWidth(shell.clientWidth));
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);
  const sidebarSize = sidebarLayout(shellWidth, requestedSidebarWidth, navigationSidebar);
  const sidebarWidth = sidebarVisible
    ? sidebarSize.width
    : navigationSidebar
      ? sidebarRailWidth
      : 0;
  useEffect(() => {
    if (navigationSidebar)
      setRequestedSidebarWidth((width) => (width <= sidebarSize.collapseWidth ? 248 : width));
  }, [navigationSidebar, sidebarSize.collapseWidth]);
  function applyPanelLayout(width: number, ratio: number) {
    const shell = shellElement.current;
    if (!shell) return;
    const inspector = inspectorLayout(shellWidth - width, ratio);
    shell.style.setProperty("--sidebar-width", `${width}px`);
    shell.style.setProperty("--inspector-width", `${inspector.width}px`);
    shell.style.setProperty(
      "--inspector-boundary",
      `${width + (inspectorOnLeft ? inspector.width : Math.max(320, shellWidth - width - inspector.width))}px`,
    );
    shell
      .querySelector(".sidebar-resizer")
      ?.setAttribute("aria-valuenow", String(Math.round(width)));
    const separator = shell.querySelector(".inspector-resizer");
    separator?.setAttribute("aria-valuenow", String(Math.round(inspector.ratio * 100)));
    separator?.setAttribute(
      "aria-valuemin",
      String(Math.round((inspector.minimum / inspector.available) * 100)),
    );
    separator?.setAttribute(
      "aria-valuemax",
      String(Math.round((inspector.maximum / inspector.available) * 100)),
    );
  }
  function previewPanelLayout(
    width: number,
    ratio: number,
    panel: "sidebar" | "inspector",
    collapse: boolean,
  ) {
    // Move the dividers once per frame without rendering every session on each pointer event.
    // 每帧仅移动一次分隔条，避免每次指针事件都重新渲染所有会话。
    panelPreview.current = () => {
      applyPanelLayout(width, ratio);
      shellElement.current?.toggleAttribute(`data-${panel}-snap`, collapse);
    };
    if (panelFrame.current !== undefined) return;
    panelFrame.current = window.requestAnimationFrame(() => {
      panelFrame.current = undefined;
      panelPreview.current?.();
    });
  }
  function clearPanelPreview() {
    if (panelFrame.current !== undefined) window.cancelAnimationFrame(panelFrame.current);
    panelFrame.current = undefined;
    panelPreview.current = null;
    // Restore React's committed values before handing layout ownership back to it.
    // 交回布局控制权前，先恢复 React 已提交的值。
    applyPanelLayout(sidebarWidth, inspectorRatio);
    shellElement.current?.removeAttribute("data-sidebar-snap");
    shellElement.current?.removeAttribute("data-inspector-snap");
  }
  function moveSidebarDivider(clientX: number) {
    const drag = sidebarDrag.current;
    if (!drag) return;
    const next = sidebarLayout(shellWidth, drag.width + clientX - drag.x, navigationSidebar);
    drag.collapse = next.hidden;
    drag.nextWidth = next.width;
    if (navigationSidebar && !next.hidden && !drag.expanded) {
      drag.expanded = true;
      setSidebarVisible(true);
    }
    previewPanelLayout(next.width, inspectorRatio, "sidebar", next.hidden);
  }
  function cancelSidebarResize() {
    const drag = sidebarDrag.current;
    if (!drag) return;
    clearPanelPreview();
    if (navigationSidebar) {
      setRequestedSidebarWidth(drag.restoreWidth);
      setSidebarVisible(drag.wasVisible);
    } else setRequestedSidebarWidth(drag.nextWidth);
    sidebarDrag.current = null;
    setResizingSidebar(false);
  }
  function moveInspectorDivider(clientX: number) {
    const drag = inspectorDrag.current;
    if (!drag) return;
    const next = inspectorDragLayout(
      inspectorSize.available,
      inspectorResizeWidth(drag.width, clientX - drag.x, settings.inspectorPosition),
    );
    drag.collapse = next.hidden;
    drag.ratio = next.ratio;
    previewPanelLayout(sidebarWidth, next.ratio, "inspector", next.hidden);
  }
  function cancelInspectorResize() {
    const drag = inspectorDrag.current;
    if (!drag) return;
    clearPanelPreview();
    setInspectorRatio(drag.ratio);
    inspectorDrag.current = null;
    setResizingInspector(false);
  }
  function resizeSidebar(width: number) {
    if (sidebarDrag.current) {
      clearPanelPreview();
      sidebarDrag.current = null;
      setResizingSidebar(false);
    }
    const next = sidebarLayout(shellWidth, width, navigationSidebar);
    if (next.hidden) {
      setSidebarVisible(false);
    } else {
      setRequestedSidebarWidth(next.width);
      setSidebarVisible(true);
    }
  }
  const sidebarResizeHandle = (
    <div
      className="sidebar-resizer"
      role="separator"
      tabIndex={0}
      aria-label={tx("调整左侧栏宽度")}
      aria-orientation="vertical"
      aria-valuemin={sidebarSize.minimum}
      aria-valuemax={Math.round(sidebarSize.maximum)}
      aria-valuenow={Math.round(sidebarWidth)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        sidebarDrag.current = {
          x: event.clientX,
          width: sidebarWidth,
          restoreWidth: sidebarSize.width,
          wasVisible: sidebarVisible,
          nextWidth: sidebarSize.width,
          expanded: sidebarVisible,
        };
        setResizingSidebar(true);
      }}
      onPointerMove={(event) => {
        moveSidebarDivider(event.clientX);
      }}
      onPointerUp={(event) => {
        if (!sidebarDrag.current) return;
        moveSidebarDivider(event.clientX);
        const drag = sidebarDrag.current;
        clearPanelPreview();
        if (drag.collapse) {
          setRequestedSidebarWidth(drag.restoreWidth);
          setSidebarVisible(false);
          setSidebarCollapseHint(true);
        } else setRequestedSidebarWidth(drag.nextWidth);
        sidebarDrag.current = null;
        setResizingSidebar(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={cancelSidebarResize}
      onPointerCancel={cancelSidebarResize}
      onDoubleClick={() => resizeSidebar(248)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
        event.preventDefault();
        resizeSidebar(
          event.key === "Home"
            ? sidebarSize.collapseWidth
            : event.key === "End"
              ? sidebarSize.maximum
              : event.key === "Enter"
                ? 248
                : navigationSidebar && !sidebarVisible && event.key === "ArrowRight"
                  ? sidebarSize.collapseWidth + 24
                  : (sidebarDrag.current?.nextWidth ?? sidebarWidth) +
                    (event.key === "ArrowLeft" ? -24 : 24),
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
        inspectorDrag.current = {
          x: event.clientX,
          width: inspectorSize.width,
          ratio: inspectorSize.ratio,
        };
        setResizingInspector(true);
      }}
      onPointerMove={(event) => {
        moveInspectorDivider(event.clientX);
      }}
      onPointerUp={(event) => {
        if (!inspectorDrag.current) return;
        moveInspectorDivider(event.clientX);
        const drag = inspectorDrag.current;
        clearPanelPreview();
        if (drag.collapse) {
          setInspectorRatio(drag.width / inspectorSize.available);
          if (inspectorVisible) {
            toggleInspector();
            setInspectorCollapseHint(true);
          }
        } else setInspectorRatio(drag.ratio);
        inspectorDrag.current = null;
        setResizingInspector(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={cancelInspectorResize}
      onDoubleClick={() => {
        cancelInspectorResize();
        setInspectorRatio(0.35);
      }}
      onPointerCancel={cancelInspectorResize}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
        event.preventDefault();
        const currentSize = inspectorDrag.current
          ? inspectorLayout(inspectorSize.available, inspectorDrag.current.ratio)
          : inspectorSize;
        cancelInspectorResize();
        const width =
          event.key === "Home"
            ? inspectorSize.minimum
            : event.key === "End"
              ? inspectorSize.maximum
              : event.key === "Enter"
                ? inspectorSize.available * 0.35
                : inspectorResizeWidth(
                    currentSize.width,
                    event.key === "ArrowLeft" ? -16 : 16,
                    settings.inspectorPosition,
                  );
        setInspectorRatio(
          inspectorLayout(inspectorSize.available, width / inspectorSize.available).ratio,
        );
      }}
    />
  );

  const transfers = useSyncExternalStore(subscribeTransfers, transferSnapshot);
  const redisStatuses = useSyncExternalStore(subscribeRedis, redisSnapshot);
  const databaseStatuses = useSyncExternalStore(subscribeDatabase, databaseSnapshot);
  const [databaseDialog, setDatabaseDialog] = useState<{ connection?: DatabaseConfig } | null>(
    null,
  );
  const [databaseViews, setDatabaseViews] = useState<DatabaseConfig[]>([]);
  const [selectedDatabaseId, setSelectedDatabaseId] = useState<string | null>(null);
  const [databasePasswords, setDatabasePasswords] = useState<Record<string, string>>({});
  const [databaseExit, setDatabaseExit] = useState(false);
  const databaseExitDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (databaseExit) databaseExitDialog.current?.showModal();
    else databaseExitDialog.current?.close();
  }, [databaseExit]);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("database-close-request", () => {
      const id = Object.entries(databaseSnapshot()).find(
        ([, status]) => status.dirty || status.busy,
      )?.[0];
      const owner = currentWorkspace.current?.groups?.find((group) =>
        group.databaseConnections?.some((connection) => connection.id === id),
      );
      if (owner && id) {
        update((previous) => ({
          ...switchWorkspace(previous, owner.id),
          selectedProject: null,
          selectedSession: null,
          selectedWorktree: null,
        }));
        setSelectedRedisId(null);
        setSelectedDatabaseId(id);
      } else setSelectedDatabaseId("components");
      setDatabaseExit(true);
    })
      .then((value) => {
        if (disposed) value();
        else stop = value;
      })
      .catch((reason) => setError(databaseError(reason)));
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const [redisDialog, setRedisDialog] = useState<{ connection?: RedisConfig } | null>(null);
  const [redisViews, setRedisViews] = useState<RedisConfig[]>([]);
  const [selectedRedisId, setSelectedRedisId] = useState<string | null>(null);
  const [redisPasswords, setRedisPasswords] = useState<Record<string, string>>({});
  const [sshDialog, setSshDialog] = useState<{ connection?: SshConnection } | null>(null);
  const [quickSshOpen, setQuickSshOpen] = useState(false);
  const [tunnelsOpen, setTunnelsOpen] = useState(false);
  const [tunnelStatuses, setTunnelStatuses] = useState<SshTunnelStatus[]>([]);
  const [tunnelError, setTunnelError] = useState("");
  const tunnelRevision = useRef(0);
  const tunnelRequests = useRef(0);
  const [selectedSshId, setSelectedSshId] = useState<string | null>(null);
  const [remoteDirectories, setRemoteDirectories] = useState<Record<string, string>>({});
  const [remoteFileStates, setRemoteFileStates] = useState<
    Record<string, { connectionId: string; status: SshFileStatus; error: string }>
  >({});
  const [terminalStatuses, setTerminalStatuses] = useState<Record<string, TerminalStatus>>({});
  const lastSshSessions = useRef<Record<string, string>>({});
  const onTerminalStatus = useCallback((id: string, status: TerminalStatus | null) => {
    setTerminalStatuses((previous) => {
      if (previous[id] === (status ?? undefined)) return previous;
      const next = { ...previous };
      if (status) next[id] = status;
      else delete next[id];
      return next;
    });
  }, []);
  const [sshLaunches, setSshLaunches] = useState<ReadonlySet<string>>(() => new Set());
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
  const pendingAgentNotifications = useRef(new Map<string, symbol>());
  const seenAgentEvents = useRef(new Map<string, Set<string>>());
  const lastAgentEvent = useRef(new Map<string, string>());

  function notifyAgentActivity(id: string, body: string) {
    const current = currentWorkspace.current;
    if (
      !runtime ||
      runtime.debug ||
      localStorage.getItem(notificationKey) !== "true" ||
      !current ||
      (document.hasFocus() && current.selectedSession === id)
    )
      return;
    const request = Symbol();
    pendingAgentNotifications.current.set(id, request);
    void invoke<boolean | null>("plugin:notification|is_permission_granted")
      .then(async (granted) => {
        const current = currentWorkspace.current;
        if (
          !granted ||
          pendingAgentNotifications.current.get(id) !== request ||
          localStorage.getItem(notificationKey) !== "true" ||
          !current ||
          (document.hasFocus() && current.selectedSession === id)
        )
          return;
        const session = sessionEntries(current).find((entry) => entry.session.id === id)?.session;
        if (!session) return;
        await invoke("plugin:notification|notify", { options: { title: session.name, body } });
      })
      .catch((reason) => {
        if (pendingAgentNotifications.current.get(id) === request) setError(String(reason));
      })
      .finally(() => {
        if (pendingAgentNotifications.current.get(id) === request)
          pendingAgentNotifications.current.delete(id);
      });
  }
  useEffect(() => {
    const pending = pendingAgentNotifications.current;
    return () => pending.clear();
  }, []);
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
      const savedVersion = serialized ? JSON.parse(serialized).version : 7;
      if (
        serialized &&
        [3, 4, 5, 6].includes(savedVersion) &&
        !localStorage.getItem(`${workspaceKey}.v${savedVersion}-backup`)
      )
        localStorage.setItem(`${workspaceKey}.v${savedVersion}-backup`, serialized);
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
    if (!previous) return false;
    try {
      const next = change(previous);
      if (
        next.selectedWorkspace !== previous.selectedWorkspace ||
        next.selectedProject !== previous.selectedProject ||
        next.selectedSession !== previous.selectedSession
      ) {
        setSelectedRedisId(null);
        setSelectedDatabaseId(null);
      }
      // Synchronous persistence prevents an older asynchronous save from winning.
      localStorage.setItem(workspaceKey, JSON.stringify(next));
      currentWorkspace.current = next;
      setWorkspace(next);
      setError("");
      return true;
    } catch (reason) {
      setError(tx("无法保存工作区：{p0}", { p0: String(reason) }));
      return false;
    }
  }

  useEffect(() => {
    if (!runtime || !workspace) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const discover = async () => {
      try {
        const [snapshot, sshSnapshot] = await Promise.all([
          invoke<LocalSessionSnapshot>("local_session_list"),
          invoke<LocalSessionSnapshot>("ssh_session_list"),
        ]);
        if (cancelled) return;
        setSessionSyncError("");
        const current = currentWorkspace.current;
        if (current) {
          const next = reconcileSshSessions(
            reconcileLocalSessionSnapshot(current, snapshot),
            sshSnapshot,
          );
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
    const acknowledged = agentStateValues.current[id];
    if (acknowledged !== "done" && acknowledged !== "notice") return;
    const activityEvent = lastAgentEvent.current.get(id);
    void invoke("control_session", { id, action: "acknowledge", activityEvent })
      .then(() => {
        if (
          agentStateValues.current[id] !== acknowledged ||
          lastAgentEvent.current.get(id) !== activityEvent
        )
          return;
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
        if (roster.kind === "ssh" && roster.connection) {
          const connection = roster.connection;
          const id = crypto.randomUUID();
          setSshLaunches((previous) => new Set(previous).add(id));
          const session: SessionConfig = {
            id,
            name: connection.name,
            shell: "default",
            directory: runtime?.home ?? "",
            ssh: sshTarget(connection, previous.selectedWorkspace ?? "local"),
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
        }
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
  function sshTarget(connection: SshConnection, workspaceId: string): SshTarget {
    return sshTargetFor(connection, workspaceId);
  }
  function sshInUse(connection: SshConnection): boolean {
    return (
      !!tunnelError ||
      tunnelStatuses.some(
        (item) => item.connection_id === connection.id && item.state !== "error",
      ) ||
      !!connection.sessions.length ||
      Object.values(remoteFileStates).some(
        (value) =>
          value.connectionId === connection.id &&
          ["connected", "connecting", "disconnecting"].includes(value.status),
      ) ||
      editor.documents.some((file) => {
        const target = fileTarget(file.directory);
        return target.kind === "ssh" && target.root.connection.connection_id === connection.id;
      }) ||
      transfers.some((task) => task.state === "running") ||
      redisViews.some((view) => {
        const status = redisStatuses[view.id];
        return (
          view.ssh_target?.connection_id === connection.id &&
          !!(status?.connected || status?.dirty || status?.opening)
        );
      })
    );
  }
  function canEditSsh(connection: SshConnection): boolean {
    return (
      !sshInUse(connection) &&
      !workspace?.groups?.some((group) =>
        group.databaseConnections?.some((item) => item.ssh_target?.connection_id === connection.id),
      )
    );
  }
  useEffect(() => {
    if (!runtime) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const revision = tunnelRevision.current;
      try {
        const statuses = await invoke<SshTunnelStatus[]>("ssh_tunnel_list");
        if (!disposed && revision === tunnelRevision.current && !tunnelRequests.current) {
          setTunnelStatuses((previous) =>
            JSON.stringify(previous) === JSON.stringify(statuses ?? [])
              ? previous
              : (statuses ?? []),
          );
          setTunnelError("");
        }
      } catch (reason) {
        if (!disposed) setTunnelError(sshError(reason));
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 1500);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [!!runtime]);
  useEffect(() => {
    const removable =
      workspace?.groups?.flatMap((group) =>
        (group.sshConnections ?? []).filter(
          (connection) =>
            connection.temporary &&
            !sshInUse(connection) &&
            !group.redisConnections?.some(
              (item) => item.ssh_target?.connection_id === connection.id,
            ) &&
            !group.databaseConnections?.some(
              (item) => item.ssh_target?.connection_id === connection.id,
            ),
        ),
      ) ?? [];
    if (!removable.length) return;
    const ids = new Set(removable.map((item) => item.id));
    const removed = update((previous) => ({
      ...previous,
      groups: previous.groups?.map((group) => ({
        ...group,
        sshConnections: group.sshConnections?.filter((connection) => !ids.has(connection.id)),
      })),
    }));
    if (removed && selectedSshId && ids.has(selectedSshId)) setSelectedSshId(null);
  }, [
    workspace,
    remoteFileStates,
    tunnelStatuses,
    tunnelError,
    transfers,
    editor.documents,
    redisStatuses,
  ]);
  function newSshTerminal(connection: SshConnection) {
    const start = () => {
      const id = crypto.randomUUID();
      setSshLaunches((previous) => new Set(previous).add(id));
      setSelectedSshId(connection.id);
      update((previous) =>
        selectSession(
          updateRoster(previous, `ssh:${connection.id}`, (roster) => ({
            ...roster,
            sessions: [
              ...roster.sessions,
              {
                id,
                name: connection.name,
                shell: "default",
                directory: runtime?.home ?? "",
                ssh: sshTarget(connection, roster.workspaceId),
              },
            ],
          })),
          id,
        ),
      );
    };
    if (editor.document) void editor.hide(start);
    else start();
  }
  const activeSession = roster?.sessions.find(
    (session) => session.id === workspace?.selectedSession,
  );
  useEffect(() => {
    if (activeSession?.ssh)
      lastSshSessions.current[activeSession.ssh.connection_id] = activeSession.id;
  }, [activeSession?.id]);
  const activeDatabaseConfig = workspace?.groups
    ?.find((group) => group.id === workspace.selectedWorkspace)
    ?.databaseConnections?.find((connection) => connection.id === selectedDatabaseId);
  const activeDatabase = selectedDatabaseId === "components" || !!activeDatabaseConfig;
  const activeRedis = workspace?.groups
    ?.find((group) => group.id === workspace.selectedWorkspace)
    ?.redisConnections?.find((connection) => connection.id === selectedRedisId);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<string | null>("redis-close-request", (event) => {
      const view = redisViews.find((view) => view.id === event.payload);
      const group = currentWorkspace.current?.groups?.find((group) =>
        group.redisConnections?.some((connection) => connection.id === event.payload),
      );
      if (view && group) {
        const reveal = () => {
          update((previous) => ({
            ...switchWorkspace(previous, group.id),
            selectedProject: null,
            selectedSession: null,
            selectedWorktree: null,
          }));
          setSelectedDatabaseId(null);
          setSelectedRedisId(view.id);
        };
        if (editor.document) void editor.hide(reveal);
        else reveal();
      }
    })
      .then((value) => {
        if (disposed) value();
        else stop = value;
      })
      .catch((error) => setError(redisError(error)));
    return () => {
      disposed = true;
      stop?.();
    };
  }, [redisViews, !!editor.document]);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("redis-operation-exit-request", () =>
      setError(tx("Redis 操作仍在执行，请等待完成后退出。")),
    )
      .then((value) => {
        if (disposed) value();
        else stop = value;
      })
      .catch((error) => setError(redisError(error)));
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const activeSshConnection = workspace?.groups
    ?.find((group) => group.id === workspace.selectedWorkspace)
    ?.sshConnections?.find(
      (connection) =>
        connection.id ===
        (activeSession?.ssh?.connection_id ??
          (!workspace?.selectedProject && !workspace?.selectedSession ? selectedSshId : null)),
    );
  const activeSsh =
    activeRedis || activeDatabase
      ? null
      : (activeSession?.ssh ??
        (activeSshConnection
          ? sshTarget(activeSshConnection, workspace?.selectedWorkspace ?? "local")
          : null));
  useEffect(() => {
    if (activeSsh) {
      setGitOpen(false);
      setGithubOpen(false);
      setDirectoryOpen(false);
      setFileMode("tree");
    }
  }, [activeSsh?.connection_id]);
  const sshTargetKey = activeSsh ? JSON.stringify(activeSsh) : "";
  const fileDirectory =
    activeRedis || activeDatabase
      ? ""
      : activeSsh
        ? (remoteDirectories[sshTargetKey] ?? "")
        : (selectedWorktree?.path ??
          selected?.directory ??
          roster?.sessions.find((session) => session.id === workspace?.selectedSession)
            ?.directory ??
          runtime?.home ??
          "");
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
  function contentFontKey(): "fontSize" | "fileFontSize" | "gitDiffFontSize" | null {
    if (gitOpen && gitExpanded && gitDiffActive) return "gitDiffFontSize";
    if (editor.document)
      return editor.document.kind === "text" && !document.querySelector(".html-preview")
        ? "fileFontSize"
        : null;
    return workspace?.selectedSession && !activeRedis && !activeDatabase ? "fontSize" : null;
  }
  function commandAvailable(id: CommandId): boolean {
    if (!runtime || !workspace || editor.transitioning || editor.pending) return false;
    if (id === "fontDecrease" || id === "fontIncrease") return contentFontKey() !== null;
    if (
      (activeRedis || activeDatabase) &&
      !["palette", "settings", "agents", "project", "terminal", "close", "toggleSidebar"].includes(
        id,
      )
    )
      return false;
    if ((activeRedis || activeDatabase) && id === "close") return true;
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
    if (["git", "github", "quick", "search", "chat"].includes(id) && activeSsh) return false;
    if (id === "github") return !!selected;
    if (id === "toggleInspector") return !!fileDirectory || !!activeSsh;
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
    if (activeDatabase && id === "close") {
      setSelectedDatabaseId(null);
      return;
    }
    if (activeDatabase && id === "terminal") setSelectedDatabaseId(null);
    if (activeRedis && id === "close") {
      setSelectedRedisId(null);
      return;
    }
    if (activeRedis && id === "terminal") setSelectedRedisId(null);
    if (id === "fontDecrease" || id === "fontIncrease") {
      const key = contentFontKey();
      if (key) {
        try {
          resizeFont(key, id === "fontIncrease" ? 1 : -1, runtime?.platform === "macos");
        } catch (reason) {
          setError(tx("无法保存字号：{p0}", { p0: String(reason) }));
        }
      }
    } else if (id === "palette") setPaletteOpen(true);
    else if (id === "toggleSidebar") setSidebarVisible((value) => !value);
    else if (id === "toggleInspector") toggleInspector();
    else if (id === "swapPanes") swapPanes();
    else if (id === "settings") setSettingsOpen(true);
    else if (id === "project") openProjectDialog();
    else if (id === "terminal") {
      if (activeSshConnection) newSshTerminal(activeSshConnection);
      else if (roster) addSession();
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
        document.querySelector("dialog[open], .branch-menu, .git-file-menu") ||
        menu ||
        !runtime
      )
        return;
      const command = shortcutCommand(settings, event, runtime.platform === "macos");
      const contextMenu = document.querySelector(".context-menu");
      if (contextMenu && (command !== "toggleSidebar" || !contextMenu.matches(".sidebar-popover")))
        return;
      if (command && commandAvailable(command)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        runCommand(command);
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
        const ready = await invoke<boolean>("control_wait");
        if (disposed) return;
        if (!ready) {
          timer = setTimeout(() => void poll(), 250);
          return;
        }
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
  const inspectorVisible =
    !activeRedis &&
    !activeDatabase &&
    ((!!activeSsh && filesOpen) ||
      hasInspectorContent(fileDirectory, !!selected, {
        files: filesOpen,
        directory: directoryOpen,
        git: gitOpen,
        github: githubOpen,
      }));
  const nativeMenuBlocked = !!(
    settingsOpen ||
    paletteOpen ||
    agentOpen ||
    editing ||
    menu ||
    showProjectDialog ||
    databaseDialog ||
    redisDialog ||
    sshDialog ||
    quickSshOpen ||
    tunnelsOpen ||
    databaseExit ||
    updates.confirmation !== null ||
    editor.transitioning ||
    editor.pending
  );
  useMacosMenu(
    runtime?.platform === "macos",
    {
      settings,
      workspace,
      version: runtime?.version ?? "",
      enabled: Object.fromEntries(
        commands.map(([id]) => [id, !nativeMenuBlocked && commandAvailable(id)]),
      ),
      checked: {
        toggleSidebar: sidebarVisible,
        toggleInspector: inspectorVisible,
        files: filesOpen && inspectorVisible,
        git: gitOpen && inspectorVisible,
        github: githubOpen && inspectorVisible,
        zoom: zoomed,
      },
      navigationEnabled: !!runtime && !!workspace && !nativeMenuBlocked,
      closeLabel: t(
        editor.document
          ? "关闭文件"
          : activeRedis
            ? "关闭 Redis 工作台"
            : activeDatabase
              ? "关闭数据库工作台"
              : "关闭会话",
      ),
    },
    (action) => {
      const language = activeLanguage(settings.language);
      const links: Record<string, string> = {
        guide: `https://github.com/YondFane/uTerm/blob/release/docs/features${language === "zh-Hans" ? ".zh-CN" : ""}.md`,
        website: `https://yondfane.github.io/uTerm/?lang=${language === "zh-Hans" ? "zh-CN" : "en"}`,
        issues: "https://github.com/YondFane/uTerm/issues/new",
      };
      if (Object.hasOwn(links, action)) {
        void invoke("open_external", { url: links[action] }).catch((reason) =>
          setError(String(reason)),
        );
        return;
      }
      if (nativeMenuBlocked || document.querySelector("dialog[open]")) return;
      if (action.startsWith("command:")) {
        const command = commands.find(([id]) => id === action.slice("command:".length));
        if (command) runCommand(command[0]);
      } else if (action.startsWith("session:"))
        revealTaskbarSession(action.slice("session:".length));
      else if (action.startsWith("workspace:")) {
        const id = action.slice("workspace:".length);
        const change = () => {
          if (!currentWorkspace.current?.groups?.some((group) => group.id === id)) return;
          update((previous) => switchWorkspace(previous, id));
          setFocusRequest((value) => value + 1);
        };
        if (editor.document) void editor.hide(change);
        else change();
      } else if (action === "new-workspace") setEditing({ kind: "new", id: "", name: "" });
    },
    setError,
  );
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
      const panel = activeSsh
        ? "files"
        : ["github", "git"].includes(lastInspector.current) && !selected
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
      disabled={!runtime || (!fileDirectory && !activeSsh)}
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
        disabled={!runtime || (!fileDirectory && !activeSsh)}
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
        disabled={!!activeSsh || (!selected && !roster)}
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
        disabled={!!activeSsh || !runtime || !fileDirectory}
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
      data-sidebar-style={settings.sidebarStyle}
      data-sidebar-collapsed={(navigationSidebar && !sidebarVisible) || undefined}
      data-resizing-inspector={resizingInspector || undefined}
      data-resizing-sidebar={resizingSidebar || undefined}
      data-expanded-inspector={
        (inspectorVisible && gitOpen && gitExpanded && gitDiffActive) || undefined
      }
      className={`app-shell${sidebarVisible || navigationSidebar ? "" : " sidebar-hidden"}${runtime?.platform === "macos" ? " platform-macos" : ""}${inspectorVisible ? " with-inspector" : ""}${inspectorVisible && (filesOpen || directoryOpen) ? " with-files" : ""}`}
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
          setSelectedRedisId(null);
          setSelectedDatabaseId(null);
          if (editor.document) void editor.hide();
          else setFocusRequest((value) => value + 1);
        }}
        menu={setMenu}
        addDatabase={() => setDatabaseDialog({})}
        editDatabase={(connection) => setDatabaseDialog({ connection })}
        databaseStatuses={databaseStatuses}
        selectedDatabaseId={activeDatabaseConfig?.id ?? null}
        manageDatabase={() => {
          const reveal = () => {
            setSelectedRedisId(null);
            setSelectedDatabaseId("components");
          };
          if (editor.document) void editor.hide(reveal);
          else reveal();
        }}
        selectDatabase={(connection) => {
          const reveal = () => {
            update((previous) => ({
              ...previous,
              selectedProject: null,
              selectedSession: null,
              selectedWorktree: null,
            }));
            setSelectedRedisId(null);
            setSelectedSshId(null);
            setSelectedDatabaseId(connection.id);
            setDatabaseViews((previous) =>
              previous.some((item) => item.id === connection.id)
                ? previous
                : [...previous, connection],
            );
          };
          if (editor.document) void editor.hide(reveal);
          else reveal();
        }}
        removeDatabase={(connection) => {
          const remove = async () => {
            const owner = currentWorkspace.current?.groups?.find((group) =>
              group.databaseConnections?.some((item) => item.id === connection.id),
            );
            if (!owner) return;
            const saved = update((previous) => ({
              ...previous,
              groups: previous.groups?.map((group) => ({
                ...group,
                databaseConnections: group.databaseConnections?.filter(
                  (item) => item.id !== connection.id,
                ),
              })),
            }));
            if (!saved) return;
            try {
              if (connection.credential_id)
                await invoke("database_credential", {
                  config: connection,
                  password: null,
                  remove: true,
                });
            } catch (reason) {
              update((previous) => ({
                ...previous,
                groups: previous.groups?.map((group) =>
                  group.id === owner.id
                    ? {
                        ...group,
                        databaseConnections: [...(group.databaseConnections ?? []), connection],
                      }
                    : group,
                ),
              }));
              throw reason;
            }
            setDatabaseViews((previous) => previous.filter((item) => item.id !== connection.id));
            if (selectedDatabaseId === connection.id) setSelectedDatabaseId(null);
            setDatabasePasswords((previous) => {
              const next = { ...previous };
              delete next[connection.id];
              return next;
            });
          };
          void remove().catch((reason) => setError(databaseError(reason)));
        }}
        addRedis={() => setRedisDialog({})}
        editRedis={(connection) => setRedisDialog({ connection })}
        redisStatuses={redisStatuses}
        selectedRedisId={activeRedis?.id ?? null}
        selectRedis={(connection) => {
          const owner = currentWorkspace.current?.groups?.find((group) =>
            group.redisConnections?.some((item) => item.id === connection.id),
          );
          if (owner) connection = resolveRedisSsh(connection, owner.sshConnections ?? [], owner.id);
          const reveal = () => {
            update((previous) => ({
              ...previous,
              selectedProject: null,
              selectedSession: null,
              selectedWorktree: null,
            }));
            setSelectedSshId(null);
            setGitOpen(false);
            setGithubOpen(false);
            setDirectoryOpen(false);
            setSelectedDatabaseId(null);
            setSelectedRedisId(connection.id);
            setRedisViews((previous) =>
              previous.some((item) => item.id === connection.id)
                ? previous
                : [...previous, connection],
            );
          };
          if (editor.document) void editor.hide(reveal);
          else reveal();
        }}
        removeRedis={(connection) => {
          const remove = async () => {
            const owner = currentWorkspace.current?.groups?.find((group) =>
              group.redisConnections?.some((item) => item.id === connection.id),
            );
            if (!owner) return;
            const removed = update((previous) => ({
              ...previous,
              groups: previous.groups?.map((group) => ({
                ...group,
                redisConnections: group.redisConnections?.filter(
                  (item) => item.id !== connection.id,
                ),
              })),
            }));
            if (!removed) return;
            try {
              if (connection.credential_id)
                await invoke("redis_credential", {
                  config: connection,
                  password: null,
                  remove: true,
                });
            } catch (error) {
              update((previous) => ({
                ...previous,
                groups: previous.groups?.map((group) =>
                  group.id === owner.id
                    ? {
                        ...group,
                        redisConnections: [...(group.redisConnections ?? []), connection],
                      }
                    : group,
                ),
              }));
              throw error;
            }
            setRedisViews((previous) => previous.filter((item) => item.id !== connection.id));
            if (selectedRedisId === connection.id) setSelectedRedisId(null);
          };
          void remove().catch((error) => setError(redisError(error)));
        }}
        addSsh={() => setSshDialog({})}
        quickSsh={() => {
          if (editor.document) void editor.hide(() => setQuickSshOpen(true));
          else setQuickSshOpen(true);
        }}
        editSsh={(connection) => setSshDialog({ connection })}
        selectSsh={(connection) => {
          const select = () => {
            setSelectedRedisId(null);
            setSelectedDatabaseId(null);
            setSelectedSshId(connection.id);
            setGitOpen(false);
            setGithubOpen(false);
            setDirectoryOpen(false);
            setFilesOpen(false);
            update((previous) =>
              connection.sessions.length
                ? selectSession(
                    previous,
                    connection.sessions.find(
                      (session) => session.id === lastSshSessions.current[connection.id],
                    )?.id ?? connection.sessions[0].id,
                  )
                : {
                    ...previous,
                    selectedProject: null,
                    selectedSession: null,
                    selectedWorktree: null,
                  },
            );
          };
          if (editor.document) void editor.hide(select);
          else select();
        }}
        newSshTerminal={newSshTerminal}
        canEditSsh={canEditSsh}
        canRemoveSsh={(connection) =>
          !sshInUse(connection) &&
          !workspace?.groups?.some((group) =>
            group.databaseConnections?.some(
              (item) => item.ssh_target?.connection_id === connection.id,
            ),
          ) &&
          !workspace?.groups?.some((group) =>
            group.redisConnections?.some(
              (redis) => redis.ssh_target?.connection_id === connection.id,
            ),
          )
        }
        removeSsh={(connection) => {
          void invoke("ssh_files_disconnect", { connectionId: connection.id })
            .then(() => {
              const removed = update((previous) => ({
                ...previous,
                groups: previous.groups?.map((group) => ({
                  ...group,
                  sshConnections: group.sshConnections?.filter((item) => item.id !== connection.id),
                })),
              }));
              if (!removed) return;
              if (connection.credential_id)
                void invoke("ssh_forget_auth", {
                  reference: connection.credential_id,
                  remember: connection.remember_password ?? false,
                }).catch((error) => setError(sshError(error)));
              if (selectedSshId === connection.id) setSelectedSshId(null);
            })
            .catch((error) => setError(sshError(error)));
        }}
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
      {databaseDialog && (
        <DatabaseConnectionDialog
          report={setError}
          connection={databaseDialog.connection}
          workspaceId={workspace?.selectedWorkspace ?? "local"}
          ssh={
            workspace?.groups?.find((group) => group.id === workspace.selectedWorkspace)
              ?.sshConnections ?? []
          }
          close={() => setDatabaseDialog(null)}
          save={(connection, password) => {
            const saved = update((previous) => ({
              ...previous,
              groups: previous.groups?.map((group) =>
                group.id !== previous.selectedWorkspace
                  ? group
                  : {
                      ...group,
                      databaseConnections: group.databaseConnections?.some(
                        (item) => item.id === connection.id,
                      )
                        ? group.databaseConnections.map((item) =>
                            item.id === connection.id ? connection : item,
                          )
                        : [...(group.databaseConnections ?? []), connection],
                    },
              ),
            }));
            if (saved) {
              setDatabaseViews((previous) =>
                previous.map((item) => (item.id === connection.id ? connection : item)),
              );
              setDatabasePasswords((previous) => ({ ...previous, [connection.id]: password }));
            }
            return saved;
          }}
        />
      )}
      <dialog
        ref={databaseExitDialog}
        className="database-confirm-dialog"
        onCancel={(event) => {
          event.preventDefault();
          setDatabaseExit(false);
        }}
      >
        <p>
          {tx(
            "数据库仍有操作、事务或未保存修改。请等待操作完成，提交或回滚事务，并保存或放弃修改后退出。",
          )}
        </p>
        <button onClick={() => setDatabaseExit(false)}>{tx("返回工作台")}</button>
        <button
          onClick={() => {
            void invoke("database_exit").catch((reason) => setError(databaseError(reason)));
          }}
        >
          {tx("放弃未保存修改并退出")}
        </button>
      </dialog>
      {redisDialog && (
        <RedisConnectionDialog
          workspaceId={workspace?.selectedWorkspace ?? "local"}
          connection={redisDialog.connection}
          ssh={
            workspace?.groups?.find((group) => group.id === workspace.selectedWorkspace)
              ?.sshConnections ?? []
          }
          close={() => setRedisDialog(null)}
          save={(connection, password) => {
            const saved = update((previous) => ({
              ...previous,
              groups: previous.groups?.map((group) =>
                group.id === previous.selectedWorkspace
                  ? {
                      ...group,
                      redisConnections: group.redisConnections?.some(
                        (item) => item.id === connection.id,
                      )
                        ? group.redisConnections.map((item) =>
                            item.id === connection.id ? connection : item,
                          )
                        : [...(group.redisConnections ?? []), connection],
                    }
                  : group,
              ),
            }));
            if (saved) {
              setRedisViews((previous) =>
                previous.map((item) => (item.id === connection.id ? connection : item)),
              );
              setRedisPasswords((previous) => ({ ...previous, [connection.id]: password }));
            }
            return saved;
          }}
        />
      )}
      {quickSshOpen && (
        <SshQuickConnect
          close={() => setQuickSshOpen(false)}
          connect={(connection) => {
            const current = currentWorkspace.current;
            const group = current?.groups?.find((item) => item.id === current.selectedWorkspace);
            if (!group || !runtime) return false;
            const id = crypto.randomUUID();
            const value = {
              ...connection,
              sessions: [
                {
                  id,
                  name: connection.name,
                  shell: "default" as const,
                  directory: runtime.home,
                  ssh: sshTarget(connection, group.id),
                },
              ],
            };
            const saved = update((previous) =>
              selectSession(
                {
                  ...previous,
                  groups: previous.groups?.map((item) =>
                    item.id === group.id
                      ? { ...item, sshConnections: [...(item.sshConnections ?? []), value] }
                      : item,
                  ),
                },
                id,
              ),
            );
            if (saved) {
              setSshLaunches((previous) => new Set(previous).add(id));
              setSelectedSshId(connection.id);
              setFilesOpen(false);
              setTunnelsOpen(false);
            }
            return saved;
          }}
        />
      )}
      {sshDialog && (
        <SshConnectionDialog
          workspaceId={workspace?.selectedWorkspace ?? "local"}
          connection={sshDialog.connection}
          close={() => setSshDialog(null)}
          connect={newSshTerminal}
          save={(connection) => {
            const updateRedis = (value: RedisConfig): RedisConfig =>
              value.ssh_target?.connection_id === connection.id
                ? {
                    ...value,
                    ssh_host: connection.host,
                    ssh_target: sshTarget(connection, value.ssh_target.workspace_id),
                  }
                : value;
            const saved = update((previous) => ({
              ...previous,
              groups: previous.groups?.map((group) => ({
                ...group,
                redisConnections: group.redisConnections?.map(updateRedis),
                ...(group.id === previous.selectedWorkspace
                  ? {
                      sshConnections: group.sshConnections?.some(
                        (item) => item.id === connection.id,
                      )
                        ? group.sshConnections.map((item) =>
                            item.id === connection.id
                              ? {
                                  ...connection,
                                  sessions: item.sessions,
                                  splitGroups: item.splitGroups,
                                }
                              : item,
                          )
                        : [...(group.sshConnections ?? []), connection],
                    }
                  : {}),
              })),
            }));
            if (saved) {
              setRedisViews((previous) => previous.map(updateRedis));
              setSelectedRedisId(null);
              setSelectedDatabaseId(null);
              setSelectedSshId(connection.id);
              setFilesOpen(false);
              update((previous) => ({
                ...previous,
                selectedProject: null,
                selectedSession: null,
                selectedWorktree: null,
              }));
            }
            return saved;
          }}
        />
      )}
      {runtime && <RemoteTransferShelf />}
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
              {activeDatabase
                ? (activeDatabaseConfig?.name ?? tx("数据库组件"))
                : activeRedis
                  ? activeRedis.name
                  : selectedWorktree
                    ? `${selected?.name} / ${selectedWorktree.name}`
                    : (activeSsh?.name ??
                      selected?.name ??
                      (roster?.kind === "chats" ? tx("聊天") : tx("终端")))}
            </h1>
            {runtime && fileDirectory && !activeSsh && (
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
            {roster && !activeRedis && !activeDatabase && (
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
                {runtime?.platform === "windows" && !activeSsh && (
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
        {activeSsh && activeSshConnection && (
          <SshConnectionHeader
            target={activeSsh}
            terminalStatus={activeSession ? terminalStatuses[activeSession.id] : undefined}
            sessions={activeSshConnection.sessions.length}
            filesStatus={remoteFileStates[sshTargetKey]?.status ?? "idle"}
            filesVisible={filesOpen}
            disabled={!runtime || editor.transitioning || editor.pending}
            canEdit={canEditSsh(activeSshConnection)}
            newTerminal={() => newSshTerminal(activeSshConnection)}
            showFiles={() => {
              setTunnelsOpen(false);
              setFilesOpen((value) => !value);
              setGitOpen(false);
              setGithubOpen(false);
              setDirectoryOpen(false);
            }}
            edit={() => setSshDialog({ connection: activeSshConnection })}
            temporary={activeSshConnection.temporary}
            promote={() =>
              update((previous) => ({
                ...previous,
                groups: previous.groups?.map((group) => ({
                  ...group,
                  sshConnections: group.sshConnections?.map((connection) =>
                    connection.id === activeSshConnection.id
                      ? { ...connection, temporary: false }
                      : connection,
                  ),
                })),
              }))
            }
            tunnelsVisible={tunnelsOpen}
            showTunnels={() => {
              if (!tunnelsOpen) setFilesOpen(false);
              setTunnelsOpen((value) => !value);
            }}
          />
        )}
        {activeSsh && activeSshConnection && tunnelsOpen && (
          <SshTunnels
            key={activeSshConnection.id}
            rules={activeSshConnection.forwards ?? []}
            statuses={tunnelStatuses.filter(
              (item) => item.connection_id === activeSshConnection.id,
            )}
            error={tunnelError}
            save={(forwards) =>
              update((previous) => ({
                ...previous,
                groups: previous.groups?.map((group) => ({
                  ...group,
                  sshConnections: group.sshConnections?.map((connection) =>
                    connection.id === activeSshConnection.id
                      ? { ...connection, forwards }
                      : connection,
                  ),
                })),
              }))
            }
            start={async (rule) => {
              tunnelRevision.current++;
              tunnelRequests.current++;
              const status: SshTunnelStatus = {
                id: rule.id,
                connection_id: activeSshConnection.id,
                state: "starting",
              };
              const put = (value: SshTunnelStatus) =>
                setTunnelStatuses((previous) => [
                  ...previous.filter(
                    (item) => item.id !== rule.id || item.connection_id !== value.connection_id,
                  ),
                  value,
                ]);
              put(status);
              try {
                put(
                  await invoke<SshTunnelStatus>("ssh_tunnel_start", {
                    connection: activeSsh,
                    rule,
                  }),
                );
              } catch (reason) {
                put({ ...status, state: "error", error: String(reason) });
                throw reason;
              } finally {
                tunnelRevision.current++;
                tunnelRequests.current--;
              }
            }}
            stop={async (id) => {
              tunnelRevision.current++;
              tunnelRequests.current++;
              try {
                await invoke("ssh_tunnel_stop", { connectionId: activeSshConnection.id, id });
                setTunnelStatuses((previous) =>
                  previous.filter(
                    (item) => item.id !== id || item.connection_id !== activeSshConnection.id,
                  ),
                );
              } finally {
                tunnelRevision.current++;
                tunnelRequests.current--;
              }
            }}
          />
        )}
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
        {activeDatabase && selectedDatabaseId === "components" && (
          <div className="database-component-workspace">
            <DatabaseComponents />
          </div>
        )}
        {databaseViews.map((connection) => (
          <DatabaseWorkspace
            key={JSON.stringify(connection)}
            config={connection}
            active={activeDatabaseConfig?.id === connection.id}
            password={databasePasswords[connection.id] ?? ""}
          />
        ))}
        {redisViews.map((connection) => (
          <RedisWorkspace
            key={JSON.stringify(connection)}
            config={connection}
            active={activeRedis?.id === connection.id}
            password={redisPasswords[connection.id] ?? ""}
            consumed={() => setRedisPasswords((previous) => ({ ...previous, [connection.id]: "" }))}
          />
        ))}
        <div
          hidden={!!activeRedis || activeDatabase}
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
            {!workspace?.selectedSession && activeSsh && activeSshConnection && (
              <section className="welcome" aria-label={tx("SSH 连接")}>
                <div className="welcome-content">
                  <h2>{activeSsh.name}</h2>
                  <p className="welcome-description">{activeSsh.host}</p>
                  <p className="welcome-description">
                    {tx("选择已有会话，或新建终端。文件通过 SFTP 单独连接。")}
                  </p>
                  <dl className="ssh-overview-details">
                    <div>
                      <dt>{tx("远端系统")}</dt>
                      <dd>{activeSsh.os === "windows" ? "Windows" : "Linux / macOS"}</dd>
                    </div>
                    <div>
                      <dt>{tx("远程文件根目录")}</dt>
                      <dd>{activeSsh.root || tx("服务端登录目录")}</dd>
                    </div>
                    <div>
                      <dt>{tx("认证方式")}</dt>
                      <dd>
                        {activeSsh.authentication === "password"
                          ? tx("密码")
                          : activeSsh.authentication === "key"
                            ? tx("私钥 / ssh-agent")
                            : tx("OpenSSH 自动认证")}
                      </dd>
                    </div>
                  </dl>
                  <button
                    className="welcome-action primary"
                    onClick={() => newSshTerminal(activeSshConnection)}
                  >
                    <SidebarIcon name="terminal" />
                    <strong>{tx("新建 SSH 终端")}</strong>
                  </button>
                </div>
              </section>
            )}
            {!workspace?.selectedSession && !activeSsh && (
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
                    <div className="welcome-connections">
                      {(navigationSidebar || settings.showSshConnections) && (
                        <button
                          className="welcome-action"
                          disabled={!runtime || !workspace}
                          onClick={() => setSshDialog({})}
                        >
                          <SidebarIcon name="terminal" />
                          <span>
                            <strong>{tx("添加 SSH 连接")}</strong>
                          </span>
                        </button>
                      )}
                      {(navigationSidebar || settings.showRedisConnections) && (
                        <button
                          className="welcome-action"
                          disabled={!runtime || !workspace}
                          onClick={() => setRedisDialog({})}
                        >
                          <SidebarIcon name="database" />
                          <span>
                            <strong>{tx("添加 Redis 连接")}</strong>
                          </span>
                        </button>
                      )}
                      {(navigationSidebar || settings.showDatabaseConnections) && (
                        <button
                          className="welcome-action"
                          disabled={!runtime || !workspace}
                          onClick={() => setDatabaseDialog({})}
                        >
                          <SidebarIcon name="sqlDatabase" />
                          <span>
                            <strong>{tx("添加数据库连接")}</strong>
                          </span>
                        </button>
                      )}
                    </div>
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
                onTerminalStatus={onTerminalStatus}
                sshLaunches={sshLaunches}
                onSshRestart={(id) => {
                  const entry = sessionRosters(currentWorkspace.current!).find((roster) =>
                    roster.sessions.some((session) => session.id === id),
                  );
                  if (entry?.connection) newSshTerminal(entry.connection);
                }}
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
                onAgentState={(id, state, initial, eventDriven) => {
                  if (agentStateValues.current[id] === state) return;
                  pendingAgentNotifications.current.delete(id);
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
                  if (
                    ["done", "notice"].includes(state) &&
                    selectedSession === id &&
                    (!eventDriven || initial)
                  )
                    acknowledgeCompletedSession(id);
                  if (
                    !initial &&
                    !eventDriven &&
                    !runtime.debug &&
                    ["waiting", "done"].includes(state) &&
                    localStorage.getItem(notificationKey) === "true" &&
                    (!document.hasFocus() || selectedSession !== id)
                  ) {
                    notifyAgentActivity(
                      id,
                      state === "waiting" ? tx("需要你处理") : tx("任务已完成"),
                    );
                  }
                }}
                onAgentEvent={(id, event) => {
                  const seen = seenAgentEvents.current.get(id) ?? new Set<string>();
                  if (seen.has(event.id)) return;
                  seen.add(event.id);
                  if (seen.size > 128) seen.delete(seen.values().next().value!);
                  seenAgentEvents.current.set(id, seen);
                  lastAgentEvent.current.set(id, event.id);
                  pendingAgentNotifications.current.delete(id);
                  if (event.kind !== agentStateValues.current[id]) return;
                  if (event.kind === "done" && currentWorkspace.current?.selectedSession !== id)
                    setUnreadCompletedSessions((previous) => new Set(previous).add(id));
                  if (["idle", "working"].includes(event.kind)) return;
                  if (
                    ["done", "notice"].includes(event.kind) &&
                    currentWorkspace.current?.selectedSession === id
                  )
                    acknowledgeCompletedSession(id);
                  const body =
                    event.kind === "notice"
                      ? tx("会话有新提醒")
                      : event.kind === "waiting"
                        ? tx("需要你处理")
                        : event.kind === "error"
                          ? event.source === "process"
                            ? tx("会话异常退出")
                            : tx("任务执行失败")
                          : event.source === "process"
                            ? tx("会话已结束")
                            : tx("任务已完成");
                  notifyAgentActivity(id, body);
                }}
                onClosed={(id) => {
                  seenAgentEvents.current.delete(id);
                  lastAgentEvent.current.delete(id);
                  pendingAgentNotifications.current.delete(id);
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
      {inspectorVisible && directoryOpen && fileDirectory && !activeSsh && (
        <DirectoryPanel
          key={fileDirectory}
          directory={fileDirectory}
          platform={runtime?.platform ?? ""}
          resizeHandle={resizeHandle}
          headerActions={inspectorActions}
        />
      )}
      {inspectorVisible && filesOpen && activeSsh && (
        <RemoteFiles
          key={sshTargetKey}
          connection={activeSsh}
          directory={remoteDirectories[sshTargetKey]}
          status={remoteFileStates[sshTargetKey]?.status ?? "idle"}
          lastError={remoteFileStates[sshTargetKey]?.error}
          onStatus={(status, error = "") =>
            setRemoteFileStates((previous) => ({
              ...previous,
              [sshTargetKey]: { connectionId: activeSsh.connection_id, status, error },
            }))
          }
          onRoot={(directory) =>
            setRemoteDirectories((previous) => ({ ...previous, [sshTargetKey]: directory }))
          }
          open={(directory, path) => void editor.open(directory, path)}
          beforeMutation={(directory, action) => void editor.closeDirectory(directory, action)}
          resizeHandle={resizeHandle}
          headerActions={inspectorActions}
          newTerminal={() => {
            if (activeSshConnection) newSshTerminal(activeSshConnection);
          }}
        />
      )}
      {inspectorVisible && filesOpen && fileDirectory && !activeSsh && (
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
      {inspectorVisible && githubOpen && selected && (
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
      {inspectorVisible && gitOpen && workspace && !activeSsh && (
        <GitPanel
          resizeHandle={resizeHandle}
          diffTarget={gitDiffTarget}
          expanded={gitExpanded}
          onExpandedChange={changeGitExpanded}
          onDiffPathChange={setGitDiffPath}
          headerActions={inspectorActions}
          key={fileDirectory}
          directory={fileDirectory}
          refreshRevision={repositoryRevision}
          disabled={editor.transitioning || editor.pending}
          beforeMutation={(action) => void editor.closeDirectory(fileDirectory, action)}
          onChanged={() => setRepositoryRevision((value) => value + 1)}
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
                const remove = () => {
                  update((previous) => removeProject(previous, id));
                };
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
