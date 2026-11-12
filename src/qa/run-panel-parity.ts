import { invoke } from "@tauri-apps/api/core";
import { translate } from "../lib/i18n";
import { terminalPerformanceSnapshot } from "../lib/terminal-performance-qa";

type Scene = { language: "en" | "zh-Hans"; appearance: string; width: number; height: number };
type Fixture = { runPanelKinds: string[]; runPanelScenes: Scene[] };
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Run-panel parity timed out: " + label);
}
export async function runPanelParity(
  fixture: Fixture,
  configure: (scene: Scene) => Promise<void>,
  snapshot: () => Promise<string>,
  record: (name: string, checks: unknown) => Promise<void>,
) {
  const terminal = await until(
    () => document.querySelector('[data-session-id="ui-parity-0"]'),
    "retained terminal",
  );
  const host = await invoke<{ sessions: { spec: { id: string }; generation: string }[] }>(
    "qa_host_status",
  );
  const generation = host.sessions.find((entry) => entry.spec.id === "ui-parity-0")?.generation;
  assert(generation, "Missing actual terminal generation");
  const workspace = await snapshot();
  const unchanged = async () => {
    const after = await invoke<typeof host>("qa_host_status");
    assert(
      after.sessions.length === 1 &&
        after.sessions[0].spec.id === "ui-parity-0" &&
        after.sessions[0].generation === generation &&
        (await snapshot()) === workspace,
      "Run controls changed the canonical workspace or terminal generation",
    );
    assert(
      document.querySelector('[data-session-id="ui-parity-0"]') === terminal,
      "Run controls replaced the retained terminal",
    );
  };
  for (const scene of fixture.runPanelScenes) {
    await configure(scene);
    const filesTool = await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          `.inspector-switcher button[aria-label="${translate(scene.language, "文件")}"]`,
        ),
      "actual Files tool switcher",
    );
    assert(!filesTool.disabled, "Files tool switcher is disabled");
    filesTool.click();
    await until(() => {
      const row = document.querySelector<HTMLElement>('.file-row[data-path="README.md"]');
      const bounds = row?.getBoundingClientRect();
      return bounds && bounds.width > 0 && bounds.height > 0;
    }, "visible actual Files tree");
    for (const kind of fixture.runPanelKinds) {
      assert(kind === "java" || kind === "python", "Invalid shared run-panel kind");
      const toolbar = await until(
        () =>
          [...document.querySelectorAll<HTMLButtonElement>(".toolbar-actions button")].find(
            (button) =>
              button
                .getAttribute("aria-label")
                ?.startsWith(
                  translate(scene.language, kind === "java" ? "Java 构建与运行" : "Python 运行"),
                ),
          ),
        "actual run toolbar button",
      );
      toolbar.click();
      const panel = await until(
        () =>
          document.querySelector<HTMLElement>(
            kind === "python" ? ".python-run-panel" : ".java-build-panel:not(.python-run-panel)",
          ),
        "mounted actual run panel",
      );
      await until(
        () =>
          panel.querySelector(".java-run-configuration select") &&
          !panel.querySelector<HTMLFieldSetElement>("fieldset")?.disabled &&
          !panel.querySelector("[role=alert]"),
        "actual configuration detection",
      );
      const click = async (label: string) => {
        const button = await until(
          () => panel.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`),
          label,
        );
        assert(!button.disabled, "Run-panel button is disabled: " + label);
        button.click();
      };
      const expand = async (expanded: boolean) => {
        await click(
          expanded
            ? translate(scene.language, "展开运行面板")
            : translate(scene.language, "还原运行面板"),
        );
        await until(
          () => panel.classList.contains("java-panel-expanded") === expanded,
          "actual expansion state",
        );
      };
      const capture = async (state: string) => {
        await unchanged();
        assert(panel.isConnected, "The retained panel was replaced");
        await new Promise((resolve) => setTimeout(resolve, 250));
        const bounds = panel.getBoundingClientRect();
        assert(
          bounds.left >= 0 &&
            bounds.top >= 0 &&
            bounds.right <= innerWidth + 0.5 &&
            bounds.bottom <= innerHeight + 0.5,
          "Run panel extends outside the real workspace",
        );
        const fileVisible = !!document.querySelector(".file-editor");
        assert(fileVisible === (state === "file"), "Unexpected run-panel file visibility");
        if (fileVisible)
          assert(
            document.querySelector(
              `.file-editor[aria-label="${translate(scene.language, "文件编辑器 {p0}", { p0: "README.md" })}"]`,
            ),
            "Run panel is beside a different file",
          );
        const sample = terminalPerformanceSnapshot("ui-parity-0");
        assert(
          sample && sample.columns > 0 && sample.rows > 0,
          "The retained terminal renderer disappeared",
        );
        await record(`run-${kind}-${state}-${scene.language}-${scene.appearance}-${scene.width}`, {
          ...scene,
          kind,
          state,
          passed: true,
          actualToolbarButton: true,
          actualExpandAndRestore: true,
          retainedPanelView: true,
          terminalGenerationRetained: true,
          canonicalWorkspaceRetained: true,
          fileVisible,
          panelLeft: bounds.left,
          panelTop: bounds.top,
          panelWidth: bounds.width,
          panelHeight: bounds.height,
          panelHeaderHeight: panel.querySelector(".java-panel-header")!.getBoundingClientRect()
            .height,
        });
      };
      await expand(true);
      await expand(false);
      await expand(true);
      await capture("expanded");
      await expand(false);
      await capture("docked");
      const file = await until(
        () => document.querySelector<HTMLButtonElement>('.file-row[data-path="README.md"]'),
        "actual README file row",
      );
      file.click();
      await until(
        () => document.querySelector(".file-editor"),
        "actual file beside retained run panel",
      );
      await capture("file");
      const close = await until(
        () =>
          document.querySelector<HTMLButtonElement>(
            `.workspace-tab-close[aria-label="${translate(scene.language, "关闭文件 {p0}", { p0: "README.md" })}"]`,
          ),
        "actual file close tab",
      );
      close.click();
      await until(
        () => !document.querySelector(".file-editor") && panel.isConnected,
        "file close retains run panel",
      );
      await click(translate(scene.language, "隐藏运行面板"));
      await until(() => !panel.isConnected, "actual hide closes run panel");
      await unchanged();
    }
  }
  await unchanged();
  await record("run-panels-complete", {
    passed: true,
    actualFileCloseAndHideVerified: true,
    terminalGenerationRetained: true,
    canonicalWorkspaceRetained: true,
  });
}
