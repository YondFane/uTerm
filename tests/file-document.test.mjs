import test from "node:test";
import assert from "node:assert/strict";
import {
  DocumentSaveQueue,
  fileBytes,
  isDirty,
  savedVersion,
  editorText,
  documentText,
  clipboardPath,
} from "../src/lib/file-document.ts";
test("copied Windows paths omit extended prefixes and preserve UNC shares", () => {
  assert.equal(clipboardPath(String.raw`\\?\D:\a\a-stock-data/1`), String.raw`D:\a\a-stock-data\1`);
  assert.equal(clipboardPath("//?/D:/资料/file.txt"), String.raw`D:\资料\file.txt`);
  assert.equal(
    clipboardPath(String.raw`\\?\UNC\server\share/file.txt`),
    String.raw`\\server\share\file.txt`,
  );
  assert.equal(clipboardPath("//?/UNC/server/share/file.txt"), String.raw`\\server\share\file.txt`);
  assert.equal(clipboardPath("C:/folder/file.txt"), String.raw`C:\folder\file.txt`);
  assert.equal(
    clipboardPath(String.raw`\\server\share/file.txt`),
    String.raw`\\server\share\file.txt`,
  );
  assert.equal(clipboardPath("/home/user/file.txt"), "/home/user/file.txt");
  assert.equal(clipboardPath(String.raw`\\?\Volume{test}\file`), String.raw`\\?\Volume{test}\file`);
});
const original = {
  id: 1,
  directory: "/project",
  path: "source.txt",
  kind: "text",
  text: "before\r\n",
  saved: "before\r\n",
  bom: true,
  readonly: false,
  line_ending: "\r\n",
  version: "one",
  notice: null,
  jump: 0,
};
test("saving an older buffer preserves edits made while the write was in flight", () => {
  const snapshot = { ...original, text: "saved\r\n" };
  const current = { ...snapshot, text: "newer\r\n" };
  const result = savedVersion(current, snapshot, "two");
  assert.equal(result.text, "newer\r\n");
  assert.equal(result.saved, "saved\r\n");
  assert.equal(result.version, "two");
  assert.ok(isDirty(result));
  assert.equal(fileBytes(result), "\ufeffnewer\r\n");
});
test("a late save cannot change a different open document", () => {
  const other = { ...original, id: 2, path: "another.txt" };
  assert.equal(savedVersion(other, original, "late"), other);
  assert.equal(isDirty(original), false);
  assert.equal(isDirty(null), false);
});
test("pasted LF text becomes CRLF on disk without embedding control characters in editor lines", () => {
  assert.equal(editorText("one\r\ntwo\r\n"), "one\ntwo\n");
  assert.equal(documentText("pasted\nlines\n", "\r\n"), "pasted\r\nlines\r\n");
  assert.equal(documentText("one\r\ntwo\n", "\r\n"), "one\r\ntwo\r\n");
});
test("recovery restores dirty content and rejects malformed draft metadata", async () => {
  const { readDraft } = await import("../src/lib/file-document.ts");
  const dirty = { ...original, text: "recover me", version: "a".repeat(64) };
  const restored = readDraft(JSON.stringify(dirty));
  assert.equal(restored.text, "recover me");
  assert.ok(isDirty(restored));
  assert.throws(() => readDraft("{broken"));
  assert.throws(() => readDraft(JSON.stringify({ ...dirty, line_ending: "invalid" })));
});

test("simultaneous save waiters use the latest version and never overlap", async () => {
  const queue = new DocumentSaveQueue();
  let version = 0;
  let active = 0;
  const observed = [];
  const save = () =>
    queue.run(async () => {
      assert.equal(++active, 1);
      observed.push(version);
      await new Promise((resolve) => setImmediate(resolve));
      version++;
      active--;
      return true;
    });
  assert.deepEqual(await Promise.all([save(), save(), save(), save()]), [true, true, true, true]);
  assert.deepEqual(observed, [0, 1, 2, 3]);
});
test("a failed write blocks its waiters but permits an explicit retry", async () => {
  const queue = new DocumentSaveQueue();
  let writes = 0;
  const first = queue.run(async () => {
    writes++;
    return false;
  });
  const waiting = queue.run(async () => {
    writes++;
    return true;
  });
  assert.deepEqual(await Promise.all([first, waiting]), [false, false]);
  assert.equal(writes, 1);
  assert.equal(await queue.run(async () => true), true);
  await assert.rejects(
    queue.run(async () => {
      throw new Error("disk error");
    }),
    /disk error/,
  );
  assert.equal(await queue.run(async () => true), true);
});
