import { chromeContractSHA256 } from "../lib/chrome.generated";
import fontManifest from "../assets/fonts/manifest.json" with { type: "json" };
import chrome from "../../shared/contracts/chrome-ui-v1.json" with { type: "json" };
import { translate } from "../lib/i18n";
import parityFixtureJSON from "../../shared/fixtures/client-ui-parity.json?raw";
import editorFixtureJSON from "../../shared/fixtures/editor-draft-qa.json?raw";
import gitFixtureJSON from "../../shared/fixtures/git-qa.json?raw";
import previewFixtureJSON from "../../shared/fixtures/content-preview-qa.json?raw";
import sshFixtureJSON from "../../shared/fixtures/ssh-qa.json?raw";
import { invoke } from "@tauri-apps/api/core";
import { terminalPerformanceSnapshot } from "../lib/terminal-performance-qa";
import { coreRequest, flushSharedState } from "../lib/shared-state";
import { defaults, settingsKey } from "../lib/settings";
import { emptyWorkspace, workspaceKey, type Workspace } from "../lib/workspace";
import { clipboardPath, draftKey } from "../lib/file-document";
import { editorDraftReceiptKey } from "../lib/editor-draft-handoff";
import { ContentScope } from "../lib/content-transport";
import { tauriContentPort } from "../lib/tauri-content";
import { runRedis } from "./redis";
import { runDatabase } from "./database";
import { databaseNames } from "../lib/database";
import { runAgents } from "./agents";
import { performanceSettings, runPerformance } from "./performance";
import { runUpdates } from "./updates";
import type {
  CoreEditorDraftEntry,
  CoreFileDocument,
  CoreGitFavoriteRecoveryCatalog,
  CoreGitFavorites,
  CoreSnapshot,
} from "../lib/core-contract.generated";

interface Context {
  root: string;
  project: string;
  platform: string;
  identifier: string;
  phase:
    | "initial"
    | "reopen"
    | "recover"
    | "editor-checkpoint"
    | "editor-reopen"
    | "git"
    | "ssh"
    | "ssh-reopen"
    | "redis"
    | "database"
    | "agents"
    | "input-owner"
    | "input-viewer"
    | "package"
    | "ui-parity"
    | "performance"
    | "updates";
  backup?: string;
  ready: boolean;
  performanceLong?: boolean;
}
const parityFixture = JSON.parse(parityFixtureJSON) as {
  workspaceName: string;
  projectName: string;
  files: Record<string, string>;
  fontSize: number;
  automaticUpdates: boolean;
  databaseComponentIds: string[];
  javaComponentIds: string[];
  maven: {
    distribution: string;
    home: string;
    settings: string;
    repository: string;
    wrapper: boolean;
  };
  sessions: string[];
  marker: string;
  command: string;
  settingsScenes: {
    language: "en" | "zh-Hans";
    appearance: string;
    width: number;
    height: number;
  }[];
  settingsSections: { id: string; label: string }[];
  pdf: { path: string; base64: string; sha256: string; mark: import("../lib/pdf-marks").PdfMark };
  contentScenes: {
    language: "en" | "zh-Hans";
    appearance: string;
    width: number;
    height: number;
  }[];
  quickAddress: string;
  quickTerminalCommand: string;
  github: {
    repository: string;
    title: string;
    body: string;
    base: string;
    head: string;
    draft: boolean;
  };
  githubScenes: { language: "en" | "zh-Hans"; appearance: string; width: number; height: number }[];
  quickScenes: { language: "en" | "zh-Hans"; appearance: string; width: number; height: number }[];
};
const backupKey = "uterm.desktop.editorDraft.v1.backup";
const sentinel = "opaque QA draft backup retained byte-for-byte";
const editorFixture = JSON.parse(editorFixtureJSON) as {
  fileName: string;
  originalText: string;
  oldText: string;
  durableText: string;
  savedText: string;
};
const editorFile = editorFixture.fileName;
const gitQA = JSON.parse(gitFixtureJSON) as { fileName: string; worktreeName: string };
const previewQA = JSON.parse(previewFixtureJSON) as {
  htmlFile: string;
  pdfFile: string;
  htmlText: string;
  pdfText: string;
  escapeMessage: string;
};
const oldEditorText = editorFixture.oldText;
const durableEditorText = editorFixture.durableText;
const savedEditorText = editorFixture.savedText;
const sshQA = JSON.parse(sshFixtureJSON) as {
  profileName: string;
  originalFile: string;
  sourceFile: string;
  previewText: string;
};
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
let observerBusyReads = 0;
let favoritePreviewReloads = 0;
async function observeCore(method: string, params?: Parameters<typeof coreRequest>[1]) {
  assert(
    [
      "snapshot.read",
      "session.entries",
      "editor.drafts.document",
      "git.favorites.read",
      "git.favorites.recovery.list",
    ].includes(method),
    "QA observer is read-only",
  );
  const result = await until(async () => {
    try {
      return { value: await coreRequest(method, params) };
    } catch (reason) {
      if ((reason as { code?: string }).code !== "WRITER_BUSY") throw reason;
      observerBusyReads++;
      return null;
    }
  }, "read-only Core observer after writer lock");
  return result.value;
}
async function until<T>(read: () => T | Promise<T>, description: string): Promise<NonNullable<T>> {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause(100);
  }
  throw Error(`QA timed out: ${description}`);
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );
}
function visibleTerminal(id: string) {
  return [
    ...document.querySelectorAll<HTMLElement>(".local-session.visible[data-session-id]"),
  ].find((element) => {
    const rect = element.getBoundingClientRect();
    return (
      element.dataset.sessionId === id &&
      !element.closest('[aria-hidden="true"], [hidden]') &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < innerWidth &&
      rect.top < innerHeight &&
      getComputedStyle(element).visibility !== "hidden"
    );
  });
}
async function selectedVisibleTerminal() {
  const snapshot = (await observeCore("snapshot.read")) as unknown as {
    document: { workspace: { selectedSession: string | null } };
  };
  const id = snapshot.document.workspace.selectedSession;
  return id ? visibleTerminal(id) : undefined;
}
async function click(label: string) {
  (await until(() => button(label), label)).click();
  await pause(100);
}
async function scene(name: string, checks: unknown) {
  await pause(500);
  await invoke("qa_scene", {
    name,
    value: { ...(checks as Record<string, unknown>), observerBusyReads, favoritePreviewReloads },
  });
}
export async function reportEditorRecoveryFailure(reason: unknown) {
  await scene("failure", {
    stage: "editor-handoff",
    error: String(reason),
    body: document.body.innerText.slice(0, 4000),
  });
}
async function settings() {
  const snapshot = (await observeCore("snapshot.read")) as unknown as {
    document: { settings: typeof defaults };
  };
  return snapshot.document.settings;
}
async function openSettings() {
  const open = await until(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]:not(:disabled)'),
    "settings button",
  );
  open.click();
  await click("Appearance");
}
function fontField() {
  return [...document.querySelectorAll(".settings-content label")]
    .find((l) => l.textContent?.includes("File font size"))
    ?.querySelector<HTMLInputElement>("input");
}
function showFont() {
  const input = fontField();
  assert(input, "Missing file font field");
  input.scrollIntoView({ block: "center" });
  input.focus({ preventScroll: true });
}
async function editFont(value: number) {
  const input = await until(fontField, "file font field");
  input.scrollIntoView({ block: "center" });
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
    input,
    String(value),
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.blur();
}

