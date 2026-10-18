import test from "node:test";
import assert from "node:assert/strict";
import { decodeTerminalFrame } from "../src/lib/terminal-frame.ts";

const metadata = {
  agent_state: "idle",
  foreground_agent: null,
  sequence: 42,
  reset: true,
  rows: 24,
  cols: 80,
  exited: true,
  code: 1,
  error: "连接错误",
};
function encode(header = metadata, data = new Uint8Array()) {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const buffer = new ArrayBuffer(4 + json.length + data.length);
  new DataView(buffer).setUint32(0, json.length, true);
  new Uint8Array(buffer, 4, json.length).set(json);
  new Uint8Array(buffer, 4 + json.length).set(data);
  return buffer;
}

test("binary terminal frames preserve all bytes and replay/exit metadata without copying output", () => {
  for (const data of [new Uint8Array(), Uint8Array.from({ length: 256 }, (_, i) => i)]) {
    const payload = encode(metadata, data);
    const { data: decoded, ...header } = decodeTerminalFrame(payload);
    assert.deepEqual(header, metadata);
    assert.deepEqual(decoded, data);
    assert.equal(decoded.buffer, payload);
  }
});

test("terminal frames reject truncation, invalid UTF-8/JSON and invalid replay metadata", () => {
  for (const payload of [new ArrayBuffer(0), new ArrayBuffer(4), encode().slice(0, 8)])
    assert.throws(() => decodeTerminalFrame(payload));
  for (const header of [
    null,
    {},
    { ...metadata, sequence: -1 },
    { ...metadata, rows: 0 },
    { ...metadata, reset: "true" },
    { ...metadata, agent_activity_error: 5 },
  ])
    assert.throws(() => decodeTerminalFrame(encode(header)));
  const invalid = encode();
  new Uint8Array(invalid)[4] = 255;
  assert.throws(() => decodeTerminalFrame(invalid));
  new Uint8Array(invalid)[4] = 33;
  assert.throws(() => decodeTerminalFrame(invalid));
});

test("terminal frames validate independent activity events while accepting older hosts", () => {
  const event = { id: "event-a", sequence: 41, kind: "notice", source: "terminal" };
  assert.deepEqual(
    decodeTerminalFrame(encode({ ...metadata, agent_events: [event] })).agent_events,
    [event],
  );
  assert.equal(decodeTerminalFrame(encode(metadata)).agent_events, undefined);
  for (const agent_events of [
    false,
    Array(129).fill(event),
    [null],
    [{ ...event, sequence: 43 }],
    [{ ...event, kind: "success" }],
    [{ ...event, source: "external" }],
    [{ ...event, id: "" }],
  ]) {
    assert.throws(() => decodeTerminalFrame(encode({ ...metadata, agent_events })));
  }
});
