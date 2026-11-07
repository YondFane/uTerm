type Fiber = { return?: Fiber; memoizedState?: Hook };
type Hook = { memoizedState?: { current?: unknown }; next?: Hook };
type ActualTerminal = {
  options?: { disableStdin?: boolean };
  buffer: {
    active: {
      length: number;
      getLine(index: number): { translateToString(trim: boolean): string } | undefined;
    };
  };
};
function actualTerminal(section: HTMLElement): ActualTerminal | undefined {
  // Read the actual unchanged historical xterm ref; canvas output is not DOM textContent.
  // 读取未修改历史组件中的真实 xterm 引用；画布输出不属于 DOM textContent。
  const key = Object.keys(section).find((name) => name.startsWith("__reactFiber$"));
  let fiber = key ? (section as unknown as Record<string, Fiber>)[key] : undefined;
  for (let depth = 0; fiber && depth < 10; depth++, fiber = fiber.return) {
    let hook = fiber.memoizedState;
    for (let index = 0; hook && index < 200; index++, hook = hook.next) {
      const terminal = hook.memoizedState?.current as ActualTerminal | undefined;
      const buffer = terminal?.buffer?.active;
      if (buffer && typeof buffer.getLine === "function" && Number.isInteger(buffer.length)) {
        return terminal;
      }
    }
  }
  return undefined;
}
export function terminalInputReady(section: HTMLElement) {
  // The textarea exists before attachment enables xterm input; its disabled attribute is insufficient.
  // textarea 在连接启用 xterm 输入前已存在；仅检查其 disabled 属性不足。
  return actualTerminal(section)?.options?.disableStdin === false;
}
export function renderedText(section: HTMLElement) {
  const buffer = actualTerminal(section)?.buffer.active;
  if (!buffer) return "";
  return Array.from({ length: buffer.length }, (_, row) =>
    buffer.getLine(row)?.translateToString(true),
  ).join("\n");
}
