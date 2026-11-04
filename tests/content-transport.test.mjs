import test from "node:test";
import assert from "node:assert/strict";
import { ContentScope } from "../src/lib/content-transport.ts";
import { webKitContentPort } from "../src/lib/webkit-content.ts";
import { tauriContentPort } from "../src/lib/tauri-content.ts";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Tauri read cancellation remains immediate while write failures drain without late delivery", async (t) => {
  const previous = global.window;
  global.window = {};
  const backend = deferred();
  mockIPC(() => backend.promise);
  const read = new ContentScope(tauriContentPort, "read-cancel"),
    write = new ContentScope(tauriContentPort, "write-cancel"),
    controller = new AbortController();
  t.after(() => {
    read.close();
    write.close();
    clearMocks();
    if (previous === undefined) delete global.window;
    else global.window = previous;
  });
  const pendingRead = read.call("file_read", {}, controller.signal),
    pendingWrite = write.call("file_save", {}, controller.signal);
  let writeSettled = false;
  const failedWrite = assert.rejects(
    pendingWrite.finally(() => {
      writeSettled = true;
    }),
    {
      code: "CANCELLED",
      message: /reload before retrying/,
    },
  );
  const failedRead = assert.rejects(pendingRead, { code: "CANCELLED" });
  await tick();
  controller.abort();
  await failedRead;
  await tick();
  assert.equal(writeSettled, false);
  backend.resolve(Promise.reject(Error("actual backend failure after cancellation")));
  await failedWrite;
  assert.equal(writeSettled, true);
  mockIPC(() => "new document reply");
  assert.equal(await write.call("file_read"), "new document reply");
});
function deferred() {
  let resolve;
  const promise = new Promise((value) => {
    resolve = value;
  });
  return { promise, resolve };
}
function harness() {
  const messages = [],
    cancelled = [];
  let receive;
  let stops = 0;
  const port = {
    async request(message) {
      const reply = deferred();
      messages.push({ message, reply });
      return reply.promise;
    },
    cancel(document, id) {
      cancelled.push({ document, id });
    },
    async subscribe(_kind, _document, listener) {
      receive = listener;
      return () => {
        stops++;
      };
    },
  };
  return { port, messages, cancelled, emit: (e) => receive(e), stops: () => stops };
}
function reply(request, result) {
  return { version: 1, id: request.id, document: request.document, result };
}
test("content replies preserve identity during out-of-order delivery and reject other documents", async () => {
  const h = harness();
  const scope = new ContentScope(h.port, "file-A");
  const first = scope.call("file_read", { path: "A" });
  const second = scope.call("file_read", { path: "B" });
  await tick();
  h.messages[1].reply.resolve(reply(h.messages[1].message, "second"));
  h.messages[0].reply.resolve(reply(h.messages[0].message, "first"));
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  for (const patch of [
    { version: 2 },
    { id: "late" },
    { document: "file-B" },
    { error: { code: 1 } },
  ]) {
    const value = scope.call("file_read");
    const rejected = assert.rejects(value, { code: "INVALID_REPLY" });
    await tick();
    const pending = h.messages.at(-1);
    pending.reply.resolve({ ...reply(pending.message, "wrong"), ...patch });
    await rejected;
  }
  scope.close();
});
test("content abort and timeout suppress late responses without claiming writes rolled back", async () => {
  const h = harness();
  const scope = new ContentScope(h.port, "file-A", 1000);
  const before = new AbortController();
  before.abort();
  await assert.rejects(scope.call("file_save", {}, before.signal), { code: "CANCELLED" });
  assert.equal(h.messages.length, 0);
  const controller = new AbortController();
  const value = scope.call("file_save", { text: "draft" }, controller.signal);
  const rejected = assert.rejects(value, { code: "CANCELLED" });
  await tick();
  controller.abort();
  await rejected;
  h.messages[0].reply.resolve(reply(h.messages[0].message, "committed after abort"));
  assert.deepEqual(h.cancelled, [{ document: "file-A", id: h.messages[0].message.id }]);
  scope.close();
  const slow = new ContentScope(h.port, "file-slow", 30);
  await assert.rejects(slow.call("file_read"), { code: "TIMEOUT" });
  h.messages.at(-1).reply.resolve(reply(h.messages.at(-1).message, "late"));
  assert.equal(h.cancelled.at(-1).document, "file-slow");
  slow.close();
});
test("closing a content document drains subscriptions and rejects its pending deliveries", async () => {
  const h = harness();
  const scope = new ContentScope(h.port, "A");
  const received = [];
  const stop = await scope.subscribe("editor-close-request", (e) => received.push(e));
  h.emit({ version: 1, document: "B", kind: "editor-close-request", payload: 1 });
  h.emit({ version: 2, document: "A", kind: "editor-close-request", payload: 2 });
  h.emit(null);
  h.emit({ version: 1, document: "A", kind: "editor-close-request", payload: 3 });
  assert.deepEqual(received, [3]);
  const pending = scope.call("file_read");
  const rejected = assert.rejects(pending, { code: "CLOSED" });
  await tick();
  scope.close();
  await rejected;
  scope.close();
  stop();
  assert.equal(h.stops(), 1);
  assert.equal(h.cancelled.length, 1);
  h.emit({ version: 1, document: "A", kind: "editor-close-request", payload: 4 });
  assert.deepEqual(received, [3]);
  await assert.rejects(scope.call("file_read"), { code: "CLOSED" });
});
test("late content subscription registration is immediately removed after unload", async () => {
  const registration = deferred();
  let stopped = 0;
  const h = harness();
  h.port.subscribe = async () => registration.promise;
  const scope = new ContentScope(h.port, "A");
  const pending = scope.subscribe("editor-close-request", () => assert.fail("stale delivery"));
  scope.close();
  registration.resolve(() => stopped++);
  (await pending)();
  assert.equal(stopped, 1);
});
test("content method/event allowlists, owned arguments and host errors remain bounded", async () => {
  const h = harness();
  const scope = new ContentScope(h.port, "A");
  await assert.rejects(scope.call("shell_exec"), { code: "METHOD_DENIED" });
  await assert.rejects(
    scope.subscribe("terminal.output", () => {}),
    { code: "EVENT_DENIED" },
  );
  await assert.rejects(scope.call("file_read", { bigint: 1n }), TypeError);
  await assert.rejects(scope.call("file_save", { text: "x".repeat(32 * 1024 * 1024) }), {
    code: "REQUEST_TOO_LARGE",
  });
  const args = { path: "first", nested: { value: "original" } };
  const pending = scope.call("file_read", args);
  args.path = "second";
  args.nested.value = "changed";
  const rejected = assert.rejects(pending, { code: "CONFLICT", message: "retained" });
  await tick();
  const request = h.messages[0];
  assert.deepEqual(request.message.params, { path: "first", nested: { value: "original" } });
  request.reply.resolve({
    ...reply(request.message),
    error: { code: "CONFLICT", message: "retained" },
  });
  await rejected;
  scope.close();
});
test("WebKit uses the same request envelope, cancellation and document-filtered event contract", async () => {
  const sent = [],
    target = new EventTarget();
  const pending = deferred();
  const port = webKitContentPort(
    {
      postMessage(message) {
        sent.push(message);
        return message.kind === "cancel" ? Promise.resolve({}) : pending.promise;
      },
    },
    target,
  );
  const scope = new ContentScope(port, "webkit-document");
  const received = [];
  const stop = await scope.subscribe("editor-close-request", (e) => received.push(e));
  target.dispatchEvent(
    new CustomEvent("uterm-content-event", {
      detail: { version: 1, document: "old-document", kind: "editor-close-request", payload: null },
    }),
  );
  target.dispatchEvent(
    new CustomEvent("uterm-content-event", {
      detail: {
        version: 1,
        document: "webkit-document",
        kind: "editor-close-request",
        payload: "close",
      },
    }),
  );
  assert.deepEqual(received, ["close"]);
  const abort = new AbortController();
  const value = scope.call("file_save", { path: "a", text: "new" }, abort.signal);
  const rejected = assert.rejects(value, { code: "CANCELLED" });
  await tick();
  assert.equal(sent[0].kind, "request");
  abort.abort();
  await rejected;
  assert.deepEqual(sent[1], {
    kind: "cancel",
    version: 1,
    document: sent[0].document,
    id: sent[0].id,
  });
  pending.resolve(reply(sent[0], "late"));
  stop();
  scope.close();
  target.dispatchEvent(
    new CustomEvent("uterm-content-event", {
      detail: {
        version: 1,
        document: "webkit-document",
        kind: "editor-close-request",
        payload: "stale",
      },
    }),
  );
  assert.deepEqual(received, ["close"]);
});

test("content operation IDs work when custom-scheme contexts lack randomUUID", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const crypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: crypto.getRandomValues.bind(crypto) },
  });
  t.after(() => Object.defineProperty(globalThis, "crypto", original));
  const h = harness();
  const scope = new ContentScope(h.port, "native-custom-scheme");
  const value = scope.call("file_read");
  await tick();
  assert.match(h.messages[0].message.id, /^[a-f0-9]{32}$/);
  h.messages[0].reply.resolve(reply(h.messages[0].message, "exact"));
  assert.equal(await value, "exact");
  scope.close();
});