async function runUiParity() {
  const choose = async (labels: string[], value: string) => {
    const field = await until(
      () =>
        [...document.querySelectorAll(".settings-content label")]
          .find((label) => labels.some((text) => label.textContent?.includes(text)))
          ?.querySelector("select"),
      "parity settings field",
    );
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    await flushSharedState();
  };
  const open = async () => {
    const field = await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          `button[aria-label="${translate("en", "设置")}"], button[aria-label="${translate("zh-Hans", "设置")}"]`,
        ),
      "settings entry",
    );
    field.click();
    await until(() => document.querySelector(".settings-content"), "settings window");
  };
  const tab = async (labels: string[]) => {
    const field = await until(
      () =>
        [...document.querySelectorAll<HTMLButtonElement>(".settings-layout nav button")].find(
          (button) => labels.includes(button.textContent?.trim() ?? ""),
        ),
      "settings section",
    );
    field.click();
  };
  const terminal = await until(selectedVisibleTerminal, "real selected parity terminal");
  await until(() => terminalPerformanceSnapshot("ui-parity-0")?.writable, "parity input ownership");
  const original = await until(
    async () =>
      (
        await invoke<{ sessions: { spec: { id: string }; generation: string }[] }>("qa_host_status")
      ).sessions.find((session) => session.spec.id === "ui-parity-0"),
    "real hosted parity terminal",
  );
  const input = await until(
    () => terminal.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea"),
    "actual parity terminal input",
  );
  input.focus();
  const data = new DataTransfer();
  data.setData("text/plain", parityFixture.command);
  input.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
  );
  for (const type of ["keydown", "keyup"])
    input.dispatchEvent(
      new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
  await until(
    () => terminalPerformanceSnapshot("ui-parity-0")?.text.includes(parityFixture.marker),
    "parsed parity shell marker",
  );
  assert(original, "Selected parity terminal has no actual hosted process");
  for (const language of ["en", "zh-Hans"]) {
    await open();
    await tab([translate("en", "通用"), translate("zh-Hans", "通用")]);
    await choose([translate("en", "应用语言"), translate("zh-Hans", "应用语言")], language);
    await until(async () => (await settings()).language === language, "saved parity language");
    document.querySelector<HTMLButtonElement>(".settings-close")!.click();
    for (const appearance of ["dark", "light"]) {
      await open();
      await tab([translate("en", "外观"), translate("zh-Hans", "外观")]);
      await choose([translate("en", "颜色模式"), translate("zh-Hans", "颜色模式")], appearance);
      await until(
        async () => (await settings()).appearance === appearance,
        "saved parity appearance",
      );
      document.querySelector<HTMLButtonElement>(".settings-close")!.click();
      const files = document.querySelector<HTMLButtonElement>(
        `.inspector-switcher button[aria-label="${translate("en", "文件")}"], .inspector-switcher button[aria-label="${translate("zh-Hans", "文件")}"]`,
      );
      assert(files && !files.disabled, "Actual files tool entry is unavailable");
      files.click();
      for (const width of [1100, 640]) {
        await invoke("qa_performance_window", { width, height: 720 });
        await until(
          () => innerWidth === width && innerHeight === 720,
          "actual parity content size",
        );
        await until(() => {
          const panel = document.querySelector<HTMLElement>(".file-panel");
          const bounds = panel?.getBoundingClientRect();
          const names = panel?.querySelector(".file-results")?.textContent ?? "";
          return (
            bounds &&
            bounds.width > 0 &&
            bounds.height > 0 &&
            !panel?.querySelector('[role="alert"]') &&
            ["note.txt", "README.md"].every((name) => names.includes(name))
          );
        }, "actual parity file list remains readable");
        assert(
          visibleTerminal("ui-parity-0") === terminal,
          "Parity layout replaced the selected terminal",
        );
        const current = (
          await invoke<{ sessions: { spec: { id: string }; generation: string }[] }>(
            "qa_host_status",
          )
        ).sessions.find((session) => session.spec.id === "ui-parity-0");
        assert(
          current?.generation === original.generation,
          "Parity layout restarted the selected terminal",
        );
        const toolbarBounds = document.querySelector("main > .toolbar")?.getBoundingClientRect();
        const toolbarHeight = toolbarBounds?.height;
        const toolbarTop = toolbarBounds?.top;
        assert(
          toolbarTop !== undefined && Math.abs(toolbarTop) < 1,
          "Actual toolbar does not begin at the workspace top",
        );
        assert(
          toolbarHeight !== undefined &&
            Math.abs(toolbarHeight - chrome.metrics.titlebarHeight) < 1,
          "Actual toolbar differs from shared chrome height",
        );
        const sidebarWidth = document
          .querySelector("#workspace-sidebar")
          ?.getBoundingClientRect().width;
        const railBounds = document.querySelector(".sidebar-rail")!.getBoundingClientRect();
        const allButtonBounds = document
          .querySelector(".sidebar-rail-button")!
          .getBoundingClientRect();
        const sidebarRailGeometry = {
          sidebarRailLeft: railBounds.left,
          sidebarRailWidth: railBounds.width,
          sidebarAllButtonLeft: allButtonBounds.left,
          sidebarAllButtonTop: allButtonBounds.top,
          sidebarAllButtonWidth: allButtonBounds.width,
          sidebarAllButtonHeight: allButtonBounds.height,
        };
        for (const [key, expected] of Object.entries({
          sidebarRailLeft: 0,
          sidebarRailWidth: chrome.metrics.sidebarRailWidth,
          sidebarAllButtonLeft:
            (chrome.metrics.sidebarRailWidth - chrome.metrics.railButtonSize) / 2,
          sidebarAllButtonTop: chrome.metrics.titlebarHeight + 8,
          sidebarAllButtonWidth: chrome.metrics.railButtonSize,
          sidebarAllButtonHeight: chrome.metrics.railButtonSize,
        }))
          assert(
            Math.abs(sidebarRailGeometry[key as keyof typeof sidebarRailGeometry] - expected) < 1,
            `Clipped actual ${key}`,
          );
        const expectedSidebar = Math.min(
          chrome.metrics.sidebarDefaultWidth,
          Math.max(
            chrome.metrics.sidebarMinimumWide,
            Math.min(
              chrome.metrics.sidebarMaximumWidth,
              innerWidth * chrome.metrics.sidebarMaximumRatio,
            ),
          ),
        );
        assert(
          sidebarWidth !== undefined && Math.abs(sidebarWidth - expectedSidebar) < 1,
          "Actual sidebar differs from shared responsive bounds",
        );
        const inspectorWidth = document
          .querySelector(".app-shell > .file-panel")
          ?.getBoundingClientRect().width;
        const inspector = document.querySelector(".app-shell > .file-panel")!;
        const inspectorGeometry = {
          inspectorTop: inspector.getBoundingClientRect().top,
          inspectorHeight: inspector.getBoundingClientRect().height,
          inspectorHeaderTop: inspector.querySelector(".inspector-header")!.getBoundingClientRect()
            .top,
          inspectorFooterBottom: inspector
            .querySelector(".file-panel-footer")!
            .getBoundingClientRect().bottom,
          inspectorViewportHeight: innerHeight,
        };
        for (const [key, expected] of Object.entries({
          inspectorTop: 0,
          inspectorHeight: innerHeight,
          inspectorHeaderTop: 0,
          inspectorFooterBottom: innerHeight,
          inspectorViewportHeight: innerHeight,
        })) {
          assert(
            Math.abs(inspectorGeometry[key as keyof typeof inspectorGeometry] - expected) < 1,
            `Actual ${key} does not span the full tools height`,
          );
        }
        const remaining = Math.max(
          chrome.metrics.inspectorMinimumAvailable,
          innerWidth - expectedSidebar,
        );
        const expectedInspector = Math.max(
          chrome.metrics.panelCollapseWidth,
          Math.min(
            remaining - chrome.metrics.mainMinimumWidth,
            remaining * chrome.metrics.inspectorMaximumRatio,
            remaining * chrome.metrics.inspectorDefaultRatio,
          ),
        );
        assert(
          inspectorWidth !== undefined && Math.abs(inspectorWidth - expectedInspector) < 1,
          "Actual tools width differs from shared responsive bounds",
        );
        const terminalSettings = await settings();
        const fontSize = terminalSettings.fontSize;
        const paneBounds = terminal.getBoundingClientRect();
        const terminalBounds = terminal.querySelector(".terminal")!.getBoundingClientRect();
        const headerBounds = terminal.querySelector(".session-controls")!.getBoundingClientRect();
        const terminalGeometry = {
          terminalInsetLeft: terminalBounds.left - paneBounds.left,
          terminalInsetRight: paneBounds.right - terminalBounds.right,
          terminalInsetBottom: paneBounds.bottom - terminalBounds.bottom,
          terminalHeaderTop: headerBounds.top - paneBounds.top,
          terminalHeaderHeight: headerBounds.height,
          terminalViewportGap: terminalBounds.top - headerBounds.bottom,
        };
        for (const key of [
          "terminalInsetLeft",
          "terminalInsetRight",
          "terminalInsetBottom",
          "terminalHeaderTop",
        ] as const)
          assert(
            Math.abs(terminalGeometry[key] - terminalSettings.windowPadding - 1) < 1,
            `Wrong actual ${key}`,
          );
        assert(
          Math.abs(terminalGeometry.terminalViewportGap - 12) < 1,
          "Wrong terminal viewport gap",
        );
        const fontQuery = `${fontSize}px "Cascadia Code"`;
        const fontFaces = await document.fonts.load(fontQuery);
        await document.fonts.ready;
        assert(
          fontFaces.length > 0 && document.fonts.check(fontQuery),
          `Bundled terminal font was not loaded: ${JSON.stringify({
            query: fontQuery,
            status: document.fonts.status,
            faces: fontFaces.map((face) => ({
              family: face.family,
              style: face.style,
              weight: face.weight,
              status: face.status,
            })),
          })}`,
        );
        const fontContext = document.createElement("canvas").getContext("2d");
        assert(fontContext, "Cannot measure actual terminal font");
        fontContext.font = fontQuery;
        const sectionHeader = document
          .querySelector(".sidebar-section .section-header")
          ?.getBoundingClientRect();
        const sidebarHeader = document.querySelector(".sidebar-header")?.getBoundingClientRect();
        const laterSection = document.querySelectorAll(".sidebar-section")[1];
        const sidebarGeometry = {
          sidebarRowHeight: document.querySelector(".sidebar-row")?.getBoundingClientRect().height,
          sidebarSectionHeight: sectionHeader?.height,
          sidebarSectionGap: laterSection
            ? parseFloat(getComputedStyle(laterSection).marginTop)
            : undefined,
          sidebarListTop:
            sectionHeader && sidebarHeader ? sectionHeader.top - sidebarHeader.bottom : undefined,
        };
        for (const key of [
          "sidebarRowHeight",
          "sidebarSectionHeight",
          "sidebarSectionGap",
          "sidebarListTop",
        ] as const) {
          const actual = sidebarGeometry[key];
          assert(
            actual !== undefined && Math.abs(actual - chrome.metrics[key]) < 1,
            `Actual ${key} differs from shared geometry`,
          );
        }
        const fileGitStates = () =>
          Object.fromEntries(
            Object.keys(parityFixture.files).map((path) => [
              path,
              [...document.querySelectorAll<HTMLElement>(".file-row")].find(
                (row) => row.dataset.path === path,
              )?.dataset.gitStatus,
            ]),
          );
        await until(
          () => Object.values(fileGitStates()).every((state) => state === "untracked"),
          "actual file Git state decorations",
        );
        const branch = document.querySelector<HTMLElement>(".workspace-branch");
        const trigger = branch?.querySelector<HTMLButtonElement>(".branch-trigger");
        const branchIcon = branch?.querySelector("svg");
        assert(branch && trigger && branchIcon, "Missing actual ordinary branch picker");
        const branchBounds = branch.getBoundingClientRect();
        const branchStyle = getComputedStyle(branch);
        const branchMetrics = {
          name: trigger.textContent?.trim().replace(/\s+⌄$/u, "") ?? "",
          height: branchBounds.height,
          width: branchBounds.width,
          fontSize: Number.parseFloat(branchStyle.fontSize),
          captionGap:
            trigger.getBoundingClientRect().left - branchIcon.getBoundingClientRect().right,
          actualDOMControl: true,
          fontName: branchStyle.fontFamily,
        };
        assert(
          branchMetrics.name === parityFixture.github.head &&
            Math.abs(branchMetrics.fontSize - 11) < 0.01 &&
            Math.abs(branchMetrics.captionGap - 5) < 1,
          "Incorrect actual ordinary branch geometry",
        );
        await scene(`workspace-${language}-${appearance}-${width}`, {
          chromeContractSHA256,
          branchPicker: branchMetrics,
          toolbarHeight,
          toolbarTop,
          sidebarWidth,
          inspectorWidth,
          ...inspectorGeometry,
          ...terminalGeometry,
          language,
          appearance,
          width: innerWidth,
          height: innerHeight,
          scenario: "toolbar-sidebar-two-sessions-files",
          generationRetained: true,
          filesReadable: true,
          fileGitStates: fileGitStates(),
          fontSize,
          fontFamily: fontManifest.family,
          fontFace: "CascadiaCode-Regular",
          fontSourceSHA256: fontManifest.files["CascadiaCode-Regular.ttf"],
          fontCharacterWidth: fontContext.measureText("M").width,
          ...sidebarGeometry,
          ...sidebarRailGeometry,
          projectName: parityFixture.projectName,
          workspaceName: parityFixture.workspaceName,
        });
      }
    }
  }
  for (const sceneFixture of parityFixture.settingsScenes) {
    await open();
    await tab([translate("en", "通用"), translate("zh-Hans", "通用")]);
    await choose(
      [translate("en", "应用语言"), translate("zh-Hans", "应用语言")],
      sceneFixture.language,
    );
    await tab([translate("en", "外观"), translate("zh-Hans", "外观")]);
    await choose(
      [translate("en", "颜色模式"), translate("zh-Hans", "颜色模式")],
      sceneFixture.appearance,
    );
    await until(async () => {
      const value = await settings();
      return (
        value.language === sceneFixture.language && value.appearance === sceneFixture.appearance
      );
    }, "persist settings capture language and appearance");
    await invoke("qa_performance_window", {
      width: sceneFixture.width,
      height: sceneFixture.height,
    });
    await until(
      () => innerWidth === sceneFixture.width && innerHeight === sceneFixture.height,
      "actual settings capture content size",
    );
    for (const section of parityFixture.settingsSections) {
      await tab([translate(sceneFixture.language, section.label)]);
      await until(() => {
        const current = document.querySelector('.settings-layout nav button[aria-pressed="true"]');
        return current?.textContent?.trim() === translate(sceneFixture.language, section.label);
      }, "actual settings category selection");
      if (section.id === "maven") {
        await until(
          () => document.querySelector(".maven-setting-fields select:not(:disabled)"),
          "loaded global Maven controls",
        );
        const fields = document.querySelector(".maven-setting-fields")!;
        const input = (label: string) =>
          fields.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.value;
        const actual = {
          distribution: fields.querySelector("select")!.value,
          home: input(translate(sceneFixture.language, "Maven 主目录")),
          settings: input(translate(sceneFixture.language, "用户设置文件 · settings.xml")),
          repository: input(translate(sceneFixture.language, "Maven 本地仓库")),
          wrapper: fields.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
        };
        assert(
          JSON.stringify(actual) === JSON.stringify(parityFixture.maven),
          "Actual global Maven controls differ from the common fixture",
        );
      }
      if (section.id === "database") {
        await until(
          () =>
            document.querySelectorAll(".database-components .database-component-row").length ===
            parityFixture.databaseComponentIds.length,
          "loaded actual database component catalog",
        );
        const expected = parityFixture.databaseComponentIds
          .map((id) =>
            id === "runtime"
              ? translate(sceneFixture.language, "Java 运行时")
              : id === "mongodb-core"
                ? "MongoDB Core"
                : id === "mongodb-bson"
                  ? "MongoDB BSON"
                  : databaseNames[id as keyof typeof databaseNames],
          )
          .sort();
        const actual = [
          ...document.querySelectorAll(".database-components .database-component-row strong"),
        ]
          .map((item) => item.textContent?.trim())
          .sort();
        assert(
          JSON.stringify(actual) === JSON.stringify(expected),
          "Actual database component labels differ from the shared catalog",
        );
      }
      if (section.id === "java") {
        await until(
          () =>
            document.querySelectorAll(".java-components > .java-component-row").length ===
            parityFixture.javaComponentIds.length,
          "loaded actual managed Java component catalog",
        );
        const expected = parityFixture.javaComponentIds
          .map((id) =>
            id === "maven"
              ? translate(sceneFixture.language, "托管 Maven")
              : id.replace("jdk-", "JDK "),
          )
          .sort();
        const actual = [
          ...document.querySelectorAll(".java-components > .java-component-row strong"),
        ]
          .map((item) => item.textContent?.trim())
          .sort();
        assert(
          JSON.stringify(actual) === JSON.stringify(expected),
          "Actual Java components differ from the shared catalog",
        );
        assert(
          !document.querySelector(".java-components .java-error"),
          "Java settings contain an actual component/JDK read error",
        );
      }
      const draftUnchanged = !document.querySelector(
        `[aria-label="${translate(sceneFixture.language, "未保存的设置")}"], [role="alert"].settings-error, .settings-content .java-error`,
      );
      const settingsDialog = document.querySelector<HTMLDialogElement>(".settings-dialog")!;
      const settingsCard = settingsDialog.getBoundingClientRect();
      await scene(
        `settings-${section.id}-${sceneFixture.language}-${sceneFixture.appearance}-${sceneFixture.width}`,
        {
          ...sceneFixture,
          section: section.id,
          navigationControlActivated: true,
          draftUnchanged,
          mavenFixtureMatched: section.id === "maven",
          databaseFixtureMatched: section.id === "database",
          javaFixtureMatched: section.id === "java",
          automaticUpdates: (await settings()).automaticUpdates,
          workspaceModal: settingsDialog.open && settingsDialog.matches(":modal"),
          settingsCard: {
            x: settingsCard.x,
            y: settingsCard.y,
            width: settingsCard.width,
            height: settingsCard.height,
          },
        },
      );
      assert(draftUnchanged, "Settings capture shows unsaved values or an error");
    }
    document.querySelector<HTMLButtonElement>(".settings-close")!.click();
  }
  await invoke("qa_performance_window", { width: 1100, height: 720 });
  await until(() => innerWidth === 1100 && innerHeight === 720, "actual restart capture size");
  await flushSharedState();
  const workspaceBeforeRestart = (await observeCore("snapshot.read")) as unknown as CoreSnapshot;
  await invoke("control_session", { id: "ui-parity-0", action: "send", text: "exit\r" });
  const restart = await until(
    () =>
      visibleTerminal("ui-parity-0")?.querySelector<HTMLButtonElement>(
        `button[aria-label="${translate("en", "重新启动")}"],button[aria-label="${translate("zh-Hans", "重新启动")}"]`,
      ),
    "actual exited-shell restart button",
  );
  restart.click();
  const restarted = await until(async () => {
    const current = (
      await invoke<{ sessions: { spec: { id: string }; generation: string; running: boolean }[] }>(
        "qa_host_status",
      )
    ).sessions.find((entry) => entry.spec.id === "ui-parity-0");
    return current?.running && current.generation !== original.generation ? current : null;
  }, "actual restarted process generation");
  await until(() => {
    const current = terminalPerformanceSnapshot("ui-parity-0");
    return current?.writable && !current.text.includes(parityFixture.marker);
  }, "restarted input ownership");
  await invoke("control_session", {
    id: "ui-parity-0",
    action: "send",
    text: parityFixture.command + "\r",
  });
  await until(
    () => terminalPerformanceSnapshot("ui-parity-0")?.text.includes(parityFixture.marker),
    "actual restarted terminal output",
  );
  const workspaceAfterRestart = (await observeCore("snapshot.read")) as unknown as CoreSnapshot;
  assert(
    JSON.stringify(workspaceBeforeRestart.document.workspace) ===
      JSON.stringify(workspaceAfterRestart.document.workspace),
    "Explicit restart changed canonical workspace descriptors",
  );
  assert(
    visibleTerminal("ui-parity-0") === terminal,
    "Explicit restart replaced the terminal view",
  );
  await scene("terminal-restart", {
    passed: true,
    actualRestartButton: true,
    parsedUnicodeOutput: true,
    canonicalWorkspaceRetained: true,
    terminalViewRetained: true,
    generationBeforeRestart: original.generation,
    restartedGeneration: restarted.generation,
  });
  const backgroundClose = await until(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>(".session-close")].find((button) =>
        [
          translate("en", "关闭会话：{p0}", { p0: parityFixture.sessions[1] }),
          translate("zh-Hans", "关闭会话：{p0}", { p0: parityFixture.sessions[1] }),
        ].includes(button.getAttribute("aria-label") ?? ""),
      ),
    "actual background session close before PDF comparison",
  );
  backgroundClose.click();
  await until(async () => {
    const entries = (await observeCore("session.entries")) as unknown as {
      session: { id: string };
    }[];
    const status = await invoke<{ sessions: { spec: { id: string }; generation: string }[] }>(
      "qa_host_status",
    );
    return (
      entries.length === 1 &&
      entries[0].session.id === "ui-parity-0" &&
      status.sessions.length === 1 &&
      status.sessions[0].spec.id === "ui-parity-0" &&
      status.sessions[0].generation === restarted.generation
    );
  }, "matching single-session PDF fixture and retained process");
  const pdfContext = await invoke<Context>("qa_context");
  const pdfFile = (await coreRequest("files.read", {
    directory: pdfContext.project,
    path: parityFixture.pdf.path,
  })) as unknown as { version: string; kind: string };
  assert(
    pdfFile.kind === "pdf" && pdfFile.version === parityFixture.pdf.sha256,
    "Shared PDF fixture bytes differ",
  );
  const pdfTarget = {
    directory: pdfContext.project,
    path: parityFixture.pdf.path,
    version: pdfFile.version,
  };
  const pdfMarks = async () =>
    (await coreRequest("pdf.marks.read", pdfTarget)) as unknown as {
      revision: string;
      marks: unknown[];
    };
  const initialMarks = await pdfMarks();
  await coreRequest("pdf.marks.write", {
    ...pdfTarget,
    expectedRevision: initialMarks.revision,
    marks: [parityFixture.pdf.mark],
  });
  const pdfReady = async (count: number) =>
    until(() => {
      const viewer = document.querySelector(".pdf-reader");
      return (
        viewer &&
        viewer.querySelectorAll(".pdf-mark").length === count &&
        viewer.querySelector<HTMLCanvasElement>("canvas[data-rendered=true]") &&
        viewer.querySelector<HTMLButtonElement>(".pdf-controls button[aria-pressed]")?.disabled ===
          false
      );
    }, "actual PDF canvas and acknowledged highlights");
  const openPdf = async (count: number) => {
    const folder = await until(
      () => document.querySelector<HTMLButtonElement>('.file-row[data-path=".ui-parity-pdf"]'),
      "shared PDF fixture folder",
    );
    if (folder.getAttribute("aria-expanded") !== "true") folder.click();
    const file = await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          `.file-row[data-path="${parityFixture.pdf.path}"]`,
        ),
      "shared PDF file row",
    );
    file.click();
    await pdfReady(count);
    const select = document.querySelector<HTMLSelectElement>(".pdf-layout nav select")!;
    select.value = "marks";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const closePdf = async () => {
    const close = await until(
      () =>
        [...document.querySelectorAll<HTMLButtonElement>(".workspace-tab-close")].find((button) =>
          button.getAttribute("aria-label")?.includes(parityFixture.pdf.path),
        ),
      "actual PDF workspace close tab",
    );
    close.click();
    await until(() => !document.querySelector(".pdf-reader"), "closed actual PDF workspace view");
  };
  await openPdf(1);
  const removeMark = await until(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>(".pdf-layout nav button")].find((button) =>
        [translate("en", "删除高亮"), translate("zh-Hans", "删除高亮")].includes(
          button.textContent?.trim() ?? "",
        ),
      ),
    "actual highlight removal button",
  );
  removeMark.click();
  await pdfReady(0);
  const removedMarks = await pdfMarks();
  assert(removedMarks.marks.length === 0, "Highlight removal did not reach shared storage");
  await closePdf();
  await openPdf(0);
  await closePdf();
  await coreRequest("pdf.marks.write", {
    ...pdfTarget,
    expectedRevision: removedMarks.revision,
    marks: [parityFixture.pdf.mark],
  });
  await openPdf(1);
  const pdfView = document.querySelector(".pdf-reader");
  for (const pdfScene of parityFixture.contentScenes) {
    await open();
    await tab([translate("en", "通用"), translate("zh-Hans", "通用")]);
    await choose(
      [translate("en", "应用语言"), translate("zh-Hans", "应用语言")],
      pdfScene.language,
    );
    document.querySelector<HTMLButtonElement>(".settings-close")!.click();
    await open();
    await tab([translate("en", "外观"), translate("zh-Hans", "外观")]);
    await choose(
      [translate("en", "颜色模式"), translate("zh-Hans", "颜色模式")],
      pdfScene.appearance,
    );
    document.querySelector<HTMLButtonElement>(".settings-close")!.click();
    await invoke("qa_performance_window", { width: pdfScene.width, height: pdfScene.height });
    await until(
      () => innerWidth === pdfScene.width && innerHeight === pdfScene.height,
      "actual PDF capture size",
    );
    await pdfReady(1);
    await until(
      () =>
        [...document.querySelectorAll(".pdf-layout nav button")].some(
          (button) => button.textContent?.trim() === translate(pdfScene.language, "删除高亮"),
        ),
      "localized actual PDF controls",
    );
    assert(document.querySelector(".pdf-reader") === pdfView, "Settings replaced the PDF view");
    const unchanged = (await coreRequest("files.read", {
      directory: pdfContext.project,
      path: parityFixture.pdf.path,
    })) as unknown as { version: string };
    assert(unchanged.version === pdfFile.version, "Annotations changed PDF source bytes");
    const savedMarks = (await pdfMarks()).marks as Record<string, unknown>[];
    assert(
      savedMarks.length === 1 &&
        Object.entries(parityFixture.pdf.mark).every(
          ([key, value]) => savedMarks[0][key] === value,
        ),
      "Unexpected saved PDF marks",
    );
    assert(
      document.querySelector(".pdf-mark")?.getAttribute("data-mark-id") ===
        parityFixture.pdf.mark.id,
      "Rendered PDF highlight differs",
    );
    await scene(`pdf-highlights-${pdfScene.language}-${pdfScene.appearance}-${pdfScene.width}`, {
      ...pdfScene,
      passed: true,
      pdfSHA256: pdfFile.version,
      markID: parityFixture.pdf.mark.id,
      marksCount: 1,
      fixtureSessionCount: 1,
      filesFolderExpanded: true,
      actualRemoveButton: true,
      reopenedRestoredMarks: true,
      originalPdfUnchanged: true,
      inMainWorkspace: true,
      settingsPreserveDocument: true,
      input:
        "Actual shared file rows, PDF removal and workspace close controls; the initial comparison mark is seeded fixture data, not a claimed ordinary native pointer gesture",
    });
  }
  await closePdf();
  const quickWorkspace = ((await observeCore("snapshot.read")) as unknown as CoreSnapshot).document
    .workspace;
  const quickFrames = terminalPerformanceSnapshot("ui-parity-0")!.frames;
  await invoke("control_session", {
    id: "ui-parity-0",
    action: "send",
    text: parityFixture.quickTerminalCommand + "\r",
  });
  await until(() => {
    const current = terminalPerformanceSnapshot("ui-parity-0");
    return (
      current &&
      current.frames > quickFrames &&
      current.text.includes(parityFixture.marker) &&
      current.text.trimEnd().endsWith("ui-parity >")
    );
  }, "shared modal background prepared by actual shell output");
  async function unchangedQuick() {
    const current = await invoke<{ sessions: { spec: { id: string }; generation: string }[] }>(
      "qa_host_status",
    );
    assert(
      current.sessions.length === 1 &&
        current.sessions[0].spec.id === "ui-parity-0" &&
        current.sessions[0].generation === restarted.generation &&
        JSON.stringify(
          ((await observeCore("snapshot.read")) as unknown as CoreSnapshot).document.workspace,
        ) === JSON.stringify(quickWorkspace),
      "Quick SSH changed the workspace or terminal generation",
    );
    assert(visibleTerminal("ui-parity-0") === terminal, "Quick SSH replaced the terminal view");
  }
  for (const quickScene of parityFixture.quickScenes) {
    await open();
    await tab([translate("en", "通用"), translate("zh-Hans", "通用")]);
    await choose(
      [translate("en", "应用语言"), translate("zh-Hans", "应用语言")],
      quickScene.language,
    );
    document.querySelector<HTMLButtonElement>(".settings-close")!.click();
    await open();
    await tab([translate("en", "外观"), translate("zh-Hans", "外观")]);
    await choose(
      [translate("en", "颜色模式"), translate("zh-Hans", "颜色模式")],
      quickScene.appearance,
    );
    document.querySelector<HTMLButtonElement>(".settings-close")!.click();
    await invoke("qa_performance_window", { width: quickScene.width, height: quickScene.height });
    await until(
      () => innerWidth === quickScene.width && innerHeight === quickScene.height,
      "actual Quick SSH capture dimensions",
    );
    async function invalidQuick() {
      const trigger = await until(
        () =>
          [...document.querySelectorAll<HTMLButtonElement>(".ssh-sidebar-tools button")].find(
            (button) =>
              button.textContent?.trim() === translate(quickScene.language, "快速 SSH 连接") &&
              !button.disabled,
          ),
        "actual Quick SSH sidebar button",
      );
      trigger.click();
      const dialog = await until(
        () => document.querySelector<HTMLDialogElement>(".ssh-quick-dialog[open]"),
        "actual shared Quick SSH modal",
      );
      const field = dialog.querySelector<HTMLInputElement>("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        field,
        parityFixture.quickAddress,
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await pause(0);
      dialog.querySelector("form")!.requestSubmit();
      await until(
        () => dialog.querySelector("[role=alert]") && !field.disabled,
        "actual invalid-input rejection",
      );
      assert(field.value === parityFixture.quickAddress, "Quick SSH lost the rejected address");
      return dialog;
    }
    async function cancelQuick(dialog: HTMLDialogElement) {
      const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === translate(quickScene.language, "取消"),
      );
      assert(cancel, "Actual modal Cancel is unavailable");
      cancel.click();
      await until(
        () => !document.querySelector(".ssh-quick-dialog"),
        "cancel only the actual Quick SSH modal",
      );
      await unchangedQuick();
    }
    await cancelQuick(await invalidQuick());
    const dialog = await invalidQuick();
    await unchangedQuick();
    const bounds = dialog.getBoundingClientRect();
    await scene(
      `quick-ssh-invalid-${quickScene.language}-${quickScene.appearance}-${quickScene.width}`,
      {
        ...quickScene,
        passed: true,
        inputAddress: parityFixture.quickAddress,
        terminalFixtureMarker: parityFixture.marker,
        invalidInputRejected: true,
        addressRetained: true,
        savedWorkspaceUnchanged: true,
        sameMainWindow: true,
        terminalGenerationRetained: true,
        actualSidebarButton: true,
        actualCancelPreservedState: true,
        workspaceVisibleAroundDialog: true,
        modalLeft: bounds.left,
        modalTop: bounds.top,
        modalWidth: bounds.width,
        modalHeight: bounds.height,
      },
    );
    await cancelQuick(dialog);
  }
  for (const githubScene of parityFixture.githubScenes) {
    await open();
    await tab([translate("en", "通用"), translate("zh-Hans", "通用")]);
    await choose(
      [translate("en", "应用语言"), translate("zh-Hans", "应用语言")],
      githubScene.language,
    );
    document.querySelector<HTMLButtonElement>(".settings-close")!.click();
    await open();
    await tab([translate("en", "外观"), translate("zh-Hans", "外观")]);
    await choose(
      [translate("en", "颜色模式"), translate("zh-Hans", "颜色模式")],
      githubScene.appearance,
    );
    document.querySelector<HTMLButtonElement>(".settings-close")!.click();
    await invoke("qa_performance_window", { width: githubScene.width, height: githubScene.height });
    await until(
      () => innerWidth === githubScene.width && innerHeight === githubScene.height,
      "actual GitHub capture dimensions",
    );
    const trigger = await until(
      () =>
        document.querySelector<HTMLButtonElement>(".inspector-switcher button[aria-label=GitHub]"),
      "actual GitHub tool switcher",
    );
    trigger.click();
    await until(
      () =>
        document.querySelector<HTMLSelectElement>(".github-panel .compare-picker select")?.value ===
        parityFixture.github.repository,
      "captured fixture repository",
    );
    await click(translate(githubScene.language, "合并请求"));
    await until(() => {
      const current = button(translate(githubScene.language, "新建 PR"));
      return current && !current.disabled;
    }, "ready PR creation control");
    await click(translate(githubScene.language, "新建 PR"));
    const dialog = await until(
      () => document.querySelector<HTMLDialogElement>(".pr-dialog[open]"),
      "actual shared PR dialog",
    );
    const form = dialog.querySelector("form")!,
      fields = form.querySelectorAll<HTMLInputElement>("input:not([type=checkbox])");
    for (const [field, prototype, value] of [
      [fields[0], HTMLInputElement.prototype, parityFixture.github.title],
      [fields[1], HTMLInputElement.prototype, parityFixture.github.base],
      [fields[2], HTMLInputElement.prototype, parityFixture.github.head],
      [form.querySelector("textarea")!, HTMLTextAreaElement.prototype, parityFixture.github.body],
    ] as const) {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const draft = form.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    if (draft.checked !== parityFixture.github.draft) draft.click();
    await pause(0);
    assert(
      fields[0].value === parityFixture.github.title &&
        form.querySelector("textarea")!.value === parityFixture.github.body,
      "PR literal input changed",
    );
    assert(
      [...form.querySelectorAll<HTMLInputElement>("input:not([type=checkbox]),textarea")].every(
        (field) => field.getBoundingClientRect().width > 300,
      ),
      "PR fields are crushed",
    );
    assert(
      fields[1].value === parityFixture.github.base &&
        fields[2].value === parityFixture.github.head &&
        draft.checked === parityFixture.github.draft,
      "PR branch/draft fields changed",
    );
    await unchangedQuick();
    const bounds = dialog.getBoundingClientRect();
    const proofs = {
      ...githubScene,
      passed: true,
      form: parityFixture.github,
      actualToolsSwitcher: true,
      literalInputRetained: true,
      readableFields: true,
      workspaceVisibleAroundDialog: true,
      terminalGenerationRetained: true,
      savedWorkspaceUnchanged: true,
      isolatedSimulatedCLI: true,
      noGitHubWrites: true,
      actualCancelPreservedState: true,
      modalLeft: bounds.left,
      modalTop: bounds.top,
      modalWidth: bounds.width,
      modalHeight: bounds.height,
    };
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === translate(githubScene.language, "取消"),
    )!;
    await scene(
      `github-pr-draft-${githubScene.language}-${githubScene.appearance}-${githubScene.width}`,
      proofs,
    );
    cancel.click();
    await until(() => !dialog.open, "actual PR cancel");
    await unchangedQuick();
  }
  await invoke("qa_request_exit");
}

