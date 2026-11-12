import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { createServer } from "./vite-server.mjs";

test("quick SSH refreshes explicit attempts, preserves the captured workspace and recovers from conflicts", async () => {
  const dom = new JSDOM("", { url: "http://localhost" });
  for (const key of ["window", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const server = await createServer({ configFile: false });
  const state = await server.ssrLoadModule("/src/lib/shared-state.ts");
  const { parseQuickSsh } = await server.ssrLoadModule("/src/lib/ssh.ts");
  const calls = [];
  let revision = "1";
  let workspaceId = "local";
  let conflict = false;
  const value = () => ({
    revision,
    document: { workspace: { selectedWorkspace: workspaceId, marker: revision }, settings: {} },
  });
  mockIPC((command, args) => {
    assert.equal(command, "shared_core_request");
    const request = JSON.parse(args.request);
    calls.push(request);
    let result;
    let error;
    if (request.method === "snapshot.read") result = value();
    else {
      assert.equal(request.method, "ssh.quick.create");
      assert.equal(request.params.expectedRevision, revision);
      assert.equal(request.params.connection.workspace_id, "local");
      if (conflict || workspaceId !== "local")
        error = { code: "CONFLICT", message: "Workspace changed" };
      else {
        revision = String(Number(revision) + 1);
        result = value();
      }
    }
    return JSON.stringify({ version: 1, id: request.id, ...(error ? { error } : { result }) });
  });
  const connection = { ...parseQuickSsh("dev@[::1]:2222"), id: "profile", sessions: [] };
  const create = () => state.createSharedQuickSsh(connection, "local", "session", "/fixture");
  try {
    await state.initializeSharedState();
    revision = "8";
    assert.equal((await create()).marker, "9");
    assert.equal(calls.at(-1).params.connection.host, "::1");
    assert.equal(calls.at(-1).params.connection.port, 2222);
    assert.equal(calls.at(-1).params.id, "session");
    assert.equal(calls.at(-1).params.directory, "/fixture");
    assert.equal(calls.at(-2).method, "snapshot.read");
    conflict = true;
    await assert.rejects(create(), { code: "CONFLICT" });
    assert.equal(state.sharedWorkspace().marker, "9");
    conflict = false;
    revision = "15";
    assert.equal((await create()).marker, "16");
    workspaceId = "other";
    await assert.rejects(create(), { code: "CONFLICT" });
    assert.equal(calls.at(-1).params.connection.workspace_id, "local");
    assert.equal(state.sharedWorkspace().selectedWorkspace, "other");
    assert.equal(calls.filter((call) => call.method === "snapshot.replace").length, 0);
  } finally {
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
