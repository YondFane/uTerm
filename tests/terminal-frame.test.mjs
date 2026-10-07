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
  ])
    assert.throws(() => decodeTerminalFrame(encode(header)));
  const invalid = encode();
  new Uint8Array(invalid)[4] = 255;
  assert.throws(() => decodeTerminalFrame(invalid));
  new Uint8Array(invalid)[4] = 33;
  assert.throws(() => decodeTerminalFrame(invalid));
});