export async function prepare() {
  const context = await invoke<Context>("qa_context");
  if (context.phase === "git") {
    const references = (await coreRequest("git.references", {
      directory: context.project,
    })) as unknown as { repository: string };
    const key = `uterm.git.favorites:${references.repository}`;
    if (localStorage.getItem(key) === null)
      localStorage.setItem(key, '[\r\n "refs/heads/main"\r\n]');
  }
  if (
    ["initial", "editor-checkpoint", "performance", "updates", "ui-parity"].includes(
      context.phase,
    ) &&
    localStorage.getItem(settingsKey) === null
  ) {
    localStorage.setItem(
      settingsKey,
      JSON.stringify({
        ...defaults,
        language: "en",
        appearance: "dark",
        ...(context.phase === "ui-parity" ? { fontSize: parityFixture.fontSize } : {}),
        ...(context.phase === "ui-parity"
          ? { automaticUpdates: parityFixture.automaticUpdates }
          : {}),
        ...(context.phase === "performance" ? performanceSettings(context.platform) : {}),
        ...(context.phase === "updates" ? { defaultShell: "cmd" } : {}),
      }),
    );
    const workspace = emptyWorkspace();
    if (context.phase === "ui-parity") {
      assert(workspace.groups?.[0], "Missing fixture workspace");
      workspace.groups[0].name = parityFixture.workspaceName;
    }
    workspace.projects.push({
      id: "shared-state-qa",
      name: context.phase === "ui-parity" ? parityFixture.projectName : "Temporary QA project",
      directory: context.project,
      workspaceId: "local",
      sessions: [],
    });
    if (context.phase === "ui-parity") {
      workspace.projects[0].sessions = parityFixture.sessions.map((name, index) => ({
        id: `ui-parity-${index}`,
        name,
        shell: "default",
      }));
      workspace.selectedProject = workspace.projects[0].id;
      workspace.selectedSession = "ui-parity-0";
    }
    localStorage.setItem(workspaceKey, JSON.stringify(workspace));
    localStorage.setItem(backupKey, sentinel);
  }
  if (context.phase === "editor-checkpoint" && localStorage.getItem(draftKey) === null) {
    const file = (await coreRequest("files.read", {
      directory: context.project,
      path: editorFile,
    })) as unknown as CoreFileDocument;
    localStorage.setItem(
      draftKey,
      " \n" +
        JSON.stringify({
          directory: context.project,
          path: editorFile,
          kind: "text",
          text: oldEditorText,
          saved: file.text,
          version: file.version,
          bom: file.bom,
          line_ending: file.line_ending,
        }) +
        "\n",
    );
  }
}

