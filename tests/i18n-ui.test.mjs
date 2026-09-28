import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("real settings tabs, commands and panels render in both languages without untranslated UI", async (context) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLDialogElement",
    "Node",
    "Event",
    "MouseEvent",
    "localStorage",
  ])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const { createRoot } = await import("react-dom/client");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const server = await createServer({
    configFile: false,
    ssr: { noExternal: [/^@xterm\//, /^pdfjs-dist/] },
    plugins: [
      {
        name: "test-rendering-adapters",
        enforce: "pre",
        resolveId(id) {
          if (
            [
              "@xterm/xterm",
              "@xterm/addon-search",
              "@xterm/addon-fit",
              "@xterm/addon-web-links",
              "pdfjs-dist",
            ].includes(id)
          )
            return "\0test:" + id;
        },
        load(id) {
          if (id.startsWith("\0test:@xterm/"))
            return "export class Terminal {} export class SearchAddon {} export class FitAddon {} export class WebLinksAddon {}";
          if (id === "\0test:pdfjs-dist")
            return "export const GlobalWorkerOptions = {}; export function getDocument() { throw new Error('PDF loading is not part of markup tests'); }";
        },
      },
    ],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  context.after(async () => {
    await server.close();
    dom.window.close();
  });
  const load = (path) => server.ssrLoadModule(`/src/${path}`);
  const i18n = await load("lib/i18n.ts");
  const { defaults, settingsKey } = await load("lib/settings.ts");
  const { SettingsProvider } = await load("lib/SettingsContext.tsx");
  const { emptyWorkspace } = await load("lib/workspace.ts");
  const { SettingsPanel } = await load("components/SettingsPanel.tsx");
  const { CommandPalette } = await load("components/CommandPalette.tsx");
  const { FilePanel } = await load("components/FilePanel.tsx");
  const { GitPanel } = await load("components/GitPanel.tsx");
  const { GitHubPanel } = await load("components/GitHubPanel.tsx");
  const { DirectoryPanel } = await load("components/DirectoryPanel.tsx");
  const { Sidebar } = await load("components/Sidebar.tsx");
  const { AgentStatusIndicator, SessionIcon } = await load("components/SidebarIcon.tsx");
  const { AgentSettings } = await load("components/AgentPanel.tsx");
  const { FileEditor, UnsavedDialog } = await load("components/FileEditor.tsx");
  const { TerminalView } = await load("components/TerminalView.tsx");
  const { PdfReader } = await load("components/PdfReader.tsx");
  const runtime = {
    platform: "windows",
    architecture: "x86_64",
    version: "0.1.0",
    home: "C:/fixture",
    agents: ["codex"],
    agent_definitions: [],
    debug: true,
    chat_directory: "C:/fixture/chats",
  };
  const noop = () => {};
  const updates = {
    available: { enabled: true, version: "0.2.0" },
    phase: "available",
    error: "",
    progress: { downloaded: 0, total: null },
    check: noop,
    download: noop,
    install: noop,
  };
  const calls = [];
  let autostart = false;
  let autostartFail = false;
  let installFail = false;
  let installedAgent;
  let copiedFiles;
  let copyFail = false;
  mockIPC((cmd, args) => {
    calls.push(cmd);
    if (cmd === "file_copy") {
      copiedFiles = args;
      if (copyFail) throw new Error("无法粘贴：同名文件或目录已存在。");
      return null;
    }
    if (cmd === "files_list")
      return {
        entries: args.path
          ? []
          : [
              { path: "file.txt", name: "file.txt", directory: false, symlink: false },
              { path: "folder", name: "folder", directory: true, symlink: false },
            ],
        partial: false,
        skipped: 0,
      };
    if (cmd === "install_agent") {
      installedAgent = args.agent;
      if (installFail) throw new Error("未找到 npm，请先安装 Node.js，再重启 uTerm 后重试。");
      return true;
    }
    if (cmd === "autostart_configure") {
      if (autostartFail) throw new Error("Access denied");
      if (typeof args.enabled === "boolean") autostart = args.enabled;
      return autostart;
    }
    if (cmd === "control_status")
      return { enabled: true, port: 1234, directory: "C:/fixture", endpoint: "loopback" };
    if (cmd === "directory_tools" || cmd === "github_repositories") return [];
    if (cmd === "git_snapshot") return { changes: [], branches: [], branch: "release" };
    if (cmd === "list_files" || cmd === "file_list")
      return { entries: [], partial: false, skipped: 0 };
    if (cmd === "search_files" || cmd === "file_search")
      return { matches: [], partial: false, skipped: 0 };
    if (cmd === "window_appearance") return null;
    throw new Error(`Unexpected test command: ${cmd}`);
  });
  let root;
  const host = document.getElementById("root");
  async function mount(component, language) {
    if (root) await act(async () => root.unmount());
    localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language }));
    i18n.setUiLanguage(language);
    root = createRoot(host);
    await act(async () => root.render(React.createElement(SettingsProvider, null, component)));
  }
  async function click(text) {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
    assert.ok(button, `Button not found: ${text}`);
    await act(async () => button.click());
  }
  function assertEnglish() {
    const clone = host.cloneNode(true);
    clone.querySelectorAll('option[value="zh-Hans"]').forEach((el) => el.remove());
    assert.doesNotMatch(clone.textContent, /\p{Script=Han}|\[Missing translation\]/u);
    for (const el of clone.querySelectorAll("[title],[aria-label],[placeholder]"))
      for (const attr of ["title", "aria-label", "placeholder"])
        assert.doesNotMatch(el.getAttribute(attr) ?? "", /\p{Script=Han}|\[Missing translation\]/u);
    assert.equal(i18n.missingTranslations.size, 0);
  }
  try {
    await context.test("file list copy/paste targets folders and ignores text inputs", async () => {
      await mount(
        React.createElement(FilePanel, {
          directory: "C:/fixture",
          mode: "tree",
          request: 0,
          setMode: noop,
          open: noop,
          beforeMutation: (action) => action(),
        }),
        "en",
      );
      const file = host.querySelector('[title="file.txt"]');
      await act(async () => file.focus());
      await act(async () =>
        file.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }),
        ),
      );
      const folder = host.querySelector('[title="folder"]');
      await act(async () => folder.focus());
      await act(async () =>
        folder.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }),
        ),
      );
      assert.deepEqual(copiedFiles, {
        directory: "C:/fixture",
        sourceDirectory: "C:/fixture",
        path: "file.txt",
        destination: "folder",
      });
      await act(async () => folder.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
      assert.ok(
        [...host.querySelectorAll('[role="menuitem"]')].some(
          (button) => button.textContent === "Paste" && !button.disabled,
        ),
      );
      assertEnglish();
      copyFail = true;
      await click("Paste");
      assert.ok(host.querySelector('[role="alert"]'));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1800)));
      await act(async () => folder.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
      await click("Paste");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1500)));
      assert.ok(host.querySelector('[role="alert"]'), "Repeated failure restarts the timer");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1600)));
      assert.equal(host.querySelector('[role="alert"]'), null);
      copyFail = false;
      await act(async () => folder.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
      await click("New file");
      const nameInput = host.querySelector("input");
      const countBefore = calls.filter((command) => command === "file_copy").length;
      const pasteKey = new dom.window.KeyboardEvent("keydown", {
        key: "v",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => nameInput.dispatchEvent(pasteKey));
      assert.equal(pasteKey.defaultPrevented, false);
      assert.equal(calls.filter((command) => command === "file_copy").length, countBefore);
      await mount(
        React.createElement(FilePanel, {
          directory: "C:/project-b",
          mode: "tree",
          request: 0,
          setMode: noop,
          open: noop,
          beforeMutation: (action) => action(),
        }),
        "en",
      );
      await act(async () =>
        host
          .querySelector('[title="folder"]')
          .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
      );
      assert.equal(host.querySelector('[role="menuitem"]:nth-child(2)').disabled, false);
      await click("Paste");
      assert.deepEqual(copiedFiles, {
        directory: "C:/project-b",
        sourceDirectory: "C:/fixture",
        path: "file.txt",
        destination: "folder",
      });
    });
    await context.test(
      "built-in agents render distinct local brand marks with safe fallback",
      () => {
        const marks = ["kimi", "opencode", "grok"].map((agent) => {
          const markup = renderToStaticMarkup(React.createElement(SessionIcon, { agent }));
          assert.match(markup, new RegExp(`agent-${agent}`));
          assert.match(markup, /fill="currentColor"/);
          assert.doesNotMatch(markup, /icon-terminal|<image|<img/);
          return markup.match(/ d="([^"]+)"/)[1];
        });
        assert.equal(new Set(marks).size, 3);
        for (const agent of [undefined, "custom", "constructor", "__proto__"])
          assert.match(
            renderToStaticMarkup(React.createElement(SessionIcon, { agent })),
            /icon-terminal/,
          );
      },
    );
    await context.test(
      "agent installation requires confirmation, reports failures and refreshes",
      async () => {
        for (const language of ["en", "zh-Hans"]) {
          let reloads = 0;
          await mount(
            React.createElement(AgentSettings, {
              runtime,
              reload: async () => {
                reloads++;
              },
            }),
            language,
          );
          const section = [...host.querySelectorAll(".agent-definition")].find(
            (el) => el.querySelector("strong").textContent === "OpenCode",
          );
          assert.ok(section);
          const before = calls.filter((cmd) => cmd === "install_agent").length;
          await act(async () => section.querySelector("button").click());
          assert.equal(calls.filter((cmd) => cmd === "install_agent").length, before);
          assert.match(section.textContent, /npm install -g opencode-ai/);
          installFail = true;
          await click(language === "en" ? "Confirm installation" : "确认安装");
          assert.match(host.querySelector('[role="alert"]').textContent, /npm/);
          assert.equal(reloads, 0);
          if (language === "en") assertEnglish();
          installFail = false;
          await click(language === "en" ? "Confirm installation" : "确认安装");
          assert.equal(installedAgent, "opencode");
          assert.equal(reloads, 1);
          assert.ok(host.querySelector('[role="status"]'));
          assert.equal(host.querySelector('[role="alert"]'), null);
          if (language === "en") assertEnglish();
        }
      },
    );
    await context.test(
      "editor, unsaved dialog and terminal chrome render in both languages",
      async () => {
        const file = {
          id: 1,
          directory: "C:/fixture",
          path: "fixture.txt",
          kind: "text",
          text: "fixture",
          saved: "",
          version: "1",
          line_ending: "\n",
          bom: false,
          readonly: false,
          notice: "已恢复未保存的草稿。保存前会检查磁盘版本。",
          jump: 0,
        };
        const editor = {
          document: file,
          saving: false,
          transitioning: false,
          pending: true,
          error: "文件已被其他程序修改。请重新读取，或确认覆盖磁盘版本。",
          conflict: true,
          change: noop,
          save: noop,
          close: noop,
          reload: noop,
          cancel: noop,
          discard: noop,
        };
        const terminal = {
          directory: "C:/fixture",
          session: { id: "fixture", name: "User session" },
          active: true,
          visible: true,
          focusRequest: "",
          closeRequest: 0,
          onFocus: noop,
          onClosed: noop,
          onAgentState: noop,
          onDetectedAgent: noop,
          onPaneDragStart: noop,
          onDragOver: noop,
          onDragLeave: noop,
          onDrop: noop,
        };
        for (const language of ["en", "zh-Hans"]) {
          i18n.setUiLanguage(language);
          localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language }));
          const html = renderToStaticMarkup(
            React.createElement(
              SettingsProvider,
              null,
              React.createElement(
                React.Fragment,
                null,
                React.createElement(FileEditor, { editor }),
                React.createElement(UnsavedDialog, { editor }),
                React.createElement(TerminalView, terminal),
                React.createElement(PdfReader, {
                  document: { ...file, kind: "pdf", path: "fixture.pdf" },
                }),
              ),
            ),
          );
          if (language === "en") {
            assert.doesNotMatch(html, /\p{Script=Han}|\[Missing translation\]/u);
            assert.match(html, /Find\/replace/);
            assert.match(html, /Restart/);
            assert.match(html, /PDF page number/);
            assert.match(html, /Overwrite disk version/);
          } else assert.match(html, /查找\/替换/);
        }
      },
    );
    await context.test("all eight settings tabs and immediate language switching", async () => {
      i18n.setUiLanguage("en");
      await mount(
        React.createElement(SettingsPanel, {
          runtime,
          updates,
          close: noop,
          reloadAgents: async () => {},
          workspace: emptyWorkspace(),
          updateWorkspace: noop,
        }),
        "en",
      );
      assert.match(host.textContent, /Reset interface and terminal settings/);
      const reminderRow = host.querySelector(".break-reminder-settings-row");
      assert.ok(reminderRow.querySelector('[role="switch"]'));
      assert.ok(reminderRow.querySelector('input[type="number"]'));
      assert.equal(reminderRow.querySelector(".muted"), null);
      const startupSwitch = host.querySelector('[role="switch"]');
      assert.equal(startupSwitch.checked, false);
      assert.equal(startupSwitch.disabled, false);
      await act(async () => startupSwitch.click());
      assert.equal(startupSwitch.checked, true);
      assert.equal(autostart, true);
      autostartFail = true;
      await act(async () => startupSwitch.click());
      assert.equal(startupSwitch.checked, true);
      assert.match(host.textContent, /Unable to configure launch at login:.*Access denied/);
      autostartFail = false;
      await act(async () => startupSwitch.click());
      assert.equal(startupSwitch.checked, false);
      assert.equal(autostart, false);
      const originalDialog = host.querySelector("dialog");
      const select = host.querySelector("select");
      await act(async () => {
        select.value = "zh-Hans";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      assert.match(host.textContent, /恢复界面与终端默认设置/);
      await act(async () => {
        select.value = "en";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      assert.equal(host.querySelector("dialog"), originalDialog);
      for (const tab of [
        "General",
        "Appearance",
        "Terminal",
        "Workspace",
        "Keyboard shortcuts",
        "Agents & usage",
        "Local control",
        "Software update",
      ]) {
        await click(tab);
        assertEnglish();
      }
      await mount(
        React.createElement(SettingsPanel, {
          runtime,
          updates: {
            ...updates,
            phase: "ready",
            progress: { downloaded: 1992294, total: null },
          },
          close: noop,
          reloadAgents: async () => {},
          workspace: emptyWorkspace(),
          updateWorkspace: noop,
        }),
        "en",
      );
      await click("Software update");
      const downloadProgress = host.querySelector(".update-download-progress");
      assert.ok(downloadProgress);
      assert.equal(downloadProgress.firstElementChild.tagName, "PROGRESS");
      assert.equal(downloadProgress.firstElementChild.max, 1992294);
      assert.equal(downloadProgress.firstElementChild.value, 1992294);
      assert.match(downloadProgress.textContent, /Downloaded 1.9 MB/);
      assert.match(host.textContent, /Update downloaded and signature verified/);
      assert.equal(JSON.parse(localStorage.getItem(settingsKey)).language, "en");
    });
    await context.test("command palette uses translated command labels", async () => {
      await mount(
        React.createElement(CommandPalette, {
          mac: false,
          available: () => true,
          run: noop,
          close: noop,
        }),
        "en",
      );
      assertEnglish();
      assert.match(host.textContent, /Quick open file/);
      await act(async () => i18n.setUiLanguage("zh-Hans"));
      assert.match(host.textContent, /快速打开文件/);
    });
    for (const [name, component] of [
      [
        "files",
        React.createElement(FilePanel, {
          resizeHandle: null,
          headerActions: null,
          directory: "C:/fixture",
          mode: "tree",
          request: 0,
          setMode: noop,
          open: noop,
          beforeMutation: noop,
        }),
      ],
      [
        "git",
        React.createElement(GitPanel, {
          resizeHandle: null,
          headerActions: null,
          directory: "C:/fixture",
          expanded: false,
          onExpandedChange: noop,
        }),
      ],
      [
        "github",
        React.createElement(GitHubPanel, {
          resizeHandle: null,
          headerActions: null,
          directory: "C:/fixture",
          associate: noop,
          canAssociate: false,
          insert: async () => {},
          canInsert: false,
          createSession: noop,
        }),
      ],
      [
        "directory",
        React.createElement(DirectoryPanel, {
          resizeHandle: null,
          headerActions: null,
          directory: "C:/fixture",
          platform: "windows",
        }),
      ],
      [
        "sidebar",
        React.createElement(Sidebar, {
          visible: true,
          toggleVisibility: noop,
          closeSession: noop,
          workspace: {
            ...emptyWorkspace(),
            groups: [{ ...emptyWorkspace().groups[0], name: "User workspace" }],
          },
          runtime,
          update: noop,
          focus: noop,
          menu: noop,
          addProject: noop,
          newWorkspace: noop,
          renameWorkspace: noop,
          addLoose: noop,
          addSession: noop,
          agentStates: {},
          detectedAgents: {},
          unreadCompletedSessions: new Set(),
          onSessionViewed: noop,
          onActivitySession: noop,
          footerActions: null,
        }),
      ],
      ["agent status", React.createElement(AgentStatusIndicator, { state: "waiting" })],
    ])
      await context.test(name, async () => {
        await mount(component, "en");
        assertEnglish();
        await act(async () => i18n.setUiLanguage("zh-Hans"));
        assert.match(
          host.textContent +
            [...host.querySelectorAll("[aria-label]")]
              .map((e) => e.getAttribute("aria-label"))
              .join(""),
          /\p{Script=Han}/u,
        );
      });
    assert.ok(calls.includes("control_status"));
  } finally {
    if (root) await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
