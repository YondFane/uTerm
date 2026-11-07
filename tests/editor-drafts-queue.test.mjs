import test from "node:test";
import assert from "node:assert/strict";
import { EditorDraftQueue } from "../src/lib/editor-drafts.ts";

function draft(directory, path, text) {
  return {
    directory,
    path,
    text,
    saved: "",
    kind: "text",
    version: "a".repeat(64),
    line_ending: "\n",
    bom: false,
  };
}
test("a scoped draft queue refuses another root before invoking a host", async () => {
  let calls = 0;
  const queue = new EditorDraftQueue(async () => {
    calls++;
    throw Error("Unexpected host call");
  }, "/qa/selected");
  await assert.rejects(queue.put(draft("/qa/other", "a.txt", "text")), { code: "ROOT_DENIED" });
  await assert.rejects(queue.load("/qa/other", "a.txt"), { code: "ROOT_DENIED" });
  assert.equal(calls, 0);
  queue.close();
});
test("queued draft text has a bounded budget and its rejection remains visible to flush", async () => {
  let release, started;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    entered = new Promise((resolve) => {
      started = resolve;
    });
  const writes = [];
  const queue = new EditorDraftQueue(async (method, params) => {
    if (method === "editor_drafts_list") return { revision: "0".repeat(64), drafts: [] };
    if (method === "editor_drafts_remove") return null;
    assert.equal(method, "editor_drafts_put");
    writes.push(params.draft.path);
    if (writes.length === 1) {
      started();
      await gate;
    }
    return { revision: "b".repeat(64), draft: params.draft };
  });
  const text = "x".repeat(2 * 1024 * 1024);
  await queue.initialize();
  const pending = [queue.put(draft("/qa", "0.txt", text))];
  await entered;
  for (let index = 1; index < 8; index++)
    pending.push(queue.put(draft("/qa", `${index}.txt`, text)));
  await assert.rejects(queue.put(draft("/qa", "8.txt", text)), { code: "DRAFT_BACKPRESSURE" });
  release();
  await Promise.all(pending);
  await assert.rejects(queue.flush(), { code: "DRAFT_BACKPRESSURE" });
  assert.equal(writes.length, 8);
  await queue.remove("/qa", "8.txt");
  await queue.flush();
  queue.close();
});
