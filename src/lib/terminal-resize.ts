import type { Terminal } from "@xterm/xterm";

type TerminalSize = { rows: number; cols: number };

export function createTerminalResizeQueue(
  send: (size: TerminalSize) => Promise<void>,
  onError: (reason: unknown) => void,
) {
  let pending: TerminalSize | undefined;
  let running = false;
  let disposed = false;
  async function drain() {
    running = true;
    try {
      while (pending && !disposed) {
        const size = pending;
        pending = undefined;
        try {
          await send(size);
        } catch (reason) {
          if (!disposed) onError(reason);
        }
      }
    } finally {
      running = false;
    }
  }
  return {
    request(size: TerminalSize) {
      if (disposed) return;
      // Keep only the latest size while the host finishes its current resize.
      // 后台完成当前尺寸调整期间，仅保留最新尺寸。
      pending = size;
      if (!running) void drain();
    },
    dispose() {
      disposed = true;
      pending = undefined;
    },
  };
}

export function attachTerminalFit(
  terminal: Terminal,
  container: HTMLElement,
  fit: () => void,
  canFit: () => boolean,
  onError: (reason: unknown) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  let disposed = false;
  function cancel() {
    revision++;
    clearTimeout(timer);
    timer = undefined;
  }
  function schedule() {
    cancel();
    if (disposed) return;
    const expected = revision;
    // Keep the grid stable during drags and consume old output before changing its size.
    // 拖动期间保持终端网格稳定，改变尺寸前先消费旧尺寸的输出。
    timer = setTimeout(() => {
      timer = undefined;
      terminal.write("", () => {
        if (
          disposed ||
          expected !== revision ||
          !container.clientWidth ||
          !container.clientHeight ||
          !canFit()
        )
          return;
        try {
          fit();
        } catch (reason) {
          onError(reason);
        }
      });
    }, 120);
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(container);
  return {
    schedule,
    cancel,
    dispose() {
      disposed = true;
      cancel();
      observer.disconnect();
    },
  };
}
