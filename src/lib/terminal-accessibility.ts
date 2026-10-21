const announcementLimit = 8192;

/** Bounds live announcements while preserving terminal rows and input. / 限制实时播报长度，同时保留终端文本行和输入。 */
export function attachTerminalAccessibilityLimit(
  element: HTMLElement,
  overflowMessage: () => string,
): () => void {
  const limit = () => {
    const region = element.querySelector(".xterm-accessibility .live-region");
    const text = region?.textContent;
    if (!region || !text || text.length <= announcementLimit) return;
    // Cursor-based redraws may never reach xterm's newline limit; WebKit then scans huge hidden text.
    // 光标重绘可能始终达不到 xterm 的换行上限，导致 WebKit 遍历巨量隐藏文本。
    const message = `${overflowMessage()}\n`;
    let start = text.length - announcementLimit + message.length;
    const first = text.charCodeAt(start);
    if (first >= 0xdc00 && first <= 0xdfff) start++;
    region.textContent = message + text.slice(start);
  };
  const observer = new MutationObserver(limit);
  observer.observe(element, { childList: true, characterData: true, subtree: true });
  limit();
  return () => observer.disconnect();
}
