import { displayLocalPath } from "./file-target.ts";

export interface TerminalPerformanceSnapshot {
  text: string;
  frames: number;
  bytes: number;
  acknowledgedFrames: number;
  resets: number;
  sequence: string;
  lastAckMilliseconds: number;
  columns: number;
  rows: number;
  writable: boolean;
  receivedFrames: number;
  waitingToRender: boolean;
  largestFrameBytes: number;
  alternateScreen: boolean;
  cursorLine: string;
}

export function windowsPerformancePromptReady(
  snapshot:
    | Pick<TerminalPerformanceSnapshot, "cursorLine" | "writable" | "frames" | "acknowledgedFrames">
    | undefined,
  directory: string,
): boolean {
  return (
    !!snapshot &&
    snapshot.writable &&
    snapshot.frames === snapshot.acknowledgedFrames &&
    snapshot.cursorLine.toLowerCase() === (displayLocalPath(directory) + ">").toLowerCase()
  );
}

const probes = new Map<
  string,
  {
    read: (tailOnly?: boolean) => TerminalPerformanceSnapshot;
    reconnect?: () => Promise<void>;
    delay?: (milliseconds: number) => void;
    pause?: (paused: boolean) => void;
  }
>();

export function registerTerminalPerformanceProbe(
  session: string,
  read: (tailOnly?: boolean) => TerminalPerformanceSnapshot,
  reconnect?: () => Promise<void>,
  delay?: (milliseconds: number) => void,
  pause?: (paused: boolean) => void,
) {
  const probe = { read, reconnect, delay, pause };
  probes.set(session, probe);
  return () => {
    // A disposed older view must not remove the replacement view's probe.
    // 旧视图的清理不能移除替换视图的探针。
    if (probes.get(session) === probe) probes.delete(session);
  };
}

export function delayTerminalPerformanceConsumer(session: string, milliseconds: number) {
  const probe = probes.get(session);
  if (!probe?.delay || !Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 1000)
    throw Error("Invalid measured consumer delay");
  probe.delay(milliseconds);
}

export function pauseTerminalPerformanceConsumer(session: string, paused: boolean) {
  const probe = probes.get(session);
  if (!probe?.pause) throw Error("Missing measured consumer pause control");
  probe.pause(paused);
}

export function terminalPerformanceSnapshot(session: string, tailOnly = false) {
  return probes.get(session)?.read(tailOnly);
}

export async function reconnectTerminalPerformanceProbe(session: string) {
  const probe = probes.get(session);
  if (!probe?.reconnect) throw Error("Measured terminal is no longer attached");
  await probe.reconnect();
}
