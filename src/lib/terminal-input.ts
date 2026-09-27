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
  if (event.isComposing || event.altKey) return null;
  const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier) return null;
  if (event.code === "KeyC" && selected) return "copy";
  if (event.code === "KeyV") return "paste";
  return null;
}
