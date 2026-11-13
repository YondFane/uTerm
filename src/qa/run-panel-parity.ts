import { invoke } from "@tauri-apps/api/core";
import { translate } from "../lib/i18n";
import { terminalPerformanceSnapshot } from "../lib/terminal-performance-qa";

type Scene = { language: "en" | "zh-Hans"; appearance: string; width: number; height: number };
type Fixture = {
  runPanelKinds: string[];
  runPanelScenes: Scene[];
  runFormInput: {
    arguments: string;
    argumentValues: string[];
    vmArguments: string;
    vmArgumentValues: string[];
    environment: string;
    invalidArguments: string;
  };
};
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
  directory: string,
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
      const advanced = panel.querySelector<HTMLDetailsElement>(".java-advanced");
      assert(advanced, "Missing actual advanced form");
      advanced.querySelector("summary")!.click();
      await until(() => advanced.open, "actual advanced disclosure");
      const formField = (label: string) => {
        const control = [...advanced.querySelectorAll("label")]
          .find((row) => row.textContent?.includes(label))
          ?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
        assert(control, "Missing actual run form field: " + label);
        return control;
      };
      const args = formField(translate(scene.language, "应用参数"));
      const env = formField(
        translate(scene.language, kind === "java" ? "环境变量 · 仅本次运行" : "环境变量"),
      );
      const vm = kind === "java" ? formField(translate(scene.language, "JVM 参数")) : null;
      const original = { arguments: args.value, environment: env.value, vm: vm?.value ?? "" };
      const input = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
        assert(!field.disabled && field.isConnected, "Run field is not enabled and attached");
        field.scrollIntoView({ block: "nearest" });
        field.focus();
        const prototype =
          field instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert(field.value === value, "Actual input was not retained");
      };
      const configuration = () =>
        invoke<{
          revision: string;
          project: { arguments: string[]; vm_arguments?: string[]; environment?: unknown };
        }>(kind + "_configuration", { directory });
      const save = async (invalid = false) => {
        const control = [...advanced.querySelectorAll("button")].find(
          (button) => button.textContent === translate(scene.language, "保存配置"),
        );
        assert(control && !control.disabled, "Missing actual enabled Save configuration");
        control.scrollIntoView({ block: "nearest" });
        control.click();
        await until(
          () =>
            !panel.querySelector<HTMLFieldSetElement>("fieldset")?.disabled &&
            (invalid
              ? panel.querySelector("[role=alert]")
              : panel.querySelector(".java-panel-notice[role=status]")),
          "actual save feedback",
        );
        assert(invalid || !panel.querySelector("[role=alert]"), "Valid run form save failed");
        return control;
      };
      const beforeInput = await configuration();
      await input(args, fixture.runFormInput.invalidArguments);
      await save(true);
      const invalidAfter = await configuration();
      assert(
        args.value === fixture.runFormInput.invalidArguments &&
          JSON.stringify(invalidAfter.project) === JSON.stringify(beforeInput.project) &&
          invalidAfter.revision === beforeInput.revision,
        "Invalid run draft changed saved configuration",
      );
      await input(args, fixture.runFormInput.arguments);
      await input(env, fixture.runFormInput.environment);
      if (vm) await input(vm, fixture.runFormInput.vmArguments);
      const saveButton = await save();
      const saved = await configuration();
      assert(
        JSON.stringify(saved.project.arguments) ===
          JSON.stringify(fixture.runFormInput.argumentValues) &&
          (!vm ||
            JSON.stringify(saved.project.vm_arguments) ===
              JSON.stringify(fixture.runFormInput.vmArgumentValues)),
        "Literal arguments changed while saving",
      );
      assert(
        env.value === fixture.runFormInput.environment && !("environment" in saved.project),
        "Temporary environment was persisted or discarded",
      );
      const rect = saveButton.getBoundingClientRect(),
        formRect = panel.getBoundingClientRect();
      assert(
        rect.height <= 30 &&
          rect.width > 0 &&
          rect.width < 200 &&
          rect.top >= formRect.top &&
          rect.bottom <= formRect.bottom &&
          formRect.right - rect.right >= 0 &&
          formRect.right - rect.right <= 40,
        "Save configuration is stretched or not right aligned",
      );
      await unchanged();
      await record(`run-form-${kind}-${scene.language}-${scene.appearance}-${scene.width}`, {
        ...scene,
        kind,
        passed: true,
        actualAdvancedToggle: true,
        actualTextEditorInput: true,
        invalidArgumentRetainedWithoutWrite: true,
        literalArgumentsSaved: true,
        temporaryEnvironmentRetainedWithoutPersistence: true,
        canonicalStateAndSessionRetained: true,
        fixtureArguments: fixture.runFormInput.arguments,
        fixtureEnvironment: fixture.runFormInput.environment,
        savedArguments: saved.project.arguments,
        actualSaveButtonAndFeedback: true,
        compactRightAlignedSave: true,
        saveWidth: rect.width,
        saveHeight: rect.height,
        saveRightInset: formRect.right - rect.right,
      });
      await input(args, original.arguments);
      await input(env, original.environment);
      if (vm) await input(vm, original.vm);
      await save();
      advanced.querySelector("summary")!.click();
      await until(() => !advanced.open, "collapse actual advanced disclosure");
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
