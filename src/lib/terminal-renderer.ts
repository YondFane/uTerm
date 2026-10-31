import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";

type AcceleratedRenderer = ITerminalAddon & {
  onContextLoss: (listener: () => void) => IDisposable;
};

/** Uses GPU rendering while available; disposal restores xterm's DOM renderer. / 可用时使用 GPU 渲染，释放后恢复 xterm 的 DOM 渲染器。 */
export function attachTerminalRenderer(
  terminal: Terminal,
  createRenderer: () => AcceleratedRenderer,
  onDisposed?: () => void,
): () => void {
  let renderer: AcceleratedRenderer | undefined;
  let contextLoss: IDisposable | undefined;
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    contextLoss?.dispose();
    renderer?.dispose();
    onDisposed?.();
  }
  try {
    renderer = createRenderer();
    // Context loss must restore a usable terminal rather than leave a frozen canvas.
    // 上下文丢失时恢复可用的终端，避免画布停留在冻结状态。
    contextLoss = renderer.onContextLoss(dispose);
    terminal.loadAddon(renderer);
  } catch {
    // GPU support is optional; xterm keeps its DOM renderer if activation fails.
    // GPU 支持是可选的，激活失败时 xterm 保留 DOM 渲染器。
    dispose();
  }
  return dispose;
}

/** Retain recent hidden renderers without evicting visible split panes. / 保留最近隐藏的渲染器，不回收可见分屏。 */
export function createTerminalRendererPool(maxIdle = 3, idleMs = 15000) {
  const idle = new Map<object, () => void>();
  return {
    register(terminal: Terminal, createRenderer: () => AcceleratedRenderer) {
      const key = {};
      let visible = false;
      let disposed = false;
      let release: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      function removeIdle() {
        clearTimeout(timer);
        timer = undefined;
        idle.delete(key);
      }
      function evict() {
        removeIdle();
        const previous = release;
        release = undefined;
        previous?.();
      }
      return {
        setVisible(next: boolean) {
          if (disposed || next === visible) return;
          visible = next;
          removeIdle();
          if (visible) {
            if (!release) {
              let failed = false;
              const attached = attachTerminalRenderer(terminal, createRenderer, () => {
                failed = true;
                release = undefined;
                removeIdle();
              });
              if (!failed) release = attached;
            }
          } else if (release) {
            idle.set(key, evict);
            timer = setTimeout(evict, idleMs);
            while (idle.size > maxIdle) idle.values().next().value?.();
          }
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          evict();
        },
      };
    },
  };
}

export const terminalRendererPool = createTerminalRendererPool();