async function runEditor(context: Context) {
  const expected = context.phase === "editor-checkpoint" ? oldEditorText : durableEditorText;
  const original = localStorage.getItem(draftKey);
  const receipt = JSON.parse(localStorage.getItem(editorDraftReceiptKey) ?? "null");
  assert(original && receipt?.version === 1, "Old draft handoff was not recorded");
  assert(
    localStorage.getItem(`${draftKey}.shared-v1-backup.${receipt.legacyDigest}`) === original,
    "Versioned old draft backup changed",
  );
  const field = await until(
    () => document.querySelector<HTMLElement>(".cm-content[contenteditable=true]"),
    "real editable CodeMirror",
  );
  await until(
    () => field.innerText.includes(expected.split("\r")[0]),
    "exact retained text loaded",
  );
  const documentDraft = async () =>
    observeCore("editor.drafts.document", {
      directory: context.project,
      path: editorFile,
    }) as unknown as Promise<CoreEditorDraftEntry | null>;
  assert((await documentDraft())?.draft.text === expected, "Old/reopened shared text differs");
  await scene(context.phase === "editor-checkpoint" ? "editor-imported" : "editor-recovered", {
    expectedText: expected,
    oldSourceRetained: true,
    versionedBackupRetained: true,
  });
  const next = context.phase === "editor-checkpoint" ? durableEditorText : savedEditorText;
  field.focus();
  assert(document.execCommand("selectAll", false), "CodeMirror selectAll failed");
  assert(
    document.execCommand("insertText", false, next.replace(/\r\n/g, "\n")),
    "CodeMirror insertText failed",
  );
  if (context.phase === "editor-checkpoint") {
    await until(
      () => document.querySelector(".editor-error")?.textContent?.includes("writer"),
      "real recovery writer lock rejection",
    );
    const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Retry recovery draft",
    );
    assert(retry && !retry.disabled, "Explicit draft retry is unavailable");
    assert(field.innerText.includes(next.split("\r")[0]), "Rejected write lost editor text");
    await scene("editor-write-rejected", {
      realWriterLockRejected: true,
      editorTextRetained: true,
      explicitRetryVisible: true,
    });
    retry.click();
  }
  await until(
    async () => (await documentDraft())?.draft.text === next,
    "durable shared editor text",
  );
  assert(
    localStorage.getItem(draftKey) === original,
    "Shared editing wrote the frozen old draft key",
  );
  const file = (await coreRequest("files.read", {
    directory: context.project,
    path: editorFile,
  })) as unknown as CoreFileDocument;
  assert(
    file.text === editorFixture.originalText,
    "Recovered draft autosaved before explicit Save",
  );
  if (context.phase === "editor-checkpoint") {
    await scene("editor-durable", {
      exactText: next,
      frozenOldSource: true,
      originalFileUnchanged: true,
    });
    return;
  }
  await click("Save");
  await until(
    () => document.querySelector(".editor-save-state")?.textContent?.trim() === "Saved",
    "explicit native editor Save",
  );
  const saved = (await coreRequest("files.read", {
    directory: context.project,
    path: editorFile,
  })) as unknown as CoreFileDocument;
  assert(
    saved.text === savedEditorText && saved.bom && saved.line_ending === "\r\n",
    "Explicit save lost file bytes or metadata",
  );
  assert((await documentDraft()) === null, "Acknowledged saved draft was not removed");
  assert(
    localStorage.getItem(draftKey) === original,
    "Explicit shared save changed frozen old source",
  );
  await scene("editor-saved", {
    exactText: saved.text,
    bom: saved.bom,
    lineEnding: saved.line_ending,
    draftCleared: true,
    frozenOldSource: true,
  });
  await runPreviews(context);
  await invoke("qa_request_exit");
}

