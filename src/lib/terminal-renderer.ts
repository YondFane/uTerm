import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";

type AcceleratedRenderer = ITerminalAddon & {
  onContextLoss: (listener: () => void) => IDisposable;
};

/** Uses GPU rendering while available; disposal restores xterm's DOM renderer. / 可用时使用 GPU 渲染，释放后恢复 xterm 的 DOM 渲染器。 */
export function attachTerminalRenderer(
  terminal: Terminal,
  createRenderer: () => AcceleratedRenderer,
): () => void {
  let renderer: AcceleratedRenderer | undefined;
  let contextLoss: IDisposable | undefined;
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    contextLoss?.dispose();
    renderer?.dispose();
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
