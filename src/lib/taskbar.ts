import { activeLanguage, translate } from "./i18n.ts";
import type { LanguagePreference } from "./i18n.ts";
import type { SessionConfig, Workspace, WorkspaceGroup } from "./workspace.ts";

export type TaskbarTaskState = "working" | "waiting" | "done" | "error";
export type TaskbarStatus = "idle" | "working" | "done" | "attention";

export interface TaskbarTask {
  id: string;
  title: string;
  state: TaskbarTaskState;
}

export interface TaskbarGroup {
  title: string;
  tasks: TaskbarTask[];
}

export interface TaskbarLabels {
  open: string;
  empty: string;
  quit: string;
  idle: string;
  working: string;
  needsYou: string;
  done: string;
  exited: string;
}

export interface TaskbarSnapshot {
  status: TaskbarStatus;
  labels: TaskbarLabels;
  groups: TaskbarGroup[];
}

const taskStates = new Set<TaskbarTaskState>(["working", "waiting", "done", "error"]);

function priority(state: TaskbarTaskState) {
  if (state === "waiting" || state === "error") return 0;
  if (state === "done") return 1;
  return 2;
}

function tasks(
  sessions: SessionConfig[],
  agentStates: Record<string, string>,
  detectedAgents: Record<string, string>,
  unreadDoneIds?: ReadonlySet<string>,
) {
  return sessions
    .map((session, index) => ({
      session,
      index,
      state: taskStates.has(agentStates[session.id] as TaskbarTaskState)
        ? (agentStates[session.id] as TaskbarTaskState)
        : detectedAgents[session.id]
          ? ("working" as const)
          : undefined,
    }))
    .filter(
      (item) =>
        !!item.state &&
        (item.state !== "done" || !unreadDoneIds || unreadDoneIds.has(item.session.id)),
    )
    .sort(
      (left, right) => priority(left.state!) - priority(right.state!) || left.index - right.index,
    )
    .map(({ session, state }) => ({ id: session.id, title: session.name, state: state! }));
}

function groupTitle(workspace: WorkspaceGroup, title: string, multiple: boolean) {
  return multiple ? `${workspace.name} — ${title}` : title;
}

export function buildTaskbarSnapshot(
  workspace: Workspace,
  agentStates: Record<string, string>,
  detectedAgents: Record<string, string>,
  preference: LanguagePreference,
  preferredLanguages?: readonly string[],
  unreadDoneIds?: ReadonlySet<string>,
): TaskbarSnapshot {
  const language = activeLanguage(preference, preferredLanguages);
  const t = (key: string) => translate(language, key);
  const groups: TaskbarGroup[] = [];
  const workspaces = workspace.groups ?? [];
  const multiple = workspaces.length > 1;

  for (const owner of workspaces) {
    for (const [title, sessions] of [
      [t("终端"), owner.terminals ?? []],
      [t("Agent 对话"), owner.chats ?? []],
    ] as const) {
      const entries = tasks(sessions, agentStates, detectedAgents, unreadDoneIds);
      if (entries.length)
        groups.push({ title: groupTitle(owner, title, multiple), tasks: entries });
    }
    for (const project of workspace.projects.filter(
      (item) => (item.workspaceId ?? "local") === owner.id,
    )) {
      const entries = tasks(project.sessions, agentStates, detectedAgents, unreadDoneIds);
      if (entries.length)
        groups.push({ title: groupTitle(owner, project.name, multiple), tasks: entries });
    }
  }

  const states = groups.flatMap((group) => group.tasks.map((task) => task.state));
  const status: TaskbarStatus = states.some((state) => state === "waiting" || state === "error")
    ? "attention"
    : states.includes("done")
      ? "done"
      : states.includes("working")
        ? "working"
        : "idle";
  return {
    status,
    labels: {
      open: t("打开 uTerm"),
      empty: t("全部处理完毕"),
      quit: t("退出 uTerm"),
      idle: t("空闲"),
      working: t("工作中"),
      needsYou: t("需要你"),
      done: t("已完成"),
      exited: t("已退出"),
    },
    groups,
  };
}

export function taskbarSnapshotSignature(snapshot: TaskbarSnapshot) {
  return JSON.stringify(snapshot);
}