async function runPreviews(context: Context) {
  let escapedMessages = 0;
  const receive = (event: MessageEvent) => {
    if (event.data === previewQA.escapeMessage) escapedMessages++;
  };
  window.addEventListener("message", receive);
  try {
    const retry = button("Retry loading");
    if (retry) {
      retry.click();
      await until(() => !retry.isConnected, "explicit workspace read retry");
    }
    const project = await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          '.folder-row[data-project-id="shared-state-qa"] > .row-label',
        ),
      "imported QA project before preview",
    );
    if (!project.closest(".folder-row")?.classList.contains("selected")) {
      project.click();
      await until(
        () => project.closest(".folder-row")?.classList.contains("selected"),
        "completed project selection before preview",
      );
    }
    const files = await until(
      () => document.querySelector<HTMLButtonElement>('.inspector-switcher button[title="Files"]'),
      "actual Files entry",
    );
    files.click();
    const projectRoot = await until(() => {
      const path = document.querySelector<HTMLElement>(".file-panel-footer")?.title;
      return path === clipboardPath(context.project) && path;
    }, "actual preview file tree uses the temporary project root");
    async function open(path: string) {
      const row = await until(
        () =>
          [...document.querySelectorAll<HTMLButtonElement>(".file-row")].find(
            (button) => button.dataset.path === path,
          ),
        `actual file tree row ${path}`,
      );
      row.click();
    }
    async function close(path: string) {
      const button = await until(
        () =>
          [...document.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.getAttribute("aria-label") === `Close file ${path}`,
          ),
        `actual close file button ${path}`,
      );
      button.click();
      await until(() => !button.isConnected, `closed preview tab ${path}`);
    }
    await open(previewQA.htmlFile);
    const frame = await until(
      () => document.querySelector<HTMLIFrameElement>("iframe.html-preview"),
      "actual sandboxed HTML preview",
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("HTML preview load timed out")), 10000);
      frame.addEventListener(
        "load",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      frame.srcdoc = frame.srcdoc;
    });
    const html = new DOMParser().parseFromString(frame.srcdoc, "text/html");
    assert(
      html.body.textContent?.includes(previewQA.htmlText),
      "Preview lost allowed static content",
    );
    assert(
      !html.querySelector("script,iframe,object,embed,link,[onerror],[onload]"),
      "Preview retained active content",
    );
    const policy =
      html.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ??
      "";
    assert(
      policy.includes("default-src 'none'") && policy.includes("img-src data:"),
      "Preview lost its resource policy",
    );
    assert(
      frame.hasAttribute("sandbox") && frame.sandbox.length === 0,
      "Preview gained sandbox capabilities",
    );
    let opaqueDocumentAccessRejected = false;
    try {
      void frame.contentWindow!.document;
    } catch (reason) {
      opaqueDocumentAccessRejected = (reason as DOMException).name === "SecurityError";
    }
    assert(
      opaqueDocumentAccessRejected && escapedMessages === 0,
      "Untrusted preview crossed its origin boundary",
    );
    const bounds = frame.getBoundingClientRect();
    assert(bounds.width > 0 && bounds.height > 0, "HTML preview is not visible");
    await scene("preview-html", {
      workspaceReadRetried: !!retry,
      projectRoot,
      actualFileTree: true,
      staticContentRetained: true,
      activeContentRemoved: true,
      opaqueDocumentAccessRejected,
      escapedMessages,
      sandbox: frame.getAttribute("sandbox"),
      policy,
      width: bounds.width,
      height: bounds.height,
    });
    await close(previewQA.htmlFile);
    await open(previewQA.pdfFile);
    await click("Zoom out");
    await click("Zoom out");
    const rendered = await until(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '.pdf-page canvas[data-rendered="true"]',
      );
      if (!canvas || !canvas.width || !canvas.height) return null;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let darkPixels = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i + 3] === 255 && pixels[i] < 200 && pixels[i + 1] < 200 && pixels[i + 2] < 200)
          darkPixels++;
      return darkPixels > 8 && { width: canvas.width, height: canvas.height, darkPixels };
    }, "actual PDF canvas paints the fixture page");
    const pdf = (await coreRequest("files.read", {
      directory: context.project,
      path: previewQA.pdfFile,
    })) as unknown as CoreFileDocument;
    assert(pdf.kind === "pdf" && pdf.readonly, "PDF lost its read-only file boundary");
    await scene("preview-pdf", {
      actualFileTree: true,
      actualPDFCanvas: true,
      readonly: pdf.readonly,
      ...rendered,
    });
    await close(previewQA.pdfFile);
    await open(editorFile);
    await until(
      () =>
        document
          .querySelector<HTMLElement>(".cm-content")
          ?.innerText.includes(savedEditorText.split("\r")[0]),
      "return to the original saved editor",
    );
    assert(
      !document.querySelector("iframe.html-preview,.pdf-reader"),
      "Closed previews retained their view",
    );
    assert(escapedMessages === 0, "Late preview script execution reached the app");
    await scene("preview-returned-editor", {
      originalEditorRestored: true,
      previewViewsReleased: true,
      escapedMessages,
    });
  } finally {
    window.removeEventListener("message", receive);
  }
}

async function runGit(context: Context) {
  const project = await until(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent?.trim() === "Temporary QA project",
      ),
    "selected QA project",
  );
  project.click();
  const entry = await until(
    () => document.querySelector<HTMLButtonElement>('.inspector-switcher button[title="Git"]'),
    "Git entry",
  );
  entry.click();
  const changed = await until(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>(".git-file")].find((b) =>
        b.textContent?.includes(gitQA.fileName),
      ),
    "Git changed file",
  );
  changed.click();
  await until(
    () => document.querySelector(".git-diff")?.textContent?.includes("TAURI_GIT_DIFF"),
    "real Git diff",
  );
  const snapshot = await invoke<{ root: string; branch: string }>("git_snapshot", {
    directory: context.project,
  });
  assert(snapshot.branch === "main", "Git selected the wrong branch");
  await scene("git-diff", {
    root: snapshot.root,
    branch: snapshot.branch,
    selectedDirectory: context.project,
    exactUnicode: true,
  });
  await click("History");
  (
    await until(
      () => document.querySelector<HTMLButtonElement>(".git-commit"),
      "Git history commit",
    )
  ).click();
  await until(
    () =>
      document
        .querySelector(".git-commit-message")
        ?.textContent?.includes("Isolated Tauri Git fixture"),
    "Git commit details",
  );
  await scene("git-history", { realCommitDetails: true });
  async function referenceMenu() {
    const reference = await until(
      () => document.querySelector<HTMLButtonElement>('[data-node="refs/heads/main"]'),
      "main branch reference",
    );
    reference.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 250,
        clientY: 200,
      }),
    );
  }
  const catalog = (await coreRequest("git.references", {
    directory: context.project,
  })) as unknown as { repository: string };
  const favoriteKey = `uterm.git.favorites:${catalog.repository}`;
  const frozenFavoriteSource = localStorage.getItem(favoriteKey);
  await until(
    () => document.querySelector('[data-node="refs/heads/main"]')?.textContent?.includes("★"),
    "imported old Git favorite",
  );
  await referenceMenu();
  await click("Unfavorite");
  await until(async () => {
    const saved = (await observeCore("git.favorites.read", {
      directory: context.project,
    })) as unknown as { references: string[] };
    return saved.references.length === 0;
  }, "shared favorite removed by actual Tauri menu");
  await referenceMenu();
  await click("Favorite branch");
  await until(
    () => document.querySelector('[data-node="refs/heads/main"]')?.textContent?.includes("★"),
    "shared favorite restored by actual Tauri menu",
  );
  assert(
    localStorage.getItem(favoriteKey) === frozenFavoriteSource,
    "Favorite actions changed frozen old source",
  );
  const oldBackup = Object.keys(localStorage).find((key) =>
    key.startsWith(`${favoriteKey}.shared-v1-backup.`),
  );
  assert(
    oldBackup && localStorage.getItem(oldBackup) === frozenFavoriteSource,
    "Old favorite backup differs",
  );
  assert(localStorage.getItem(`${favoriteKey}.shared-v1`), "Missing favorite handoff receipt");
  await scene("git-favorites", {
    sharedCore: true,
    exactOldSourceRetained: true,
    menuRemoveAndRestore: true,
    versionedBackup: true,
    receipt: true,
  });
  await runFavoriteRecovery(context);
  function input(label: string, value: string) {
    const field = document.querySelector<HTMLInputElement>(
      `dialog[open] input[aria-label="${label}"]`,
    );
    assert(field, `Missing Git form field: ${label}`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await referenceMenu();
  await click("New branch");
  input("Branch name", "qa-tauri-created");
  await pause(100);
  await click("New branch");
  await until(
    () => document.querySelector('[data-node="refs/heads/qa-tauri-created"]'),
    "new shared branch",
  );
  await scene("git-created-branch", {
    createdBranch: "qa-tauri-created",
    currentBranchUnchanged: true,
  });
  await referenceMenu();
  await click("New worktree");
  await until(
    () =>
      document.querySelector<HTMLInputElement>(
        'dialog[open] input[aria-label="Worktree directory"]',
      )?.value,
    "Worktree suggestion",
  );
  const worktree = context.root + "/" + gitQA.worktreeName;
  input("Branch name", "qa-tauri-worktree");
  await pause(100);
  input("Worktree directory", worktree);
  await pause(100);
  await click("New worktree");
  await until(async () => {
    const shared = (await observeCore("snapshot.read")) as unknown as {
      document: {
        workspace: { projects: { id: string; worktrees?: { path: string; branch: string }[] }[] };
      };
    };
    return shared.document.workspace.projects
      .find((p) => p.id === "shared-state-qa")
      ?.worktrees?.some((w) => w.branch === "qa-tauri-worktree");
  }, "durable Worktree sidebar registration");
  await until(() => !document.querySelector("dialog[open]"), "Worktree dialog dismissed");
  await scene("git-worktree", {
    branch: "qa-tauri-worktree",
    sharedWorkspaceRegistered: true,
    temporaryDirectory: worktree,
  });
  await runWorktreeDeletion();
  await runGitWriteExit(context);
  await invoke("qa_request_exit");
}

async function runGitWriteExit(context: Context) {
  await scene("git-write-prepared", { realPostCheckoutHook: true });
  const scope = new ContentScope(tauriContentPort, "qa-git-cancel-exit"),
    controller = new AbortController();
  let settled = false;
  const pending = scope
    .call(
      "git_switch_branch",
      {
        directory: context.project,
        branch: "qa-tauri-created",
        expected: "main",
      },
      controller.signal,
    )
    .then(
      () => {
        throw Error("Cancelled Git write delivered late success");
      },
      (reason) => {
        assert(reason.code === "CANCELLED", "Git cancellation lost its error code");
      },
    )
    .finally(() => {
      settled = true;
    });
  await scene("git-write-started", { actualIPCDispatched: true });
  controller.abort();
  await invoke("qa_request_exit");
  await until(
    () =>
      document.body.textContent?.includes(
        "Wait for the current operation to finish before quitting.",
      ),
    "backend Git operation exit guard",
  );
  assert(!settled, "Git cancellation released its caller before the backend write ended");
  await scene("git-write-quit-blocked", {
    cancelledCallerProtected: true,
    normalQuitRefused: true,
  });
  await pending;
  scope.close();
  const snapshot = await invoke<{ branch: string }>("git_snapshot", { directory: context.project });
  assert(snapshot.branch === "qa-tauri-created", "The actual Git write did not complete");
  await scene("git-write-completed", {
    cancellationSuppressedLateSuccess: true,
    finalBranch: snapshot.branch,
  });
}

async function runWorktreeDeletion() {
  const stored = async () =>
    (await observeCore("snapshot.read")) as unknown as {
      document: {
        workspace: { projects: { id: string; worktrees?: { id: string; path: string }[] }[] };
      };
    };
  const project = (await stored()).document.workspace.projects.find(
    (item) => item.id === "shared-state-qa",
  );
  const worktree = project?.worktrees?.find((item) => item.path.includes(gitQA.worktreeName));
  assert(worktree, "Shared QA Worktree was not registered");
  const row = () =>
    [...document.querySelectorAll<HTMLButtonElement>(".folder-row .row-label")].find((button) =>
      button.title.includes(gitQA.worktreeName),
    );
  async function review() {
    if (!row()) {
      const parent = await until(
        () =>
          document.querySelector<HTMLButtonElement>(
            '.folder-row[data-project-id="shared-state-qa"] .row-label',
          ),
        "owning project sidebar row",
      );
      if (parent.getAttribute("aria-expanded") === "false") parent.click();
    }
    const target = await until(row, "actual Worktree sidebar row");
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 180,
        clientY: 350,
      }),
    );
    await click("Delete worktree");
    const dialog = await until(
      () => document.querySelector<HTMLDialogElement>(".worktree-delete-dialog[open]"),
      "real application delete confirmation",
    );
    assert(
      dialog.textContent?.includes(gitQA.worktreeName),
      "Deletion review omitted the target path",
    );
    assert(
      document.activeElement?.textContent?.trim() === "Cancel",
      "Delete confirmation did not default to Cancel",
    );
  }
  async function confirm() {
    const button = document.querySelector<HTMLButtonElement>(
      '.worktree-delete-dialog button[type="submit"]',
    );
    assert(button, "Delete confirmation action is missing");
    button.click();
    await until(
      () => !document.querySelector(".worktree-delete-dialog[open]"),
      "confirmation handed off to guarded deletion",
    );
  }
  await review();
  await scene("git-worktree-delete-review", {
    cancelDefault: true,
    literalPathVisible: true,
    worktreeId: worktree.id,
  });
  await click("Cancel");
  await until(() => !document.querySelector(".worktree-delete-dialog[open]"), "Cancel deletion");
  assert(
    (await stored()).document.workspace.projects
      .find((item) => item.id === project!.id)
      ?.worktrees?.some((item) => item.id === worktree.id),
    "Cancel removed shared metadata",
  );
  await review();
  await confirm();
  await until(
    () =>
      /modified|untracked|uncommitted|dirty/i.test(
        document.querySelector(".workspace-error")?.textContent ?? "",
      ),
    "actual dirty Worktree refusal",
  );
  await scene("git-worktree-delete-dirty", {
    dirtyRefused: true,
    explicitRetryRequired: true,
    worktreeId: worktree.id,
  });
  await review();
  await scene("git-worktree-delete-stale", {
    projectId: project!.id,
    worktreeId: worktree.id,
    capturedReview: true,
  });
  await confirm();
  await until(
    () => document.querySelector(".workspace-error")?.textContent?.includes("Snapshot changed"),
    "stale reviewed snapshot refusal",
  );
  await scene("git-worktree-delete-conflict", {
    staleReviewRejected: true,
    worktreeId: worktree.id,
  });
  await click("Reload workspace");
  await until(() => !button("Reload workspace"), "explicit workspace reload completed");
  await review();
  await scene("git-worktree-delete-fresh-review", {
    explicitlyReloaded: true,
    worktreeId: worktree.id,
  });
  await confirm();
  await until(
    async () =>
      !(await stored()).document.workspace.projects
        .find((item) => item.id === project!.id)
        ?.worktrees?.some((item) => item.id === worktree.id),
    "actual Git deletion and metadata commit",
  );
  await until(() => !row(), "removed Worktree disappeared from sidebar");
  await scene("git-worktree-deleted", {
    cleanDeleted: true,
    sharedMetadataRemoved: true,
    worktreeId: worktree.id,
  });
}

