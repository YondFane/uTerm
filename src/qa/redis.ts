import { invoke } from "@tauri-apps/api/core";

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
async function until<T>(read: () => T | Promise<T>, description: string): Promise<NonNullable<T>> {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause(100);
  }
  throw Error(`Redis QA timed out: ${description}`);
}
const visible = () => document.querySelector<HTMLElement>(".redis-workspace:not([hidden])");
async function click(label: string, scope: ParentNode = document) {
  const value = await until(
    () =>
      [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === label && !item.disabled,
      ),
    label,
  );
  value.click();
  await pause(100);
}
async function field(label: string, value: string) {
  const control = await until(
    () =>
      [...document.querySelectorAll(".redis-dialog[open] label")]
        .find((item) => item.textContent?.trim().startsWith(label))
        ?.querySelector<HTMLInputElement>("input"),
    `profile field ${label}`,
  );
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  await pause(100);
}

export async function runRedis(
  scene: (name: string, checks: unknown) => Promise<void>,
  snapshot: () => Promise<unknown>,
) {
  const fixture = await invoke<{
    port: number;
    password: string;
    textKey: string;
    originalText: string;
    savedText: string;
  }>("qa_redis_fixture");
  const name = "Tauri Redis QA";
  const rail = await until(
    () => document.querySelector<HTMLButtonElement>('.sidebar-rail-button[aria-label="All"]'),
    "all sidebar sections",
  );
  rail.click();
  const add = await until(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Add Redis connection"]'),
    "add Redis profile",
  );
  add.click();
  await field("Name", name);
  await field("Redis host", "127.0.0.1");
  await field("Port", String(fixture.port));
  await field("Password (optional)", fixture.password);
  const remember = document.querySelector<HTMLInputElement>(
    '.redis-dialog[open] input[type="checkbox"]',
  );
  assert(remember && !remember.checked, "Temporary Redis password must not be remembered");
  await click("Save connection", document.querySelector(".redis-dialog[open]")!);
  await until(() => !document.querySelector(".redis-dialog[open]"), "profile save");
  const stored = (await snapshot()) as {
    document: { workspace: { groups: { redisConnections?: { name: string }[] }[] } };
  };
  assert(
    stored.document.workspace.groups.some((group) =>
      group.redisConnections?.some((item) => item.name === name),
    ),
    "Real Core snapshot does not contain the saved Redis profile",
  );
  assert(
    !JSON.stringify(stored).includes(fixture.password),
    "Redis password leaked into Core data",
  );
  const profile = () =>
    [...document.querySelectorAll<HTMLElement>(".sidebar-row-name")]
      .find((item) => item.textContent?.trim() === name || item.textContent?.trim() === `${name} *`)
      ?.closest<HTMLButtonElement>("button");
  (await until(profile, "saved sidebar profile")).click();
  const workspace = await until(visible, "real Redis workbench");
  await until(
    () => workspace.querySelector<HTMLInputElement>('input[type="password"]')?.value,
    "temporary password handoff",
  );
  await click("Connect", workspace);
  const writable = await until(
    () => workspace.querySelector<HTMLInputElement>('input[aria-label="Allow editing"]'),
    "authenticated real Redis connection",
  );
  await until(() => workspace.querySelectorAll(".redis-key").length === 2, "real key listing");
  assert(!writable.checked, "Redis connection did not default to read-only");
  await scene("redis-live-profile", {
    profileSavedInCore: true,
    temporaryPasswordNotPersisted: true,
    realAuthenticatedConnection: true,
    defaultReadonly: true,
  });
  const key = async (title: string) => {
    const browse = workspace.querySelector<HTMLButtonElement>(".redis-browser-toggle");
    assert(browse && !browse.disabled, "Redis key browser is unavailable");
    if (browse.getAttribute("aria-expanded") !== "true") browse.click();
    await until(() => browse.getAttribute("aria-expanded") === "true", "open key browser");
    const row = await until(
      () =>
        [...workspace.querySelectorAll<HTMLButtonElement>(".redis-key")].find(
          (item) => item.title === title && !item.disabled,
        ),
      `real key ${title}`,
    );
    row.scrollIntoView({ block: "nearest" });
    await until(() => {
      const bounds = row.getBoundingClientRect();
      const area = workspace.getBoundingClientRect();
      return (
        getComputedStyle(row).visibility === "visible" &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.left >= area.left - 1 &&
        bounds.right <= innerWidth &&
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight
      );
    }, "visible key row in the actual drawer");
    row.click();
  };
  await key("00 ff 6b 65 79");
  const binary = await until(
    () => workspace.querySelector(".redis-binary-preview")?.textContent?.includes("ff 00 7f"),
    "exact binary preview",
  );
  assert(
    binary && !workspace.querySelector('.cm-content[contenteditable="true"]'),
    "Binary value exposed a text editor",
  );
  await scene("redis-live-binary", {
    exactBinaryKey: "00ff6b6579",
    exactBinaryValue: "ff007f",
    binaryReadonlyPreview: true,
  });
  await key(fixture.textKey);
  await until(
    () => workspace.querySelector(".cm-content")?.textContent?.includes(fixture.originalText),
    "exact original Unicode and bigint text",
  );
  writable.click();
  await until(() => writable.checked && !writable.disabled, "explicit write permission");
  const editor = await until(
    () => workspace.querySelector<HTMLElement>('.redis-editor .cm-content[contenteditable="true"]'),
    "real writable CodeMirror",
  );
  editor.focus();
  assert(document.execCommand("selectAll", false), "Redis CodeMirror selectAll failed");
  assert(
    document.execCommand("insertText", false, fixture.savedText),
    "Redis CodeMirror input failed",
  );
  await until(() => workspace.querySelector(".redis-dirty"), "unsaved Redis draft");
  const project = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.title.startsWith("Temporary QA project —"),
  );
  assert(project, "Temporary project is unavailable for hiding the Redis workbench");
  project.click();
  await until(() => workspace.hidden, "hide Redis workbench");
  (await until(profile, "retained dirty Redis profile")).click();
  await until(visible, "reopen Redis workbench");
  assert(
    workspace.querySelector(".redis-editor .cm-content") === editor,
    "Reopening replaced the retained Redis editor",
  );
  assert(
    editor.textContent === fixture.savedText && writable.checked,
    "Hidden Redis draft or connection was lost",
  );
  await scene("redis-live-draft", {
    exactText: fixture.savedText,
    hiddenWorkbenchRetainedEditor: true,
    hiddenWorkbenchRetainedDraftAndConnection: true,
  });
  await click("Save", workspace);
  await until(() => !workspace.querySelector(".redis-dirty"), "real protected Redis write");
  await click("Reconnect", workspace);
  await until(() => {
    const toggle = workspace.querySelector<HTMLInputElement>('input[aria-label="Allow editing"]');
    return toggle && !toggle.checked && workspace.querySelectorAll(".redis-key").length === 2;
  }, "authenticated reconnect resets write permission");
  await key(fixture.textKey);
  await until(
    () => workspace.querySelector(".cm-content")?.textContent === fixture.savedText,
    "saved exact value reread after reconnect",
  );
  assert(
    !workspace.querySelector('.cm-content[contenteditable="true"]'),
    "Reconnect retained write permission",
  );
  await scene("redis-live-saved", {
    exactText: fixture.savedText,
    protectedWriteAndServerReread: true,
    temporaryPasswordReconnect: true,
    reconnectDefaultsReadonly: true,
  });
  await click("Disconnect", workspace);
  await until(() => workspace.querySelector('input[type="password"]'), "explicit disconnect");
  await invoke("qa_request_exit");
}
