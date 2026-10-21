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

function isTerminalPunctuation(text: string): boolean {
  return (
    text.length > 0 &&
    [...text].every((character) => {
      const code = character.charCodeAt(0);
      return (
        (code >= 0x21 && code <= 0x2f) ||
        (code >= 0x3a && code <= 0x40) ||
        (code >= 0x5b && code <= 0x60) ||
        (code >= 0x7b && code <= 0x7e) ||
        (code > 0x7f && /^\p{P}$/u.test(character))
      );
    })
  );
}

export function terminalPunctuationKey(
  event: Pick<KeyboardEvent, "key" | "keyCode" | "isComposing" | "ctrlKey" | "altKey" | "metaKey">,
): string | null {
  if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey)
    return null;
  return event.key.length === 1 && isTerminalPunctuation(event.key) ? event.key : null;
}

export function attachTerminalPunctuationInput(
  textarea: HTMLTextAreaElement,
  input: (text: string) => void,
  enabled: () => boolean,
): () => void {
  let composing = false;
  let finishing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alignCursor = () => {
    if (!enabled() || composing) return;
    // xterm reads new IME text from the old value's end, independently of the terminal cursor.
    // xterm 从旧文本末尾读取新的输入法文本，该位置与终端光标相互独立。
    const end = textarea.value.length;
    if (textarea.selectionStart !== end || textarea.selectionEnd !== end)
      textarea.setSelectionRange(end, end);
  };
  const keyDown = (event: KeyboardEvent) => {
    if (
      event.isComposing ||
      composing ||
      finishing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    )
      return;
    if (event.keyCode === 229 || event.key.length === 1) alignCursor();
  };
  const start = () => {
    alignCursor();
    clearTimeout(timer);
    composing = true;
    finishing = false;
  };
  const end = () => {
    composing = false;
    finishing = true;
    timer = setTimeout(() => {
      finishing = false;
    }, 0);
  };
  const beforeInput = (event: InputEvent) => {
    const text = event.data;
    if (
      !enabled() ||
      !event.cancelable ||
      event.isComposing ||
      composing ||
      finishing ||
      event.inputType !== "insertText" ||
      !text ||
      !isTerminalPunctuation(text)
    )
      return;
    // Consume committed punctuation before textarea mutation; xterm's delayed IME diff then stays empty.
    // 在文本框变更前接收已提交的标点，让 xterm 延迟执行的输入法差量保持为空。
    event.preventDefault();
    event.stopImmediatePropagation();
    input(text);
  };
  textarea.addEventListener("keydown", keyDown, true);
  textarea.addEventListener("compositionstart", start, true);
  textarea.addEventListener("compositionend", end);
  textarea.addEventListener("beforeinput", beforeInput);
  return () => {
    clearTimeout(timer);
    textarea.removeEventListener("keydown", keyDown, true);
    textarea.removeEventListener("compositionstart", start, true);
    textarea.removeEventListener("compositionend", end);
    textarea.removeEventListener("beforeinput", beforeInput);
  };
}