async function runFavoriteRecovery(context: Context) {
  const favorites = (await observeCore("git.favorites.read", {
    directory: context.project,
  })) as unknown as CoreGitFavorites;
  const checkpoint = (await coreRequest("git.favorites.write", {
    directory: context.project,
    expectedRevision: favorites.revision,
    references: [],
  })) as unknown as CoreGitFavorites;
  await coreRequest("git.favorites.write", {
    directory: context.project,
    expectedRevision: checkpoint.revision,
    references: favorites.references,
  });
  const initial = (await observeCore(
    "git.favorites.recovery.list",
  )) as unknown as CoreGitFavoriteRecoveryCatalog;
  assert(initial.currentRevision && favorites.sourceDigest, "Missing recovery snapshot or source");
  assert(
    initial.backups.includes(initial.currentRevision),
    "Current favorite snapshot was not retained",
  );
  const revision = initial.currentRevision;
  await scene("git-favorite-recovery-ready", { revision, sourceDigest: favorites.sourceDigest });
  async function open() {
    const entry = await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          '.git-tree-tools button[aria-label="Recover Git favorites…"]',
        ),
      "actual favorite recovery toolbar action",
    );
    entry.click();
    await until(
      () => document.querySelector(".git-favorite-recovery-dialog[open]"),
      "actual favorite recovery dialog",
    );
  }
  async function select(value: string, source = false) {
    let selected = false;
    let reloads = 0;
    await until(() => {
      const dialog = document.querySelector(".git-favorite-recovery-dialog[open]");
      const error = dialog?.querySelector('[role="alert"]')?.textContent ?? "";
      if (error.includes("Another writer owns the canonical store") && reloads < 3) {
        const reload = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
          (button) => button.textContent?.trim() === "Reload recovery copies",
        );
        if (reload && !reload.disabled) {
          reload.click();
          reloads++;
          favoritePreviewReloads++;
          selected = false;
          return false;
        }
      }
      const field = dialog?.querySelector<HTMLSelectElement>("select");
      if (!field || field.disabled || ![...field.options].some((option) => option.value === value))
        return false;
      if (!selected || field.value !== value) {
        field.value = value;
        field.dispatchEvent(new Event("change", { bubbles: true }));
        selected = true;
        return false;
      }
      const text = dialog?.querySelector<HTMLTextAreaElement>("textarea")?.value;
      return (
        !button("Copy full preview")?.disabled &&
        text !== undefined &&
        text.trimStart().startsWith("[") === source
      );
    }, "verified favorite recovery preview after explicit read-only reload");
    assert(
      button("Restore all repository favorites")?.disabled === source,
      "Original source must not directly replace favorites",
    );
  }
  async function closed() {
    await until(
      () => !document.querySelector(".git-favorite-recovery-dialog[open]"),
      "recovery dialog closed",
    );
  }
  await until(() => button("Recover Git favorites…"), "visible real corrupt favorite error");
  await scene("git-favorite-recovery-lock-ready", { actualErrorEntry: true });
  await click("Recover Git favorites…");
  await until(
    () =>
      document
        .querySelector('.git-favorite-recovery-dialog[open] [role="alert"]')
        ?.textContent?.includes("Another writer owns the canonical store"),
    "actual canonical writer lock rejects the read-only recovery preview",
  );
  assert(button("Restore all repository favorites")?.disabled, "Busy preview enabled restoration");
  await scene("git-favorite-recovery-busy", {
    canonicalWriterBusy: true,
    restoreDisabled: true,
    readOnlyFailure: true,
  });
  await select(`backup:${revision}`);
  assert(
    favoritePreviewReloads > 0,
    "The busy preview did not use explicit Reload recovery copies",
  );
  assert(
    document.activeElement?.textContent === "Cancel",
    "Cancel is not the initial recovery action",
  );
  await scene("git-favorite-recovery-preview", {
    actualErrorEntry: true,
    cancelDefault: true,
    verifiedAllRepositoryPreview: true,
    recoveredAfterOwnedWriterReleased: true,
  });
  await click("Cancel");
  await closed();
  await open();
  await select(`source:${favorites.sourceDigest}`, true);
  await click("Copy full preview");
  await until(
    () =>
      document.querySelector(".git-favorite-recovery-dialog [role=status]")?.textContent ===
      "Copied the full preview.",
    "native clipboard copy acknowledgement",
  );
  await scene("git-favorite-recovery-source", {
    sourceDigest: favorites.sourceDigest,
    sourceCannotRestore: true,
    fullSourceCopied: true,
  });
  await click("Cancel");
  await closed();
  await open();
  await select(`backup:${revision}`);
  await scene("git-favorite-recovery-stale", { revision, pinnedCurrentFile: true });
  await click("Restore all repository favorites");
  await until(
    () =>
      document
        .querySelector(".git-favorite-recovery-dialog [role=alert]")
        ?.textContent?.includes("changed"),
    "visible actual stale restore conflict",
  );
  await scene("git-favorite-recovery-conflict", {
    staleRestoreRejected: true,
    explicitReloadRequired: true,
  });
  await click("Reload recovery copies");
  await select(`backup:${revision}`);
  await click("Restore all repository favorites");
  await closed();
  await until(
    () => document.querySelector('[data-node="refs/heads/main"]')?.textContent?.includes("★"),
    "Git favorites refreshed after actual restore",
  );
  await scene("git-favorite-recovery-restored", {
    verifiedSnapshotRestored: true,
    damagedBytesRetained: true,
    gitViewRefreshed: true,
  });
  await open();
  await select(`backup:${revision}`);
  await scene("git-favorite-recovery-missing", {
    explicitMissingRestore: true,
    previewReadonly: true,
  });
  await click("Restore all repository favorites");
  await closed();
  const restored = (await observeCore("git.favorites.read", {
    directory: context.project,
  })) as unknown as CoreGitFavorites;
  assert(
    JSON.stringify(restored.references) === JSON.stringify(favorites.references),
    "Missing favorite restore lost references",
  );
  await scene("git-favorite-recovery-complete", {
    exactReferencesRestored: true,
    explicitMissingRestore: true,
  });
}

