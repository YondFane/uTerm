import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

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
    server: { middlewareMode: true, watch: null },
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
  const openedUrls = [];
  const hookCalls = [];
  let autostart = false;
  let autostartFail = false;
  let installFail = false;
  let installedAgent;
  let copiedFiles;
  let copyFail = false;
  const usageReads = [];
  mockIPC(
    (cmd, args) => {
      calls.push(cmd);
      if (cmd === "agent_hooks") {
        hookCalls.push(args);
        return args.enabled
          ? "Hooks 已安装。新会话生效；原配置已备份。"
          : "Hooks 已移除。新会话生效；原配置已备份。";
      }
      if (cmd === "open_external") {
        openedUrls.push(args.url);
        return null;
      }
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
      if (cmd === "agent_usage") {
        usageReads.push(args.agent);
        return {
          input: args.agent === "codex" ? 222 : 111,
          output: 20,
          cache_read: 30,
          cache_write: 40,
          records: 1,
          partial: args.agent === "codex",
          notice: null,
          windows: [{ label: "主要额度", percent: 25 }],
        };
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
    },
    { shouldMockEvents: true },
  );
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
      "built-in agents render distinct bundled brand icons and preserve safe fallback",
      () => {
        const marks = [
          "kimi",
          "opencode",
          "grok",
          "hermes",
          "pi",
          "minimax",
          "qwen",
          "copilot",
          "trae",
        ].map((agent) => {
          const markup = renderToStaticMarkup(React.createElement(SessionIcon, { agent }));
          assert.match(markup, new RegExp(`agent-${agent}`));
          assert.match(markup, /fill="currentColor"/);
          assert.doesNotMatch(markup, /icon-terminal|<image|<img/);
          return markup.match(/ d="([^"]+)"/)[1];
        });
        assert.equal(new Set(marks).size, 9);
        const iflow = renderToStaticMarkup(React.createElement(SessionIcon, { agent: "iflow" }));
        assert.match(iflow, /agent-iflow/);
        assert.match(iflow, /<img[^>]+src="[^\"]*iflow.png"/);
        assert.doesNotMatch(iflow, /https?:/);
        for (const agent of [undefined, "custom", "constructor", "__proto__"])
          assert.match(
            renderToStaticMarkup(React.createElement(SessionIcon, { agent })),
            /icon-terminal/,
          );
      },
    );
    await context.test(
      "Agent catalog searches names and commands and filters availability and enabled entries",
      async () => {
        for (const language of ["en", "zh-Hans"]) {
          await mount(
            React.createElement(AgentSettings, { runtime, reload: async () => {} }),
            language,
          );
          assert.equal(host.querySelectorAll(".agent-definition").length, 1);
          assert.equal(host.querySelector(".agent-definition strong").textContent, "Codex");
          const search = host.querySelector('input[type="search"]');
          const filter = host.querySelector(".agent-catalog-toolbar select");
          const rows = () =>
            [...host.querySelectorAll(".agent-list-name")].map((node) => node.textContent);
          const change = async (element, value) => {
            const prototype =
              element.tagName === "INPUT"
                ? dom.window.HTMLInputElement.prototype
                : dom.window.HTMLSelectElement.prototype;
            await act(async () => {
              Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
              element.dispatchEvent(
                new dom.window.Event(element.tagName === "INPUT" ? "input" : "change", {
                  bubbles: true,
                }),
              );
            });
          };
          await change(search, " MCODE ");
          assert.deepEqual(rows(), ["MiniMax"]);
          assert.equal(host.querySelector(".agent-definition strong").textContent, "MiniMax");
          await change(search, "missing-agent");
          assert.deepEqual(rows(), []);
          assert.equal(host.querySelector(".agent-definition"), null);
          assert.match(host.textContent, language === "en" ? /No matching items/ : /没有匹配/);
          await change(search, "");
          await change(filter, "available");
          assert.deepEqual(rows(), ["Codex"]);
          await change(filter, "enabled");
          assert.deepEqual(rows(), []);
          await change(filter, "all");
          await act(async () =>
            host.querySelector('input[role="switch"][aria-label$=" Codex"]').click(),
          );
          await change(filter, "enabled");
          assert.deepEqual(rows(), ["Codex"]);
          await act(async () => host.querySelector('input[role="switch"]').click());
          assert.deepEqual(rows(), []);
          if (language === "en") assertEnglish();
        }
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
          await click("OpenCode");
          const section = host.querySelector(".agent-definition");
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
      "additional agents use verified installers and MiniMax edits the mcode command",
      async () => {
        for (const language of ["en", "zh-Hans"]) {
          for (const [id, name, packageName, url] of [
            ["pi", "Pi", "@earendil-works/pi-coding-agent", "https://pi.dev/"],
            [
              "qwen",
              "Qwen Code",
              "@qwen-code/qwen-code",
              "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/",
            ],
            [
              "copilot",
              "Copilot CLI",
              "@github/copilot",
              "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
            ],
            ["iflow", "iFlow CLI", "@iflow-ai/iflow-cli", "https://docs.iflow.cn/cli/quickstart/"],
            ["trae", "TRAE CLI", null, "https://docs.trae.cn/cli_get-started-with-trae-cli-2"],
            [
              "hermes",
              "Hermes",
              null,
              "https://hermes-agent.nousresearch.com/docs/getting-started/installation/",
            ],
            [
              "minimax",
              "MiniMax",
              "@minimax-ai/code",
              "https://agent.minimax.io/docs/cli/quick-start",
            ],
          ]) {
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
            await click(name);
            const section = host.querySelector(".agent-definition");
            assert.ok(section, name);
            assert.equal(
              host.querySelector(
                `input[aria-label="${language === "en" ? "Enable" : "启用"} ${name}"]`,
              ).disabled,
              true,
            );
            assert.equal(
              section.querySelectorAll("button").length,
              id === "trae" ? 2 : id === "hermes" ? 3 : 4,
            );
            await act(async () => section.querySelector("button").click());
            await click(language === "en" ? "Official installation guide" : "官方安装说明");
            assert.equal(openedUrls.at(-1), url);
            if (packageName || id === "hermes" || id === "trae") {
              if (packageName)
                assert.equal(
                  section.querySelector(".agent-editor code").textContent,
                  `npm install -g ${packageName}${id === "minimax" ? " --ignore-scripts=false --include=optional --allow-scripts=@minimax-ai/code,better-sqlite3" : ""}`,
                );
              else
                assert.match(
                  section.textContent,
                  language === "en" ? /official installer/ : /官方安装脚本/,
                );
              await click(language === "en" ? "Confirm installation" : "确认安装");
              assert.equal(installedAgent, id);
              assert.equal(reloads, 1);
            } else {
              assert.equal(section.querySelector(".agent-editor code"), null);
              assert.equal(
                [...section.querySelectorAll("button")].some((button) =>
                  ["Confirm installation", "确认安装"].includes(button.textContent),
                ),
                false,
              );
            }
            await act(async () =>
              [...section.querySelectorAll("button")]
                .find((button) => button.textContent === (language === "en" ? "Configure" : "配置"))
                .click(),
            );
            assert.equal(
              host.querySelectorAll("form input")[2].value,
              id === "minimax" ? "mcode" : id === "trae" ? "traecli" : id,
            );
            if (id === "hermes") {
              await click(language === "en" ? "Hook setup guide" : "Hook 配置说明");
              assert.equal(
                openedUrls.at(-1),
                "https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks/",
              );
            } else if (id !== "trae") {
              for (const enabled of [true, false]) {
                const label = enabled
                  ? language === "en"
                    ? "Install hooks"
                    : "安装 Hooks"
                  : language === "en"
                    ? "Remove hooks"
                    : "移除 Hooks";
                await act(async () =>
                  [...section.querySelectorAll("button")]
                    .find((button) => button.textContent === label)
                    .click(),
                );
                assert.deepEqual(hookCalls.at(-1), { agent: id, enabled });
                assert.ok(host.querySelector('[role="status"]'));
              }
            }
            if (language === "en") assertEnglish();
          }
        }
      },
    );
    await context.test("custom Agent identifiers cannot inherit built-in metadata", async () => {
      for (const id of ["constructor", "__proto__", "toString"]) {
        await mount(
          React.createElement(AgentSettings, {
            runtime: {
              ...runtime,
              agent_definitions: [{ id, name: `Custom ${id}`, program: "custom", arguments: [] }],
            },
            reload: async () => {},
          }),
          "en",
        );
        await click(`Custom ${id}`);
        const section = host.querySelector(".agent-definition");
        assert.ok(
          [...section.querySelectorAll("button")].some(
            (button) => button.textContent === "Remove configuration",
          ),
        );
        await act(async () => section.querySelector("button").click());
        assert.equal(
          [...section.querySelectorAll("button")].some(
            (button) => button.textContent === "Official installation guide",
          ),
          false,
        );
        assert.equal(
          [...section.querySelectorAll("button")].some(
            (button) => button.textContent === "Confirm installation",
          ),
          false,
        );
      }
    });
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
    await context.test(
      "content font controls persist independently, retain values on failure and reset",
      async () => {
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
        await click("Appearance");
        const input = (label) =>
          [...host.querySelectorAll("label")]
            .find((row) => row.textContent.trim() === label)
            .querySelector("input");
        const update = async (label, value) => {
          await act(async () => {
            const control = input(label);
            control.value = String(value);
            control.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
          });
        };
        await update("File font size", 20);
        await update("Git diff font size", 32);
        let saved = JSON.parse(localStorage.getItem(settingsKey));
        assert.equal(saved.fileFontSize, 20);
        assert.equal(saved.gitDiffFontSize, 32);
        assert.equal(saved.fontSize, defaults.fontSize);
        assert.equal(document.documentElement.style.getPropertyValue("--file-font-size"), "20px");
        assert.equal(
          document.documentElement.style.getPropertyValue("--git-diff-font-size"),
          "32px",
        );
        await update("File font size", 20.5);
        assert.match(host.textContent, /Settings are invalid/);
        assert.equal(JSON.parse(localStorage.getItem(settingsKey)).fileFontSize, 20);
        const originalSet = dom.window.Storage.prototype.setItem;
        dom.window.Storage.prototype.setItem = () => {
          throw new Error("Storage full");
        };
        try {
          await update("Git diff font size", 18);
          assert.match(host.textContent, /Storage full/);
          assert.equal(
            document.documentElement.style.getPropertyValue("--git-diff-font-size"),
            "32px",
          );
        } finally {
          dom.window.Storage.prototype.setItem = originalSet;
        }
        await click("General");
        await click("Reset interface and terminal settings");
        saved = JSON.parse(localStorage.getItem(settingsKey));
        assert.equal(saved.fileFontSize, 14);
        assert.equal(saved.gitDiffFontSize, 14);
        await click("Appearance");
        assertEnglish();
        await act(async () => i18n.setUiLanguage("zh-Hans"));
        assert.match(host.textContent, /文件查看字号/);
        assert.match(host.textContent, /Git 对比字号/);
      },
    );
    await context.test("all nine settings tabs and immediate language switching", async () => {
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
      await act(async () => emit("autostart-changed", true));
      assert.doesNotMatch(host.textContent, /Access denied/);
      await act(async () => startupSwitch.click());
      assert.equal(startupSwitch.checked, false);
      assert.equal(autostart, false);
      await act(async () => emit("autostart-changed", true));
      assert.equal(startupSwitch.checked, true);
      await act(async () => emit("autostart-changed", false));
      assert.equal(startupSwitch.checked, false);
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
        "Agent",
        "Usage",
        "Local control",
        "Software update",
      ]) {
        await click(tab);
        assert.equal(
          host.textContent.includes("Reset interface and terminal settings"),
          tab === "General",
        );
        assertEnglish();
      }
      await click("Agent");
      assert.equal(
        [...host.querySelectorAll("button")].some((button) => button.textContent === "Read usage"),
        false,
      );
      usageReads.length = 0;
      await click("Usage");
      const agentTabs = host.querySelectorAll('.usage-agent-tabs [role="tab"]');
      assert.equal(agentTabs.length, 4);
      assert.equal(agentTabs[0].textContent.trim(), "Claude");
      assert.equal(agentTabs[0].getAttribute("aria-selected"), "true");
      assert.equal(host.textContent.includes("Select an Agent to read usage"), false);
      assert.equal(host.textContent.includes("Fetch provider quotas"), false);
      assert.equal(host.textContent.includes("Reset interface and terminal settings"), false);
      assert.equal(
        [...host.querySelectorAll("button")].some((button) => button.textContent === "Read usage"),
        false,
      );
      const usageInterval = [...host.querySelectorAll("label")]
        .find((label) => label.textContent.includes("Usage query interval (seconds)"))
        ?.querySelector('input[type="number"]');
      assert.ok(usageInterval);
      assert.equal(usageInterval.value, "60");
      assert.equal(usageInterval.min, "10");
      assert.equal(usageInterval.max, "3600");
      await act(async () => {
        usageInterval.value = "30";
        usageInterval.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
      });
      assert.equal(JSON.parse(localStorage.getItem(settingsKey)).usageRefreshInterval, 30);
      assert.match(host.textContent, /Claude · Past 7 days/);
      assert.match(host.textContent, /111/);
      await click("Codex");
      assert.match(host.textContent, /Codex · Past 7 days/);
      assert.match(host.textContent, /222/);
      assert.match(host.textContent, /The current totals include only readable log records\./);
      assert.equal(host.querySelector(".agent-usage progress").value, 25);
      await act(async () => i18n.setUiLanguage("zh-Hans"));
      assert.match(host.textContent, /当前统计仅包含可读取的日志记录。/);
      await act(async () => i18n.setUiLanguage("en"));
      await click("Claude");
      assert.match(host.textContent, /Claude · Past 7 days/);
      assert.match(host.textContent, /111/);
      assert.doesNotMatch(
        host.textContent,
        /The current totals include only readable log records\./,
      );
      assert.deepEqual(usageReads, ["claude", "codex", "claude"]);
      await mount(
        React.createElement(SettingsPanel, {
          runtime,
          updates: {
            ...updates,
            phase: "ready",
            available: {
              ...updates.available,
              enabled: true,
              notes: "## 中文\n\n- 清晰列表\n\n## English\n\n- Clear list\n<script>bad()</script>",
            },
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
      assert.ok(
        [...host.querySelectorAll("button")].some(
          (button) => button.textContent === "Download installer manually",
        ),
      );
      const downloadProgress = host.querySelector(".update-download-progress");
      assert.ok(downloadProgress);
      assert.equal(downloadProgress.firstElementChild.tagName, "PROGRESS");
      assert.equal(downloadProgress.firstElementChild.max, 1992294);
      assert.equal(downloadProgress.firstElementChild.value, 1992294);
      assert.match(downloadProgress.textContent, /Downloaded 1.9 MB/);
      assert.match(host.textContent, /Update downloaded and signature verified/);
      await click("Download installer manually");
      assert.equal(openedUrls.at(-1), "https://github.com/YondFane/uTerm/releases/latest");
      const notes = host.querySelector(".update-release-notes");
      assert.equal(notes.querySelectorAll("h2").length, 2);
      assert.equal(notes.querySelectorAll("li").length, 2);
      assert.equal(notes.querySelector("script"), null);
      const install = [...host.querySelectorAll("button")].find(
        (button) => button.textContent === "Install and restart",
      );
      assert.ok(
        install.compareDocumentPosition(notes) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      );
      assert.ok(
        downloadProgress.compareDocumentPosition(notes) &
          dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      );
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
