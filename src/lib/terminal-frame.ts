export type AgentActivityEvent = {
  id: string;
  sequence: number;
  kind: "idle" | "working" | "waiting" | "done" | "error" | "notice";
  source: "terminal" | "events" | "hook" | "process";
};

export type TerminalFrame = {
  agent_events?: AgentActivityEvent[] | null;
  agent_activity_error?: string | null;
  agent_state?: string | null;
  foreground_agent?: string | null;
  sequence: number;
  reset: boolean;
  rows: number;
  cols: number;
  data: Uint8Array;
  exited: boolean;
  code: number | null;
  error: string | null;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeTerminalFrame(payload: ArrayBuffer): TerminalFrame {
  if (payload.byteLength < 4) throw new Error("Invalid terminal frame header");
  const length = new DataView(payload).getUint32(0, true);
  if (!length || length > payload.byteLength - 4) throw new Error("Invalid terminal frame length");
  const metadata = JSON.parse(decoder.decode(new Uint8Array(payload, 4, length)));
  if (
    !metadata ||
    !Number.isSafeInteger(metadata.sequence) ||
    metadata.sequence < 0 ||
    typeof metadata.reset !== "boolean" ||
    typeof metadata.exited !== "boolean" ||
    !Number.isInteger(metadata.rows) ||
    metadata.rows < 1 ||
    metadata.rows > 65535 ||
    !Number.isInteger(metadata.cols) ||
    metadata.cols < 1 ||
    metadata.cols > 65535 ||
    (metadata.code !== null && !Number.isInteger(metadata.code)) ||
    (metadata.error !== null && typeof metadata.error !== "string") ||
    (metadata.agent_state != null && typeof metadata.agent_state !== "string") ||
    (metadata.foreground_agent != null && typeof metadata.foreground_agent !== "string") ||
    (metadata.agent_activity_error != null && typeof metadata.agent_activity_error !== "string") ||
    (metadata.agent_events != null &&
      (!Array.isArray(metadata.agent_events) ||
        metadata.agent_events.length > 128 ||
        metadata.agent_events.some(
          (event: AgentActivityEvent) =>
            !event ||
            typeof event.id !== "string" ||
            !event.id ||
            event.id.length > 100 ||
            !Number.isSafeInteger(event.sequence) ||
            event.sequence < 0 ||
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
