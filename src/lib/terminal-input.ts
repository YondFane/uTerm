export type TerminalKeyEvent = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey"
>;

export function isBareShiftTab(event: TerminalKeyEvent): boolean {
  return event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
}

export function terminalClipboardAction(
  event: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing"
  >,
  mac: boolean,
  selected: boolean,
): "copy" | "paste" | null {
  // Let macOS deliver native copy/paste events to xterm; async reads trigger WebKit's Paste prompt.
  // 让 macOS 向 xterm 发送原生复制/粘贴事件；异步读取会触发 WebKit 的 Paste 确认。
  if (mac) return null;
  if (event.isComposing || event.altKey) return null;
  const modifier = event.ctrlKey && !event.metaKey;
  if (!modifier) return null;
  if (event.code === "KeyC" && selected) return "copy";
  if (event.code === "KeyV") return "paste";
  return null;
}
