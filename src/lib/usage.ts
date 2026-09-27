import { tx, localizeMessage, getUiLanguage } from "./i18n.ts";
export type UsageWindow = {
  label: string;
  percent: number;
};

export type RemainingUsage = {
  percent: number;
  title: string;
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
  };
}
