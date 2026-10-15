export function scheduleBreakReminder(minutes: number, show: (visible: boolean) => void) {
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const dismiss = () => {
    clearTimeout(timer);
    show(false);
    if (!stopped) timer = setTimeout(remind, minutes * 60_000);
  };
  const remind = () => {
    // Schedule from dismissal, never replay reminders missed during sleep.
    // 从关闭提醒时重新计时，永不补发休眠期间错过的多次提醒。
    show(true);
    timer = setTimeout(dismiss, 10_000);
  };
  timer = setTimeout(remind, minutes * 60_000);
  return {
    dismiss,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
