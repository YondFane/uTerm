import { invoke } from "@tauri-apps/api/core";
import { translate } from "../lib/i18n";
import { agentNames } from "../components/SidebarIcon";

const pause = () => new Promise((done) => setTimeout(done, 100));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause();
  }
  throw Error(`Agent QA timed out: ${label}`);
}
const t = (key: string) => translate("en", key);
export async function runAgents(
  scene: (name: string, checks: unknown) => Promise<void>,
  snapshot: () => Promise<unknown>,
) {
  (
    await until(
      () => document.querySelector<HTMLButtonElement>('button[aria-label="Agent"]'),
      "Agent entry",
    )
  ).click();
  const panel = await until(
    () => document.querySelector<HTMLDialogElement>(".agent-dialog[open]"),
    "Agent dialog",
  );
  async function click(label: string, scope: ParentNode = panel) {
    (
      await until(
        () =>
          [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
            (item) => item.textContent?.trim() === label && !item.disabled,
          ),
        label,
      )
    ).click();
    await pause();
  }
  async function field(label: string, value: string) {
    const input = await until(
      () =>
        [...panel.querySelectorAll("form.agent-editor label")]
          .find((item) => item.textContent?.trim() === label)
          ?.querySelector<HTMLInputElement>("input"),
      label,
    );
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await pause();
  }
  async function select(name: string) {
    (
      await until(
        () =>
          [...panel.querySelectorAll<HTMLButtonElement>(".agent-select")].find(
            (item) =>
              item.querySelector(".agent-list-name")?.textContent === name && !item.disabled,
          ),
        name,
      )
    ).click();
    await pause();
  }
  const saved = async () =>
    (await snapshot()) as {
      document: { settings: { enabledAgents: string[]; agentNotifications?: boolean } };
    };
  const before = await invoke<unknown[]>("agent_definitions");
  let writerBusyRetries = 0;
  async function changeSwitch(input: HTMLInputElement, checked: boolean) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await until(() => !input.disabled, "Enabled setting control");
      if (input.checked === checked) return;
      input.click();
      await pause();
      // Observe the persisted UI result before taking the Core's read lock.
      // 先等待界面确认保存结果，再获取 Core 的读取锁。
      await until(() => !input.disabled, "Setting write completed");
      if (input.checked === checked) return;
      const error = panel.querySelector('[role="alert"]')?.textContent ?? "";
      assert(
        error.includes("Another writer owns the canonical store"),
        "Unexpected setting failure",
      );
      writerBusyRetries++;
      await pause();
    }
    throw Error("Setting remained unsaved after explicit busy retries");
  }
  const notification = await until(
    () => panel.querySelector<HTMLInputElement>(".notification-toggle input"),
    "Notification preference",
  );
  assert(notification.checked, "External canonical opt-in was not loaded");
  await changeSwitch(notification, false);
  assert(
    (await saved()).document.settings.agentNotifications === false,
    "Canonical notification opt-out was not saved",
  );
  await click(t("添加 Agent"));
  await field(t("标识"), "qa-core-agent");
  await field(t("名称"), "Shared Agent QA");
  await field(t("程序路径或命令"), "node");
  await field(t("参数（JSON 数组）"), '["--version"]');
  await click(t("保存"), panel.querySelector("form.agent-editor")!);
  await until(() => !panel.querySelector("form.agent-editor"), "Saved custom command");
  const enable = await until(
    () =>
      panel.querySelector<HTMLInputElement>('[aria-label="Enable Shared Agent QA"]:not(:disabled)'),
    "Enable custom command",
  );
  await changeSwitch(enable, true);
  assert(
    (await saved()).document.settings.enabledAgents.includes("qa-core-agent"),
    "Canonical Agent enable was not saved",
  );
  await scene("agent-live-command", {
    customCommandSaved: true,
    canonicalEnable: true,
    canonicalNotificationOptOut: true,
    osPermissionPromptExecuted: false,
    settingWritesCompletedBeforeObserverRead: true,
    writerBusyRetries,
  });
  await select(agentNames.claude);
  await click(t("安装 Hooks"));
  await until(
    () => panel.querySelector('[role="status"]')?.textContent,
    "Installed Hooks feedback",
  );
  const usage = await invoke<{ records: number }>("agent_usage", {
    agent: "claude",
    remote: false,
    allowKeychain: false,
  });
  assert(usage.records === 1, "Private local usage fixture was not read");
  await scene("agent-live-hooks", {
    actualHooksCommand: true,
    privateLocalUsageRead: true,
    keychainOrProviderAccountAccess: false,
  });
  await click(t("移除 Hooks"));
  await until(() => panel.querySelector('[role="status"]')?.textContent, "Removed Hooks feedback");
  await select("Shared Agent QA");
  await click(t("配置"));
  await field(t("参数（JSON 数组）"), "[invalid");
  await click(t("保存"), panel.querySelector("form.agent-editor")!);
  await until(() => panel.querySelector('[role="alert"]'), "Invalid argument error");
  assert(
    [...panel.querySelectorAll<HTMLInputElement>("form.agent-editor input")].some(
      (item) => item.value === "[invalid",
    ),
    "Invalid argument draft was lost",
  );
  await scene("agent-live-errors", {
    invalidArgumentErrorVisible: true,
    invalidDraftRetained: true,
  });
  await click(t("取消"), panel.querySelector("form.agent-editor")!);
  const disable = await until(
    () =>
      panel.querySelector<HTMLInputElement>('[aria-label="Enable Shared Agent QA"]:not(:disabled)'),
    "Disable custom command",
  );
  await changeSwitch(disable, false);
  assert(
    !(await saved()).document.settings.enabledAgents.includes("qa-core-agent"),
    "Canonical Agent disable was not saved",
  );
  await click(t("移除配置"));
  await until(
    async () => JSON.stringify(await invoke("agent_definitions")) === JSON.stringify(before),
    "Other command definitions retained",
  );
  panel.querySelector<HTMLButtonElement>(`[aria-label="${t("关闭 Agent 设置")}"]`)!.click();
  await until(() => !document.querySelector(".agent-dialog[open]"), "Closed Agent dialog");
  await invoke("qa_request_exit");
}