async function runInputControl(context: Context) {
  const owner = context.phase === "input-owner";
  const previous = new Set(
    [...document.querySelectorAll<HTMLElement>("[data-session-id]")].map(
      (element) => element.dataset.sessionId,
    ),
  );
  if (owner) {
    const project = await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          '.folder-row[data-project-id="shared-state-qa"] > .row-label',
        ),
      "visible ownership QA project",
    );
    project.click();
    await until(async () => {
      const snapshot = (await observeCore("snapshot.read")) as unknown as {
        document: { workspace: { selectedProject: string; selectedWorktree: string | null } };
      };
      return (
        snapshot.document.workspace.selectedProject === "shared-state-qa" &&
        snapshot.document.workspace.selectedWorktree === null
      );
    }, "committed ownership project selection");
    // Finish queued project changes and the React commit before activating the next control.
    // 激活下一个控件前，先完成排队的项目变更与 React 界面提交。
    await flushSharedState();
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    await until(() => {
      const value = document.querySelector<HTMLButtonElement>(".welcome-action.primary");
      if (
        !document.querySelector('.folder-row.selected[data-project-id="shared-state-qa"]') ||
        !value?.isConnected ||
        value.disabled ||
        value.closest('[inert], [hidden], [aria-hidden="true"]') ||
        value.querySelector("strong")?.textContent !== "New terminal" ||
        value.getBoundingClientRect().width <= 0
      )
        return null;
      value.click();
      return true;
    }, "new actual terminal button");
    await flushSharedState();
  }
  let section: HTMLElement;
  try {
    section = await until(async () => {
      const value = await selectedVisibleTerminal();
      return value && (!owner || !previous.has(value.dataset.sessionId)) ? value : null;
    }, "visible real terminal");
  } catch (reason) {
    let selection: unknown;
    try {
      const snapshot = (await observeCore("snapshot.read")) as unknown as {
        document: { workspace: Workspace };
      };
      const state = snapshot.document.workspace;
      selection = {
        workspace: state.selectedWorkspace ?? null,
        project: state.selectedProject,
        worktree: state.selectedWorktree ?? null,
        session: state.selectedSession,
        projectSessions: state.projects
          .find((project) => project.id === "shared-state-qa")
          ?.sessions.map((session) => session.id),
      };
    } catch (error) {
      selection = { error: String(error) };
    }
    const views = [
      ...document.querySelectorAll<HTMLElement>(".local-session[data-session-id]"),
    ].map((view) => ({
      id: view.dataset.sessionId,
      visible: view.classList.contains("visible"),
      width: view.getBoundingClientRect().width,
      height: view.getBoundingClientRect().height,
    }));
    throw Error(
      `${String(reason)}; terminal selection: ${JSON.stringify({ selection, previous: [...previous], views })}`,
    );
  }
  await until(
    () => section.querySelector('.terminal-status[aria-label="Running"]'),
    "real terminal running",
  );
  const readonly = () => section.querySelector("[data-terminal-take-control]");
  const writable = () => {
    const field = section.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    return !!field && !field.readOnly && !field.disabled && !readonly();
  };
  const display = () => {
    const screen = section.querySelector<HTMLElement>(".xterm-screen");
    const bounds = screen?.getBoundingClientRect();
    const rows = [...section.querySelectorAll(".xterm-accessibility-tree > div")];
    return {
      text: rows.map((row) => row.textContent ?? "").join(""),
      rows: rows.length,
      width: bounds?.width ?? 0,
      height: bounds?.height ?? 0,
      canvases: [...section.querySelectorAll("canvas")].map((canvas) => ({
        width: canvas.width,
        height: canvas.height,
      })),
    };
  };
  const rendered = async (marker: string) => {
    try {
      return await until(() => {
        const value = display();
        return value.width > 0 && value.height > 0 && value.text.includes(marker) && value;
      }, `actual terminal accessibility rows display ${marker}`);
    } catch (reason) {
      throw Error(`${String(reason)}; terminal display: ${JSON.stringify(display())}`);
    }
  };
  const recoverRenderer = async (marker: string) => {
    const contexts = [...section.querySelectorAll<HTMLCanvasElement>(".xterm-screen canvas")]
      .map((canvas) => canvas.getContext("webgl2"))
      .filter((context): context is WebGL2RenderingContext => context !== null);
    if (contexts.length) {
      assert(contexts.length === 1, "Unexpected multiple WebGL terminal contexts");
      const loss = contexts[0].getExtension("WEBGL_lose_context");
      assert(loss, "The actual WebGL context cannot exercise context-loss recovery");
      loss.loseContext();
    }
    const domText = await until(() => {
      const text = [...section.querySelectorAll(".xterm-rows > div")]
        .map((row) => row.textContent ?? "")
        .join("");
      return text.includes(marker) && text;
    }, "actual terminal DOM fallback renders the same shell output");
    return {
      initialRenderer: contexts.length ? "webgl2" : "dom",
      injectedContextLoss: contexts.length === 1,
      recoveredRenderer: "dom",
      domText,
      terminalDisplay: await rendered(marker),
    };
  };
  let rendererRecovery: Awaited<ReturnType<typeof recoverRenderer>>;
  const send = (command: string) => {
    const field = section.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    assert(field, "Missing actual xterm input field");
    field.focus();
    const data = new DataTransfer();
    data.setData("text/plain", command);
    field.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    field.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      }),
    );
  };
  const file = async (path: string): Promise<string | null> => {
    try {
      return (
        (await coreRequest("files.read", { directory: context.project, path })) as unknown as {
          text: string;
        }
      ).text;
    } catch (reason) {
      if (
        /No such file|cannot find|not found|找不到|不存在/i.test(
          String((reason as { message?: string }).message ?? reason),
        )
      )
        return null;
      throw reason;
    }
  };
  const sendMarker = (value: string, path: string) => {
    assert(
      /^[A-Z_]+$/.test(value) && /^[a-z-]+\.txt$/.test(path),
      "Only static shell markers are allowed",
    );
    send(
      context.platform === "windows"
        ? `'${value}' | Set-Content -Encoding UTF8 '${path}'`
        : `echo ${value} > ${path}`,
    );
  };
  const host = async () =>
    (await invoke("qa_host_status")) as {
      pid: number;
      sessions: { spec: { id: string }; generation: string }[];
    };
  const initial = await host();
  const session = initial.sessions.find((s) => s.spec.id === section.dataset.sessionId);
  assert(session, "The visible terminal has no actual hosted process");
  const identity = {
    sessionID: session.spec.id,
    generation: session.generation,
    hostPID: initial.pid,
    manualKeyboardClipboardAcceptance: false,
  };
  if (owner) {
    const initialInput = await until(() => {
      const prompt = display().text.replaceAll("\u00a0", " ").trimEnd();
      return writable() && /[$#>%]$/.test(prompt) && { writable: true, prompt: prompt.slice(-256) };
    }, "initial actual shell prompt and writable xterm input");
    sendMarker("OWNER_READY", "owner-input.txt");
    await until(
      async () => (await file("owner-input.txt"))?.includes("OWNER_READY"),
      "actual original owner input side effect",
    );
    await scene("input-owner-gpu-ready", {
      ...identity,
      initialInput,
      actualInput: true,
      terminalDisplay: await rendered("OWNER_READY"),
    });
    rendererRecovery = await recoverRenderer("OWNER_READY");
    await scene("input-owner-ready", {
      ...identity,
      initialInput,
      actualInput: true,
      rendererRecovery,
    });
    await until(readonly, "old owner becomes readonly after viewer takeover");
    sendMarker("STALE_OWNER", "stale-owner.txt");
    await until(
      async () => (await file("viewer-input.txt"))?.includes("VIEWER_READY"),
      "new owner output side effect",
    );
    await scene("input-owner-readonly", {
      ...identity,
      passive: true,
      terminalDisplay: await rendered("VIEWER_READY"),
      rendererRecovery,
    });
    assert(
      (await file("stale-owner.txt")) === null && (await file("passive-viewer.txt")) === null,
      "Passive UI input reached the real shell",
    );
    const take = readonly() as HTMLButtonElement;
    assert(take && !take.disabled, "Take input control is unavailable after viewer exit");
    let clickObserved = false;
    take.addEventListener("click", () => (clickObserved = true), { once: true });
    take.click();
    try {
      await until(writable, "original client explicitly reacquires after ordinary viewer exit");
    } catch (reason) {
      const field = section.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      throw Error(
        `${String(reason)}; control diagnostics: ${JSON.stringify({
          clickObserved,
          sectionConnected: section.isConnected,
          sectionInert: !!section.closest("[inert]"),
          buttonConnected: take.isConnected,
          buttonDisabled: take.disabled,
          fieldReadonly: field?.readOnly,
          fieldDisabled: field?.disabled,
          status: section.querySelector(".terminal-status")?.getAttribute("aria-label"),
        })}`,
      );
    }
    sendMarker("OWNER_RETURNED", "owner-returned.txt");
    await until(
      async () => (await file("owner-returned.txt"))?.includes("OWNER_RETURNED"),
      "input survives the other application's ordinary exit",
    );
    const retained = await host();
    assert(
      retained.pid === initial.pid &&
        retained.sessions.some(
          (s) => s.spec.id === session.spec.id && s.generation === session.generation,
        ),
      "Takeover or quit replaced the process",
    );
    await scene("input-owner-returned", {
      ...identity,
      passiveInputRejected: true,
      sameHostAndGeneration: true,
      viewerQuitRetainedProcess: true,
      terminalDisplay: await rendered("OWNER_RETURNED"),
      rendererRecovery,
    });
    const close = document.querySelector<HTMLButtonElement>(".session-close");
    assert(close, "Close Session is unavailable");
    close.click();
    await until(
      async () => !(await host()).sessions.some((s) => s.spec.id === session.spec.id),
      "explicit close removes the exact process",
    );
    await scene("input-owner-closed", { ...identity, explicitClose: true });
  } else {
    await until(readonly, "second actual application attaches readonly");
    sendMarker("PASSIVE", "passive-viewer.txt");
    await scene("input-viewer-gpu-readonly", {
      ...identity,
      passive: true,
      terminalDisplay: await rendered("OWNER_READY"),
    });
    rendererRecovery = await recoverRenderer("OWNER_READY");
    await scene("input-viewer-readonly", { ...identity, passive: true, rendererRecovery });
    const take = readonly() as HTMLButtonElement;
    assert(take && !take.disabled, "The real take-control button is unavailable");
    take.click();
    await until(writable, "explicit take-control enables actual xterm input");
    sendMarker("VIEWER_READY", "viewer-input.txt");
    await until(
      async () => (await file("viewer-input.txt"))?.includes("VIEWER_READY"),
      "new owner sends actual terminal input",
    );
    assert(
      (await file("passive-viewer.txt")) === null,
      "Passive clipboard input was replayed after takeover",
    );
    await scene("input-viewer-owned", {
      ...identity,
      actualInput: true,
      explicitTakeover: true,
      passiveInputDiscarded: true,
      terminalDisplay: await rendered("VIEWER_READY"),
      rendererRecovery,
    });
  }
  await invoke("qa_request_exit");
}

