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
}

const probes = new Map<
  string,
  { read: (tailOnly?: boolean) => TerminalPerformanceSnapshot; reconnect?: () => Promise<void> }
>();

export function registerTerminalPerformanceProbe(
  session: string,
  read: (tailOnly?: boolean) => TerminalPerformanceSnapshot,
  reconnect?: () => Promise<void>,
) {
  const probe = { read, reconnect };
  probes.set(session, probe);
  return () => {
    // A disposed older view must not remove the replacement view's probe.
    // 旧视图的清理不能移除替换视图的探针。
    if (probes.get(session) === probe) probes.delete(session);
  };
}

export function terminalPerformanceSnapshot(session: string, tailOnly = false) {
  return probes.get(session)?.read(tailOnly);
}

export async function reconnectTerminalPerformanceProbe(session: string) {
  const probe = probes.get(session);
  if (!probe?.reconnect) throw Error("Measured terminal is no longer attached");
  await probe.reconnect();
}
