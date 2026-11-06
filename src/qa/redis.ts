import { invoke } from "@tauri-apps/api/core";
import type { RedisConfig } from "../lib/redis";

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

async function credentialBinding(config: RedisConfig, password: string) {
  const reference = await invoke<string>("redis_credential", { config, password, remove: false });
  const saved = { ...config, credential_id: reference };
  async function refuse(target: RedisConfig, code: string) {
    let failure: unknown;
    let opened: { handle: string } | undefined;
    try {
      opened = await invoke("redis_connect", { config: target, password: null });
    } catch (reason) {
      failure = reason;
    }
    if (opened) await invoke("redis_disconnect", { handle: opened.handle });
    assert(failure && String(failure).includes(code), `System credential did not enforce ${code}`);
  }
  let handle: string | undefined;
  try {
    handle = (await invoke<{ handle: string }>("redis_connect", { config: saved, password: null }))
      .handle;
    const ping = await invoke<{ result: string }>("redis_request", {
      handle,
      request: { op: "console", args: ["PING"] },
    });
    assert(ping.result === "PONG", "Stored OS credential did not authenticate to real Redis");
    await refuse({ ...saved, host: "127.0.0.2" }, "REDIS_CREDENTIAL_TARGET_CHANGED");
  } finally {
    try {
      if (handle) await invoke("redis_disconnect", { handle });
    } finally {
      await invoke("redis_credential", { config: saved, password: null, remove: true });
    }
  }
  await refuse(saved, "REDIS_CREDENTIAL_MISSING");
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
    listKey: string;
    largeListKey: string;
    largeListMembers: number;
    deleteKey: string;
    lastOriginalListValue: string;
    lastRemainingListValue: string;
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
    document: { workspace: { groups: { redisConnections?: RedisConfig[] }[] } };
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
  const config = stored.document.workspace.groups
    .flatMap((group) => group.redisConnections ?? [])
    .find((item) => item.name === name)!;
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
  await until(() => workspace.querySelectorAll(".redis-key").length === 5, "real key listing");
  assert(!writable.checked, "Redis connection did not default to read-only");
  await credentialBinding(config, fixture.password);
  await scene("redis-live-profile", {
    profileSavedInCore: true,
    temporaryPasswordNotPersisted: true,
    realAuthenticatedConnection: true,
    defaultReadonly: true,
    osCredentialAuthenticatedBoundAndRemoved: true,
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
  await click("Disconnect", workspace);
  const unsaved = await until(
    () =>
      workspace.querySelector<HTMLDialogElement>('dialog[open][aria-labelledby^="redis-unsaved-"]'),
    "unsaved disconnect guard",
  );
  await click("Cancel", unsaved);
  await until(() => !unsaved.open, "cancel unsaved disconnect");
  assert(
    editor.textContent === fixture.savedText && writable.isConnected && writable.checked,
    "Cancelling disconnect lost the live connection or draft",
  );
  await invoke("qa_request_exit");
  const quitDialog = await until(
    () =>
      workspace.querySelector<HTMLDialogElement>('dialog[open][aria-labelledby^="redis-unsaved-"]'),
    "actual application quit draft guard",
  );
  await click("Cancel", quitDialog);
  await until(() => !quitDialog.open, "cancel application quit");
  assert(
    editor.textContent === fixture.savedText && writable.isConnected && writable.checked,
    "Cancelling application quit lost the live connection or draft",
  );
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
    cancelledDisconnectRetainedDraftAndConnection: true,
    cancelledApplicationQuitRetainedDraftAndConnection: true,
  });
  await click("Save", workspace);
  await until(() => !workspace.querySelector(".redis-dirty"), "real protected Redis write");
  const probe = await invoke<{ handle: string }>("redis_connect", {
    config,
    password: fixture.password,
  });
  const inspect = <T>(request: Record<string, unknown>) =>
    invoke<T>("redis_request", { handle: probe.handle, request });
  type ListResult = {
    size: number;
    ttl: number;
    version: string | null;
    items: { text: string }[];
  };
  const list = (offset: number, listKey = fixture.listKey) =>
    inspect<ListResult>({
      op: "read",
      key: btoa(listKey),
      field: null,
      cursor: "0",
      offset,
      pattern: "*",
    });
  const exists = async () =>
    (await inspect<{ result: number }>({ op: "console", args: ["EXISTS", fixture.deleteKey] }))
      .result;
  const rows = () => [
    ...workspace.querySelectorAll<HTMLTableRowElement>(".redis-members tbody tr"),
  ];
  const page = (first: number, count: number) =>
    rows().length === count && rows()[0]?.cells[0].textContent === String(first);
  const pagination = () => workspace.querySelector(".redis-collection .redis-pagination")!;
  const dialog = () =>
    workspace.querySelector<HTMLDialogElement>('dialog[open][aria-labelledby^="redis-confirm-"]');
  try {
    await key(fixture.largeListKey);
    await until(() => page(0, 200), "bounded large list first page");
    await click("Next page", pagination());
    await until(() => page(200, 200), "responsive large list second page");
    const large = await list(200, fixture.largeListKey);
    const guarded = [
      ...workspace.querySelectorAll<HTMLButtonElement>(".redis-members button"),
    ].filter((button) =>
      ["Edit member", "Delete member"].includes(button.textContent?.trim() ?? ""),
    );
    assert(
      large.size === fixture.largeListMembers &&
        large.items.length === 200 &&
        large.version === null,
      "Large list response did not preserve the bounded page and edit limit",
    );
    assert(
      guarded.length === 400 && guarded.every((button) => button.disabled),
      "Large-list mutation controls bypassed the snapshot limit",
    );
    await scene("redis-live-pages", {
      rowsRendered: 200,
      firstIndex: 200,
      totalMembers: fixture.largeListMembers,
      boundedServerPage: true,
      readonlyAboveSnapshotLimit: true,
    });
    await key(fixture.listKey);
    await until(() => page(0, 200), "bounded first list page");
    await click("Next page", pagination());
    await until(() => page(200, 200), "bounded second list page");
    assert((await list(200)).size === 401, "Real list size differs from the 401-row fixture");
    await click("Next page", pagination());
    await until(() => page(400, 1), "last list page");
    await click("Delete member", rows()[0]);
    await click("Cancel", await until(dialog, "list deletion confirmation"));
    await until(() => !dialog(), "cancel list deletion");
    const cancelled = await list(400);
    assert(
      cancelled.size === 401 && cancelled.items[0]?.text === fixture.lastOriginalListValue,
      "Cancelled member deletion changed actual Redis data",
    );
    await click("Delete member", rows()[0]);
    await click("Confirm", await until(dialog, "reviewed list deletion"));
    await until(
      () => !dialog() && page(200, 200),
      "confirmed list deletion and bounded previous page",
    );
    const changed = await list(200);
    assert(
      changed.size === 400 && changed.items.at(-1)?.text === fixture.lastRemainingListValue,
      "List deletion changed the wrong position",
    );
    const ttl = [
      ...workspace.querySelectorAll<HTMLButtonElement>(".redis-value-heading button"),
    ].find((item) => item.textContent?.trim().startsWith("TTL"));
    assert(ttl && !ttl.disabled, "Editable list TTL action is unavailable");
    ttl.click();
    const ttlDialog = await until(dialog, "TTL confirmation");
    const seconds = ttlDialog.querySelector<HTMLInputElement>('input[aria-label="TTL (seconds)"]');
    assert(seconds, "TTL input is missing");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      seconds,
      "1800",
    );
    seconds.dispatchEvent(new Event("input", { bubbles: true }));
    await pause(100);
    await click("Confirm", ttlDialog);
    await until(() => !dialog(), "actual TTL write");
    const expiring = await list(0);
    assert(expiring.ttl > 0 && expiring.ttl <= 1800000, "GUI TTL did not reach Redis");
    await key(fixture.deleteKey);
    async function deleteKey() {
      const menu = workspace.querySelector<HTMLElement>(".redis-value-heading details summary");
      assert(menu, "Key action menu is missing");
      menu.click();
      await click("Delete key", workspace.querySelector(".redis-value-heading details")!);
      return until(dialog, "key deletion confirmation");
    }
    await click("Cancel", await deleteKey());
    await until(() => !dialog(), "cancel key deletion");
    assert((await exists()) === 1, "Cancelling key deletion changed actual Redis data");
    await click("Confirm", await deleteKey());
    await until(async () => !dialog() && (await exists()) === 0, "confirmed key deletion");
    await key(fixture.listKey);
    await until(() => page(0, 200), "remaining bounded list");
    await click("Next page", pagination());
    await until(() => page(200, 200), "remaining list final page");
    const binary = await inspect<{ value: { data: string } }>({
      op: "read",
      key: "AP9rZXk=",
      field: null,
      cursor: "0",
      offset: 0,
      pattern: "*",
    });
    assert(binary.value.data === "/wB/", "Collection changes damaged a binary sibling");
    await scene("redis-live-mutations", {
      cancelledMemberDeletionPreservedData: true,
      reviewedIndex400Deleted: true,
      cancelledKeyDeletionPreservedData: true,
      reviewedKeyDeleted: true,
      guiTTLSeconds: 1800,
      remainingMembers: 400,
      binarySiblingPreserved: true,
    });
  } finally {
    await invoke("redis_disconnect", { handle: probe.handle });
  }
  await click("Reconnect", workspace);
  await until(() => {
    const toggle = workspace.querySelector<HTMLInputElement>('input[aria-label="Allow editing"]');
    return toggle && !toggle.checked && workspace.querySelectorAll(".redis-key").length === 4;
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