async function sshRenderedOutput(terminal: HTMLElement) {
  const contexts = [...terminal.querySelectorAll<HTMLCanvasElement>(".xterm-screen canvas")]
    .map((canvas) => canvas.getContext("webgl2"))
    .filter((context): context is WebGL2RenderingContext => context !== null);
  assert(contexts.length <= 1, "Unexpected multiple SSH terminal WebGL contexts");
  // Exercise the shipped fallback; accessibility text alone cannot prove a visible capture.
  // 验证应用实际交付的回退；仅无障碍文本不能证明截图中的可见输出。
  if (contexts.length) {
    const loss = contexts[0].getExtension("WEBGL_lose_context");
    assert(loss, "SSH terminal cannot exercise actual renderer recovery");
    loss.loseContext();
  }
  const output = await until(() => {
    const row = [...terminal.querySelectorAll<HTMLElement>(".xterm-rows > div")].find((element) =>
      element.textContent?.includes("UTERM_SSH_TAURI_QA"),
    );
    const bounds = row?.getBoundingClientRect();
    return row && bounds && bounds.width > 0 && bounds.height > 0
      ? { domText: row.textContent, width: bounds.width, height: bounds.height }
      : null;
  }, "actual SSH terminal DOM fallback displays authenticated output");
  await new Promise<void>((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );
  return {
    initialRenderer: contexts.length ? "webgl2" : "dom",
    injectedContextLoss: contexts.length === 1,
    recoveredRenderer: "dom",
    ...output,
  };
}

async function runSSH(context: Context) {
  const fixture = await invoke<{
    alias: string;
    remote: string;
    port: string;
    previous?: { sessionID: string; generation: string; hostPID: number; connectionID: string };
  }>("qa_ssh_fixture");
  const host = () =>
    invoke<{
      pid: number;
      sessions: {
        spec: { id: string; ssh?: { host: string; connection_id: string } };
        generation: string;
        running: boolean;
      }[];
    }>("qa_host_status");
  if (context.phase === "ssh-reopen") {
    const previous = fixture.previous;
    assert(previous, "Missing previous actual SSH session");
    const terminal = await until(async () => {
      const value = await selectedVisibleTerminal();
      return value?.querySelector('.terminal-status[aria-label="Running"]') ? value : null;
    }, "reattached remote terminal");
    assert(terminal.dataset.sessionId === previous.sessionID, "Reopen selected another session");
    const status = await host();
    const session = status.sessions.find((item) => item.spec.id === previous.sessionID);
    assert(
      status.pid === previous.hostPID &&
        session?.generation === previous.generation &&
        session.running &&
        session.spec.ssh?.host === fixture.alias &&
        session.spec.ssh.connection_id === previous.connectionID,
      "Quit replaced or stopped the hosted SSH session",
    );
    await until(
      () => terminal.textContent?.includes("UTERM_SSH_TAURI_QA"),
      "SSH replay after actual app quit and reopen",
    );
    await scene("ssh-reopened", {
      ...previous,
      authenticatedRemoteReplay: true,
      sameHostAndGeneration: true,
      rendererRecovery: await sshRenderedOutput(terminal),
    });
    await invoke("qa_request_exit");
    return;
  }
  const create = await until(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Add SSH connection"]'),
    "add real SSH profile",
  );
  create.click();
  await until(() => document.querySelector(".ssh-connection-dialog[open]"), "SSH profile dialog");
  await click("OpenSSH configuration");
  const field = async (scope: string, label: string, value: string) => {
    const control = await until(
      () =>
        [...document.querySelectorAll(`${scope} label`)]
          .find((item) => item.textContent?.trim().startsWith(label))
          ?.querySelector<HTMLInputElement | HTMLSelectElement>("input,select"),
      `SSH field ${label}`,
    );
    const prototype =
      control instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
    await pause(50);
  };
  const dialog = ".ssh-connection-dialog[open]";
  await field(dialog, "SSH Host alias", fixture.alias);
  const advanced = document.querySelector<HTMLDetailsElement>(`${dialog} details`);
  assert(advanced, "SSH advanced settings missing");
  advanced.open = true;
  await field(dialog, "Connection name (optional)", sshQA.profileName);
  await field(dialog, "Remote system", context.platform === "windows" ? "windows" : "posix");
  await field(dialog, "Remote file root", fixture.remote.replaceAll("\\", "/"));
  await scene("ssh-profile", { realNativeApplication: true, isolatedOpenSSH: true });
  await until(() => button("Save only")?.disabled === false, "SSH configuration ready");
  await click("Save only");
  await until(() => !document.querySelector(dialog), "SSH profile saved");
  await click(sshQA.profileName);
  await click("Remote files");
  await click("Connect files");
  const file = await until(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>(".file-row")].find((item) =>
        item.textContent?.includes(sshQA.originalFile),
      ),
    "actual SFTP listing",
  );
  file.click();
  await until(
    () => document.body.innerText.includes(sshQA.previewText),
    "actual remote text preview",
  );
  await scene("ssh-files", {
    actualSFTP: true,
    unicodeFileListingAndPreview: true,
    actualRemoteBytes: sshQA.previewText,
  });
  await click("New SSH terminal");
  const terminal = await until(async () => {
    const value = await selectedVisibleTerminal();
    // Selection precedes host startup; inspect identity only after attach succeeds.
    // 选择状态早于宿主启动，只在附着成功后核对身份。
    if (!value?.querySelector('.terminal-status[aria-label="Running"]')) return null;
    const status = await host();
    return status.sessions.some(
      (session) =>
        session.spec.id === value.dataset.sessionId && session.spec.ssh?.host === fixture.alias,
    )
      ? value
      : null;
  }, "real remote terminal");
  const input = await until(() => {
    const value = terminal.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    const parsed = terminalPerformanceSnapshot(terminal.dataset.sessionId ?? "");
    return value &&
      !value.readOnly &&
      !value.disabled &&
      parsed?.writable &&
      !parsed.waitingToRender
      ? value
      : null;
  }, "owned remote terminal input");
  // A started SSH process can still be authenticating; send input after its remote prompt is parsed.
  // SSH 进程启动后仍可能正在认证，须在远端提示符完成解析后发送输入。
  await until(() => {
    const parsed = terminalPerformanceSnapshot(terminal.dataset.sessionId ?? "");
    return parsed?.writable && /[$#%>]\s*$/.test(parsed.text.trimEnd());
  }, "authenticated remote shell prompt before input");
  input.focus();
  const clipboard = new DataTransfer();
  clipboard.setData(
    "text/plain",
    context.platform === "windows"
      ? `powershell -NoProfile -Command "Write-Output ('UTERM_' + 'SSH_TAURI_QA')"`
      : "printf 'UTERM_%s\\n' 'SSH_TAURI_QA'",
  );
  input.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }),
  );
  await pause(100);
  for (const type of ["keydown", "keyup"])
    input.dispatchEvent(
      new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
  await until(
    () => terminal.textContent?.includes("UTERM_SSH_TAURI_QA"),
    "authenticated remote shell output",
  );
  const status = await host();
  const session = status.sessions.find((item) => item.spec.id === terminal.dataset.sessionId);
  assert(
    session?.running && session.spec.ssh?.host === fixture.alias,
    "The visible process is not the expected SSH session",
  );
  await scene("ssh-terminal", {
    sessionID: session.spec.id,
    generation: session.generation,
    hostPID: status.pid,
    connectionID: session.spec.ssh.connection_id,
    actualRemoteShell: true,
    renderedOutput: "UTERM_SSH_TAURI_QA",
    input: "DOM paste/key events through real xterm",
    manualPickerAndIMEAcceptance: false,
    rendererRecovery: await sshRenderedOutput(terminal),
  });
  await invoke("qa_request_exit");
}

export async function run(recovery: boolean) {
  try {
    const context = await invoke<Context>("qa_context");
    if (recovery) {
      assert(context.phase === "recover", "Unexpected recovery before corruption");
      await until(() => document.querySelector('[role="alert"]'), "recovery error");
      await scene("corrupt-store", { errorVisible: true });
      await click("View recovery copies");
      const label = `Restore from copy ${context.backup?.slice(0, 12)}`;
      await until(() => button(label), "chosen valid backup");
      await scene("recovery-copies", { backupListed: context.backup });
      await click(label);
      return;
    }
    await until(async () => (await invoke<Context>("qa_context")).ready, "normal quit listener");
    if (context.phase === "ui-parity") {
      await runUiParity();
      return;
    }
    if (context.phase === "performance") {
      await runPerformance(context, scene, observeCore);
      return;
    }
    if (context.phase === "updates") {
      await runUpdates(context, scene, observeCore);
      return;
    }
    if (context.phase === "package") {
      const snapshot = (await observeCore("snapshot.read")) as unknown as {
        document: { settings: typeof defaults; workspace: { projects: unknown[] } };
      };
      assert(
        context.identifier === "sh.uterm.desktop.qa.sharedstate",
        "Candidate identity is not isolated",
      );
      assert(
        snapshot.document.settings.automaticUpdates === false,
        "Candidate enabled automatic updates",
      );
      assert(
        snapshot.document.workspace.projects.length === 0,
        "Candidate opened non-fixture projects",
      );
      await until(
        () => document.querySelector("[data-sidebar-style]"),
        "installed application window",
      );
      assert(!document.querySelector('[role="alert"]'), "Candidate startup error is visible");
      await scene("installed-start", {
        installedApplicationStarted: true,
        coreReady: true,
        automaticUpdates: false,
        productionDataAccess: false,
        productionDeepLinkRegistered: false,
        identifier: context.identifier,
      });
      await invoke("qa_request_exit");
      return;
    }
    assert(localStorage.getItem(backupKey) === sentinel, "Auxiliary backup was changed");
    if (context.phase === "input-owner" || context.phase === "input-viewer") {
      await runInputControl(context);
      return;
    }
    if (context.phase === "editor-checkpoint" || context.phase === "editor-reopen") {
      await runEditor(context);
      return;
    }
    if (context.phase === "git") {
      await runGit(context);
      return;
    }
    if (context.phase === "ssh" || context.phase === "ssh-reopen") {
      await runSSH(context);
      return;
    }
    if (context.phase === "redis") {
      await runRedis(scene, () => observeCore("snapshot.read"));
      return;
    }
    if (context.phase === "database") {
      await runDatabase(scene, () => observeCore("snapshot.read"));
      return;
    }
    if (context.phase === "agents") {
      await runAgents(scene, () => observeCore("snapshot.read"));
      return;
    }
    if (context.phase === "initial") {
      assert(
        (await settings()).fileFontSize === defaults.fileFontSize,
        "Old defaults were not imported",
      );
      await openSettings();
      await click("Local control");
      const control = await until(
        () =>
          document.querySelector<HTMLInputElement>(
            '.settings-content input[type="checkbox"]:not(:disabled)',
          ),
        "control checkbox",
      );
      control.click();
      await until(() => control.checked, "control enabled by the actual settings UI");
      await scene("control-ready", { enabled: true });
      control.click();
      await until(() => !control.checked, "control disabled by the actual settings UI");
      await scene("control-disabled", { enabled: false });
      await click("Appearance");
      await editFont(18);
      await until(
        () =>
          getComputedStyle(document.documentElement).getPropertyValue("--file-font-size").trim() ===
          "18px",
        "first durable save publication",
      );
      assert((await settings()).fileFontSize === 18, "Published value was not stored");
      showFont();
      await scene("saved", {
        fileFontSize: 18,
        published: getComputedStyle(document.documentElement)
          .getPropertyValue("--file-font-size")
          .trim(),
      });
      await invoke("qa_external_settings");
      await editFont(19);
      await until(
        () => document.querySelector('[aria-label="Unsaved settings"]'),
        "retained failed draft",
      );
      await until(() => document.querySelector(".settings-error"), "external writer conflict");
      const alert = document.querySelector(".settings-error")!;
      assert(
        alert.textContent?.includes("Snapshot changed"),
        "Expected revision conflict was not visible",
      );
      alert.scrollIntoView({ block: "center" });
      await scene("conflict-error", { revisionConflictVisible: true });
      showFont();
      assert(fontField()?.value === "19", "Conflict discarded the user's draft");
      assert((await settings()).fileFontSize === 17, "Stale UI overwrote the external change");
      await scene("conflict-draft", { draft: 19, stored: 17, errorVisible: true });
      document.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]')?.click();
      await openSettings();
      assert(fontField()?.value === "19", "Closing and reopening Settings lost the failed draft");
      showFont();
      await invoke("qa_request_exit");
      await pause(600);
      await scene("quit-blocked", {
        aliveAfterFailedSave: true,
        draftRetainedAfterSettingsReopen: true,
      });
      await click("Reload saved settings");
      assert(fontField()?.value === "19", "Reload discarded a conflicting field draft");
      showFont();
      await invoke("qa_request_exit");
      await pause(600);
      await scene("reload-draft", {
        draft: 19,
        externalFontSize: (await settings()).fontSize,
        quitBlocked: true,
      });
      await click("Retry saving settings");
      await until(
        () => !document.querySelector('[aria-label="Unsaved settings"]'),
        "draft cleared after successful save",
      );
      assert((await settings()).fileFontSize === 19, "Explicit retry did not persist the draft");
      showFont();
      await scene("retried", { fileFontSize: 19, fontSize: (await settings()).fontSize });
      const beforeTheme = await settings();
      const themeInput = document.querySelector<HTMLInputElement>(
        '.settings-content input[type="file"]',
      );
      assert(themeInput, "Theme import input missing");
      const importThemeFile = (source: string) => {
        Object.defineProperty(themeInput, "files", {
          configurable: true,
          value: [new File([source], "QA Theme.conf", { type: "text/plain" })],
        });
        themeInput.dispatchEvent(new Event("change", { bubbles: true }));
      };
      importThemeFile("background=invalid");
      const themeError = await until(
        () => document.querySelector<HTMLElement>(".settings-error"),
        "theme validation error",
      );
      assert(
        JSON.stringify(await settings()) === JSON.stringify(beforeTheme),
        "Rejected theme changed saved settings",
      );
      themeError.scrollIntoView({ block: "center" });
      await scene("theme-invalid", {
        invalidThemeVisible: true,
        savedSettingsUnchanged: true,
        fileSelection: "DOM File event in the real application; OS chooser not exercised",
      });
      importThemeFile("background=#162334\nforeground=#E1F0FF\npalette=1=#EF476F");
      await until(
        () => document.querySelector('option[value="custom-qa%20theme"]'),
        "saved shared theme publication",
      );
      const imported = await settings();
      assert(
        imported.darkTheme === "custom-qa%20theme" &&
          imported.customThemes.some(
            (theme) =>
              theme.id === imported.darkTheme &&
              theme.background === "#162334" &&
              theme.red === "#EF476F",
          ),
        "Actual shared theme import was not saved",
      );
      assert(!document.querySelector(".settings-error"), "Successful import retained an old error");
      document
        .querySelector('option[value="custom-qa%20theme"]')
        ?.parentElement?.scrollIntoView({ block: "center" });
      await scene("theme-imported", {
        actualCoreImport: true,
        customThemeSaved: true,
        invalidErrorCleared: true,
      });
    } else {
      const saved = await settings();
      assert(
        saved.fileFontSize === (context.phase === "recover" ? 17 : 19),
        "Reopen/recovery settings mismatch",
      );
      assert(saved.fontSize === 21, "Unrelated external change was lost");
      await openSettings();
      const input = await until(fontField, "reopened font field");
      showFont();
      assert(input.value === String(saved.fileFontSize), "Reopened view diverges from core");
      await scene(context.phase === "recover" ? "restored" : "reopened", {
        fileFontSize: saved.fileFontSize,
        fontSize: saved.fontSize,
        auxiliaryRetained: true,
      });
    }
    document.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]')?.click();
    await invoke("qa_request_exit");
  } catch (reason) {
    await scene("failure", {
      error: String(reason),
      body: document.body.innerText.slice(0, 4000),
      viewport: { innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio },
    });
  }
}
