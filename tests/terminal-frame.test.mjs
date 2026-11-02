import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { decodeTerminalFrame, terminalAcknowledgement } from "../src/lib/terminal-frame.ts";

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
    assert.deepEqual(header, { ...metadata, sequence: 42n });
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
    [{ ...event, sequence: 41n }],
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

test("Rust terminal fixtures and acknowledgements retain every u64 digit", () => {
  const fixtures = JSON.parse(
    readFileSync(new URL("../shared/fixtures/terminal-precision.json", import.meta.url), "utf8"),
  );
  for (const { sequence, header } of fixtures) {
    const bytes = Buffer.from(header);
    const frame = new ArrayBuffer(4 + bytes.length);
    new DataView(frame).setUint32(0, bytes.length, true);
    new Uint8Array(frame, 4).set(bytes);
    const decoded = decodeTerminalFrame(frame);
    assert.equal(decoded.sequence.toString(), sequence);
    assert.equal(decoded.agent_events[0].sequence.toString(), sequence);
    const wire = terminalAcknowledgement(decoded.sequence);
    assert.equal(BigInt(wire).toString(), sequence);
    assert.equal(JSON.parse(JSON.stringify({ sequence: wire })).sequence, wire);
    if (BigInt(sequence) > BigInt(Number.MAX_SAFE_INTEGER)) assert.equal(typeof wire, "string");
    else assert.equal(typeof wire, "number");
  }
});

test("exact sequence scanning respects strings, escaped keys and unsigned integer syntax", () => {
  const text = 'literal "sequence":9007199254740993 and slash \\';
  const frame = encode({ ...metadata, error: text, sequence: "18446744073709551615" });
  assert.equal(decodeTerminalFrame(frame).error, text);
  assert.equal(decodeTerminalFrame(frame).sequence, 18446744073709551615n);
  for (const value of ["-1", "01", "+1", "1e3", "18446744073709551616", 1.5, true, null]) {
    assert.throws(() => decodeTerminalFrame(encode({ ...metadata, sequence: value })));
  }
  for (const value of [-1n, 1n << 64n]) assert.throws(() => terminalAcknowledgement(value));
  assert.equal(terminalAcknowledgement(0n), 0);
  for (const literal of ["1.0", "1e3", "-1", "18446744073709551616"]) {
    const raw = JSON.stringify(metadata).replace('"sequence":42', '"seq\\u0075ence":' + literal);
    const bytes = Buffer.from(raw);
    const data = new ArrayBuffer(4 + bytes.length);
    new DataView(data).setUint32(0, bytes.length, true);
    new Uint8Array(data, 4).set(bytes);
    assert.throws(() => decodeTerminalFrame(data));
  }
});
