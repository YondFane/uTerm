import { useEffect, useRef, useState } from "react";
import { useSettings } from "../lib/SettingsContext";
import { scheduleBreakReminder } from "../lib/break-reminder";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import "./BreakReminder.css";

export function BreakReminder() {
  useUiLanguage();
  const { settings } = useSettings();
  const [visible, setVisible] = useState(false);
  const schedule = useRef<ReturnType<typeof scheduleBreakReminder> | null>(null);
  useEffect(() => {
    setVisible(false);
    if (!settings.breakReminder) return;
    const active = scheduleBreakReminder(settings.breakInterval, setVisible);
    schedule.current = active;
    return () => {
      active.stop();
      schedule.current = null;
    };
  }, [settings.breakReminder, settings.breakInterval]);
  if (!visible) return null;
  return (
    <aside className="break-reminder" role="status" aria-live="polite">
      <strong>{tx("休息提醒")}</strong>
      <p>{tx("该休息一下了，起来活动活动吧。")}</p>
      <small>{tx("10 秒后自动关闭，不影响继续使用。")}</small>
      <button onClick={() => schedule.current?.dismiss()}>{tx("继续使用")}</button>
    </aside>
  );
}
