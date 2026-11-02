import type { CoreActivityEvent, CoreTerminalHeader } from "./core-contract.generated";
export type AgentActivityEvent = Omit<CoreActivityEvent, "kind" | "source"> & {
  kind: "idle" | "working" | "waiting" | "done" | "error" | "notice";
  source: "terminal" | "events" | "hook" | "process";
};

export type TerminalFrame = Omit<CoreTerminalHeader, "agent_events"> & {
  agent_events?: AgentActivityEvent[] | null;
  data: Uint8Array;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

const maximumSequence = (1n << 64n) - 1n;

function sequence(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value))
    throw new Error("Invalid terminal frame metadata");
  const integer = BigInt(value);
  if (integer > maximumSequence) throw new Error("Invalid terminal frame metadata");
  return integer;
}

function exactMetadata(raw: string) {
  const pieces: string[] = [];
  let copied = 0;
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== '"') {
      index++;
      continue;
    }
    const start = index++;
    while (index < raw.length) {
      if (raw[index] === "\\") {
        index += 2;
        continue;
      }
      if (raw[index++] === '"') break;
    }
    const end = index;
    while (/\s/.test(raw[index] ?? "") && index < raw.length) index++;
    if (raw[index] !== ":" || JSON.parse(raw.slice(start, end)) !== "sequence") continue;
    let value = index + 1;
    while (value < raw.length && /\s/.test(raw[value])) value++;
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      raw.slice(value),
    )?.[0];
    if (!token || !/^-?[0-9]+$/.test(token)) continue;
    // Quote the integer before JSON.parse can round it; strings and escaped keys remain JSON-validated.
    // 在 JSON.parse 舍入前将整数字面量加引号，字符串与转义键仍由 JSON 校验。
    pieces.push(raw.slice(copied, value), JSON.stringify(token));
    copied = value + token.length;
    index = copied;
  }
  pieces.push(raw.slice(copied));
  return JSON.parse(pieces.join(""));
}

export function terminalAcknowledgement(value: bigint): number | string {
  if (typeof value !== "bigint" || value < 0n || value > maximumSequence)
    throw new Error("Invalid terminal acknowledgement");
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

export function decodeTerminalFrame(payload: ArrayBuffer): TerminalFrame {
  if (payload.byteLength < 4) throw new Error("Invalid terminal frame header");
  const length = new DataView(payload).getUint32(0, true);
  if (!length || length > 65536 || length > payload.byteLength - 4)
    throw new Error("Invalid terminal frame length");
  const metadata = exactMetadata(decoder.decode(new Uint8Array(payload, 4, length)));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Invalid terminal frame metadata");
  metadata.sequence = sequence(metadata.sequence);
  if (Array.isArray(metadata.agent_events)) {
    for (const event of metadata.agent_events) {
      if (!event || typeof event !== "object") throw new Error("Invalid terminal frame metadata");
      event.sequence = sequence(event.sequence);
    }
  }
  if (
    typeof metadata.reset !== "boolean" ||
    typeof metadata.exited !== "boolean" ||
    !Number.isInteger(metadata.rows) ||
    metadata.rows < 1 ||
    metadata.rows > 65535 ||
    !Number.isInteger(metadata.cols) ||
    metadata.cols < 1 ||
    metadata.cols > 65535 ||
    (metadata.code !== null &&
      (!Number.isInteger(metadata.code) || metadata.code < 0 || metadata.code > 4294967295)) ||
    (metadata.error !== null && typeof metadata.error !== "string") ||
    (metadata.agent_state != null && typeof metadata.agent_state !== "string") ||
    (metadata.foreground_agent != null && typeof metadata.foreground_agent !== "string") ||
    (metadata.agent_activity_error != null && typeof metadata.agent_activity_error !== "string") ||
    (metadata.agent_events != null &&
      (!Array.isArray(metadata.agent_events) ||
        metadata.agent_events.length > 128 ||
        metadata.agent_events.some(
          (event: AgentActivityEvent) =>
            typeof event.id !== "string" ||
            !event.id ||
            event.id.length > 100 ||
            event.sequence > metadata.sequence ||
            !["idle", "working", "waiting", "done", "error", "notice"].includes(event.kind) ||
            !["terminal", "events", "hook", "process"].includes(event.source),
        )))
  )
    throw new Error("Invalid terminal frame metadata");
  // Share the IPC buffer; acknowledgements retain metadata, not another output copy.
  // 共享 IPC 缓冲区；确认回调只保留元数据，不再保留额外的输出副本。
  return { ...metadata, data: new Uint8Array(payload, 4 + length) };
}
