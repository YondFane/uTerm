import test from "node:test";
import assert from "node:assert/strict";
import { buildMacosMenu } from "../src/lib/macos-menu.ts";
import { commands, defaults } from "../src/lib/settings.ts";
import { createWorkspaceGroup, emptyWorkspace } from "../src/lib/workspace.ts";
import { translate } from "../src/lib/i18n.ts";

function fixture(language = "en") {
  const workspace = emptyWorkspace();
  workspace.groups[0].name = "Build & inspect";
  workspace.groups[0].terminals = [{ id: "terminal", name: "Local shell", shell: "default" }];
  const other = createWorkspaceGroup("other", "Other");
  other.chats = [{ id: "chat", name: "Agent", agent: "codex", shell: "default" }];
  other.sshConnections = [
    {
      id: "ssh",
      name: "Remote",
      host: "example.invalid",
      os: "posix",
      root: "",
      sessions: [{ id: "ssh-session", name: "Remote shell", shell: "default" }],
    },
  ];
  workspace.groups.push(other);
  workspace.projects = [
    {
      id: "project",
      name: "Project",
      workspaceId: "other",
      directory: "/qa/project",
      worktrees: [{ id: "worktree", name: "Feature", path: "/qa/worktree", branch: "feature" }],
      sessions: [
        { id: "session", name: "Shell & tools\nnext", shell: "default", worktreeId: "worktree" },
      ],
    },
  ];
  workspace.selectedWorkspace = "other";
  workspace.selectedProject = "project";
  workspace.selectedSession = "session";
  return {
    workspace,
    settings: { ...defaults, language },
    version: "0.1.30",
    enabled: Object.fromEntries(commands.map(([id]) => [id, true])),
    checked: { toggleSidebar: true, toggleInspector: false },
    navigationEnabled: true,
    closeLabel: translate(language, "关闭会话"),
  };
}

function entries(menu) {
  return menu.items.flatMap((item) => [item, ...(item.items ? entries(item) : [])]);
}
const find = (menu, id) => entries(menu).find((item) => item.id === id);

test("native menus localize every application label and retain guarded quit/window actions", () => {
  for (const language of ["en", "zh-Hans"]) {
    const menu = buildMacosMenu(fixture(language));
    assert.deepEqual(
      menu.items.map((item) => item.text),
      language === "en"
        ? ["uTerm", "File", "Edit", "View", "Session", "Workspace", "Window", "Help"]
        : ["uTerm", "文件", "编辑", "视图", "会话", "工作区", "窗口", "帮助"],
    );
    assert.ok(entries(menu).every((item) => !item.text?.includes("[Missing translation]")));
    if (language === "en")
      assert.ok(entries(menu).every((item) => !/\p{Script=Han}/u.test(item.text ?? "")));
    assert.equal(find(menu, "editor-quit").accelerator, "Cmd+Q");
    assert.equal(find(menu, "desktop-window-close").accelerator, undefined);
    assert.ok(!entries(menu).some((item) => ["Quit", "CloseWindow"].includes(item.item)));
    assert.equal(find(menu, "app-menu:command:settings").accelerator, "Cmd+Comma");
    assert.equal(find(menu, "app-menu-app").items[0].item.About.version, "0.1.30");
  }
});

test("native session/workspace targets preserve IDs, worktrees, SSH and literal names", () => {
  const state = fixture();
  const original = JSON.stringify(state.workspace);
  const menu = buildMacosMenu(state);
  assert.equal(find(menu, "app-menu:workspace:other").checked, true);
  assert.equal(find(menu, "app-menu:workspace:local").checked, false);
  assert.equal(find(menu, "app-menu:workspace:local").text, "Build & inspect");
  assert.equal(find(menu, "app-menu-sessions:local").text, "Build && inspect");
  assert.equal(find(menu, "app-menu:session:session").text, "Feature — Shell & tools next");
  assert.equal(find(menu, "app-menu:session:session").checked, true);
  for (const id of ["terminal", "chat", "ssh-session"]) {
    assert.equal(find(menu, `app-menu:session:${id}`).enabled, true);
    assert.equal(find(menu, `app-menu:session:${id}`).checked, false);
  }
  assert.equal(find(menu, "app-menu-roster:ssh:ssh").text, "Remote");
  assert.equal(JSON.stringify(state.workspace), original);
});

test("native command availability, panel checks and customized/disabled shortcuts stay aligned", () => {
  const state = fixture();
  state.settings.shortcuts = {
    toggleSidebar: "Mod+Alt+KeyL",
    next: "",
    terminal: "Mod+Shift+Digit7",
  };
  state.enabled.close = false;
  state.navigationEnabled = false;
  const menu = buildMacosMenu(state);
  assert.equal(find(menu, "app-menu:command:toggleSidebar").accelerator, "Cmd+Alt+KeyL");
  assert.equal(find(menu, "app-menu:command:toggleSidebar").checked, true);
  assert.equal(find(menu, "app-menu:command:toggleInspector").checked, false);
  assert.equal(find(menu, "app-menu:command:terminal").accelerator, "Cmd+Shift+Digit7");
  assert.equal(find(menu, "app-menu:command:next").accelerator, undefined);
  assert.equal(find(menu, "app-menu:command:close").enabled, false);
  assert.equal(find(menu, "app-menu:workspace:other").enabled, false);
  assert.equal(find(menu, "app-menu:session:session").enabled, false);
  assert.equal(find(menu, "app-menu:new-workspace").enabled, false);
  assert.equal(find(menu, "app-menu:guide").enabled, true);
  const empty = buildMacosMenu({ ...state, workspace: emptyWorkspace() });
  assert.equal(find(empty, "app-menu-sessions").items[0].enabled, false);
});
