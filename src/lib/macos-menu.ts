import type { MenuItemOptions, PredefinedMenuItemOptions } from "@tauri-apps/api/menu";
import { activeLanguage, translate } from "./i18n.ts";
import { binding, commands } from "./settings.ts";
import type { CommandId, Settings } from "./settings.ts";
import { sessionRosters } from "./workspace.ts";
import type { Workspace } from "./workspace.ts";

export type MacosMenuEntry =
  PredefinedMenuItemOptions | (MenuItemOptions & { checked?: boolean }) | MacosSubmenu;

interface MacosSubmenu {
  id: string;
  text: string;
  enabled?: boolean;
  items: MacosMenuEntry[];
}

export interface MacosMenuState {
  settings: Settings;
  workspace: Workspace | null;
  version: string;
  enabled: Partial<Record<CommandId, boolean>>;
  checked: Partial<Record<CommandId, boolean>>;
  navigationEnabled: boolean;
  closeLabel: string;
}

/** Builds localized native menus from the current application state. / 根据当前应用状态生成本地化原生菜单。 */
export function buildMacosMenu(state: MacosMenuState) {
  const { settings, workspace, enabled, checked, navigationEnabled } = state;
  const language = activeLanguage(settings.language);
  const t = (key: string) => translate(language, key);
  const separator = (): PredefinedMenuItemOptions => ({ item: "Separator" });
  const native = (
    item: PredefinedMenuItemOptions["item"],
    label: string,
  ): PredefinedMenuItemOptions => ({ item, text: label });
  const submenu = (id: string, text: string, items: MacosMenuEntry[]): MacosSubmenu => ({
    id,
    // macOS check items preserve ampersands, while submenu titles parse mnemonics.
    // macOS 勾选项保留 &，子菜单标题仍会解析助记符。
    text: text.replaceAll("&", "&&"),
    items,
  });
  const action = (id: string, label: string, available = navigationEnabled) => ({
    id: `app-menu:${id}`,
    text: label,
    enabled: available,
  });
  const command = (id: CommandId, label?: string): MacosMenuEntry => ({
    id: `app-menu:command:${id}`,
    text: label ?? t(commands.find(([key]) => key === id)![1]),
    enabled: enabled[id] ?? false,
    accelerator: binding(settings, id, true).replace(/^Mod\+/, "Cmd+") || undefined,
    ...(checked[id] === undefined ? {} : { checked: checked[id] }),
  });
  const menuText = (value: string) => value.replace(/[\r\n\t]/g, " ");
  const sessionGroups = (workspace?.groups ?? []).flatMap((group) => {
    const rosters = sessionRosters(workspace!).filter(
      (roster) => roster.workspaceId === group.id && roster.sessions.length,
    );
    if (!rosters.length) return [];
    return [
      submenu(
        `app-menu-sessions:${group.id}`,
        menuText(group.name),
        rosters.map((roster) => {
          const project = workspace!.projects.find((item) => item.id === roster.projectId);
          const title =
            project?.name ??
            roster.connection?.name ??
            t(roster.kind === "chats" ? "Agent 对话" : "终端");
          return submenu(
            `app-menu-roster:${roster.id}`,
            menuText(title),
            roster.sessions.map((session) => {
              const worktree = project?.worktrees?.find((item) => item.id === session.worktreeId);
              return {
                id: `app-menu:session:${session.id}`,
                text: menuText(worktree ? `${worktree.name} — ${session.name}` : session.name),
                enabled: navigationEnabled,
                checked: session.id === workspace!.selectedSession,
              };
            }),
          );
        }),
      ),
    ];
  });
  const switchSessions = submenu(
    "app-menu-sessions",
    t("切换会话"),
    sessionGroups.length ? sessionGroups : [{ text: t("没有可切换的会话"), enabled: false }],
  );

  return {
    id: "uterm-app-menu",
    items: [
      submenu("app-menu-app", "uTerm", [
        native({ About: { name: "uTerm", version: state.version } }, t("关于 uTerm")),
        separator(),
        command("settings"),
        command("agents"),
        separator(),
        native("Services", t("服务")),
        separator(),
        native("Hide", t("隐藏 uTerm")),
        native("HideOthers", t("隐藏其他应用")),
        native("ShowAll", t("显示全部")),
        separator(),
        { id: "editor-quit", text: t("退出 uTerm"), accelerator: "Cmd+Q" },
      ]),
      submenu("app-menu-file", language === "en" ? "File" : t("文件"), [
        command("project"),
        command("terminal"),
        command("chat"),
        separator(),
        command("quick"),
        command("close", state.closeLabel),
        separator(),
        { id: "desktop-window-close", text: t("关闭窗口") },
      ]),
      submenu("app-menu-edit", t("编辑"), [
        native("Undo", t("撤销")),
        native("Redo", t("重做")),
        separator(),
        native("Cut", t("剪切")),
        native("Copy", t("复制")),
        native("Paste", t("粘贴")),
        native("SelectAll", t("全选")),
      ]),
      submenu("app-menu-view", language === "en" ? "View" : t("视图"), [
        command("palette"),
        separator(),
        command("toggleSidebar"),
        command("toggleInspector"),
        command("files"),
        command("git"),
        command("github"),
        command("swapPanes"),
        separator(),
        command("search"),
      ]),
      submenu("app-menu-session", t("会话"), [
        command("previous"),
        command("next"),
        switchSessions,
        separator(),
        command("splitRight"),
        command("splitDown"),
        command("zoom"),
        command("ungroup"),
        submenu("app-menu-focus", t("聚焦窗格"), [
          command("left"),
          command("right"),
          command("up"),
          command("down"),
        ]),
        separator(),
        command("terminalSearch"),
        command("link"),
      ]),
      submenu("app-menu-workspace", t("工作区"), [
        action("new-workspace", t("新建工作区…")),
        separator(),
        ...(workspace?.groups ?? []).map((group) => ({
          id: `app-menu:workspace:${group.id}`,
          text: menuText(group.name),
          enabled: navigationEnabled,
          checked: group.id === workspace?.selectedWorkspace,
        })),
      ]),
      submenu("app-menu-window", t("窗口"), [
        native("Minimize", t("最小化")),
        native("Maximize", t("缩放窗口")),
        native("Fullscreen", t("切换全屏")),
        separator(),
        native("BringAllToFront", t("前置全部窗口")),
      ]),
      submenu("app-menu-help", t("帮助"), [
        action("guide", t("功能指南"), true),
        action("website", t("uTerm 官网"), true),
        action("issues", t("反馈问题"), true),
      ]),
    ],
  };
}
