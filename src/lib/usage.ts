import { tx, localizeMessage, getUiLanguage } from "./i18n.ts";
export type UsageWindow = {
  label: string;
  percent: number;
  seconds?: number;
  resetsAt?: string | number;
};

export type RemainingUsage = {
  percent: number;
  title: string;
  windows: UsageWindow[];
};

export function quotaAgent(agent: string | undefined): "codex" | "claude" | "kimi" | "grok" | null {
  return agent === "codex" || agent === "claude" || agent === "kimi" || agent === "grok"
    ? agent
    : null;
}

export function remainingUsage(windows: UsageWindow[]): RemainingUsage | null {
  const valid = windows.filter(
    (window) =>
      typeof window.label === "string" &&
      Number.isFinite(window.percent) &&
      window.percent >= 0 &&
      window.percent <= 100,
  );
  if (!valid.length) return null;
  const remaining = valid.map((window) => ({
    label: window.label,
    percent: Math.round(100 - window.percent),
  }));
  return {
    percent: Math.min(...remaining.map((window) => window.percent)),
    title: remaining
      .map((window) =>
        tx("{p0}剩余 {p1}%", { p0: localizeMessage(window.label), p1: window.percent }),
      )
      .join(getUiLanguage() === "en" ? "; " : "；"),
    windows: valid.map((window) => ({
      ...window,
      percent: Math.round(100 - window.percent),
    })),
  };
}

export function scheduleUsageRefresh(
  refresh: () => void | Promise<void>,
  intervalSeconds: number,
  schedule: (handler: () => void, delay: number) => ReturnType<typeof setInterval> = setInterval,
  cancel: (id: ReturnType<typeof setInterval>) => void = clearInterval,
): () => void {
  let active = true;
  let running = false;
  const run = async () => {
    if (!active || running) return;
    running = true;
    try {
      await refresh();
    } finally {
      running = false;
    }
  };
  const start = () => void run().catch(() => undefined);
  start();
  const timer = schedule(start, intervalSeconds * 1000);
  return () => {
    active = false;
    cancel(timer);
  };
}
