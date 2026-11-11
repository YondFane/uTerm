import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";

const target = { directory: "/qa/中文", path: "document.pdf", version: "a".repeat(64) };
const mark = (id) => ({ id, page: 1, x: 0.1234567890123456, y: 0.2, width: 0.4, height: 0.3 });

test("PDF marks retain old browser data, reject stale writes and reapply one explicit change without losing other marks", async () => {
  const dom = new JSDOM("", { url: "http://localhost" });
  for (const key of ["window", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const server = await createServer({ configFile: false });
  const { PdfMarkSession, parsePdfMarks } = await server.ssrLoadModule("/src/lib/pdf-marks.ts");
  const key = `uterm.pdf.marks:${target.directory}/${target.path}:${target.version}`;
  try {
    const first = new PdfMarkSession(target),
      second = new PdfMarkSession(target);
    assert.deepEqual(await first.load(), []);
    assert.deepEqual(await second.load(), []);
    assert.deepEqual(await first.add(mark("one")), [mark("one")]);
    await assert.rejects(second.add(mark("two")), { code: "CONFLICT" });
    assert.equal(second.hasPending, true);
    assert.deepEqual(second.committed(), []);
    assert.deepEqual(await second.retry(), [mark("one"), mark("two")]);
    assert.equal(second.hasPending, false);
    await assert.rejects(first.remove("one"), { code: "CONFLICT" });
    assert.deepEqual(await first.retry(), [mark("two")]);
    assert.deepEqual(await new PdfMarkSession(target).load(), [mark("two")]);
    assert.deepEqual(await new PdfMarkSession({ ...target, version: "b".repeat(64) }).load(), []);
    const bytes = localStorage.getItem(key);
    for (const bad of [
      [mark("same"), mark("same")],
      [{ ...mark("bad"), page: 0 }],
      [{ ...mark("bad"), x: NaN }],
      [{ ...mark("bad"), width: 1 }],
      [{ ...mark("bad"), password: "private" }],
    ]) {
      assert.throws(() => parsePdfMarks(bad));
      assert.equal(localStorage.getItem(key), bytes);
    }
    localStorage.setItem(key, "{original broken bytes");
    const broken = new PdfMarkSession(target);
    await assert.rejects(broken.load());
    await assert.rejects(broken.add(mark("new")));
    assert.equal(localStorage.getItem(key), "{original broken bytes");
  } finally {
    await server.close();
    dom.window.close();
  }
});

test("PDF quota failures retain the attempted change for retry or explicit discard", async () => {
  const dom = new JSDOM("", { url: "http://localhost" });
  for (const key of ["window", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const server = await createServer({ configFile: false });
  const { PdfMarkSession } = await server.ssrLoadModule("/src/lib/pdf-marks.ts");
  const original = window.Storage.prototype.setItem;
  try {
    const session = new PdfMarkSession(target);
    await session.load();
    window.Storage.prototype.setItem = () => {
      throw Error("Quota exceeded");
    };
    await assert.rejects(session.add(mark("retained")), /Quota/);
    assert.deepEqual(session.committed(), []);
    assert.deepEqual(session.preview(), [mark("retained")]);
    assert.equal(session.hasPending, true);
    window.Storage.prototype.setItem = original;
    assert.deepEqual(await session.retry(), [mark("retained")]);
    window.Storage.prototype.setItem = () => {
      throw Error("Quota exceeded");
    };
    await assert.rejects(session.remove("retained"));
    assert.deepEqual(session.discard(), [mark("retained")]);
    assert.equal(session.hasPending, false);
  } finally {
    window.Storage.prototype.setItem = original;
    await server.close();
    dom.window.close();
  }
});

test("native PDF metadata transports only its captured identity and waits for actual write confirmation", async () => {
  const dom = new JSDOM("", { url: "http://localhost" });
  for (const key of ["window", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const server = await createServer({ configFile: false });
  const { PdfMarkSession } = await server.ssrLoadModule("/src/lib/pdf-marks.ts");
  let release;
  let stored = [];
  let revision = "1".repeat(64);
  const calls = [];
  window.utermContentDocument = "pdf-test";
  window.webkit = {
    messageHandlers: {
      utermContent: {
        async postMessage(message) {
          calls.push(message);
          assert.equal(message.document, "pdf-test");
          assert.equal(message.params.directory, target.directory);
          assert.equal(message.params.path, target.path);
          assert.equal(message.params.version, target.version);
          assert.equal(JSON.stringify(message).includes("DO_NOT_SEND_PDF_BYTES"), false);
          let result;
          if (message.method === "pdf_marks_read")
            result = { revision, marks: structuredClone(stored) };
          else {
            assert.equal(message.method, "pdf_marks_write");
            assert.equal(message.params.expectedRevision, revision);
            await new Promise((resolve) => {
              release = resolve;
            });
            revision = "2".repeat(64);
            stored = structuredClone(message.params.marks);
            result = { revision, marks: stored };
          }
          return { version: 1, id: message.id, document: message.document, result };
        },
      },
    },
  };
  try {
    const input = { ...target, text: "DO_NOT_SEND_PDF_BYTES", id: 99 };
    const session = new PdfMarkSession(input);
    input.path = "another.pdf";
    await session.load();
    let finished = false;
    const save = session.add(mark("one")).finally(() => {
      finished = true;
    });
    await new Promise((done) => setTimeout(done, 0));
    await assert.rejects(session.add(mark("two")));
    assert.equal(finished, false);
    assert.equal(calls.filter((call) => call.method === "pdf_marks_write").length, 1);
    assert.deepEqual(session.committed(), []);
    release();
    assert.deepEqual(await save, [mark("one")]);
    assert.deepEqual(await new PdfMarkSession(target).load(), [mark("one")]);
  } finally {
    await server.close();
    dom.window.close();
  }
});
