import type { Terminal } from "@xterm/xterm";

type ReplayTerminal = Pick<Terminal, "buffer" | "rows" | "scrollToLine" | "scrollToBottom">;

export function taskLogText(
  buffer: Pick<Terminal["buffer"]["active"], "length" | "getLine">,
): string {
  let text = "";
  for (let index = 0; index < buffer.length; index++) {
    const wrapped = buffer.getLine(index + 1)?.isWrapped;
    text += buffer.getLine(index)?.translateToString(!wrapped) ?? "";
    if (!wrapped) text += "\n";
  }
  return text.trimEnd();
}

function bottomHasText(terminal: ReplayTerminal) {
  const buffer = terminal.buffer.active;
  for (let row = buffer.baseY; row < buffer.length; row++) {
    if (buffer.getLine(row)?.translateToString(true).trim()) return true;
  }
  return false;
}

/** Reveal retained task logs when a replay ends with an empty viewport. / 回放末尾视口为空时显示保留的任务日志。 */
export function restoreTaskReplayViewport(terminal: ReplayTerminal): number | null {
  const buffer = terminal.buffer.active;
  if (buffer.type !== "normal" || buffer.viewportY !== buffer.baseY || bottomHasText(terminal))
    return null;
  for (let row = buffer.baseY - 1; row >= 0; row--) {
    if (!buffer.getLine(row)?.translateToString(true).trim()) continue;
    terminal.scrollToLine(Math.max(0, row - Math.max(0, terminal.rows - 2)));
    return buffer.viewportY;
  }
  return null;
}

/** Resume following new log text unless the user has moved the viewport. / 用户未移动视口时恢复跟随新增日志。 */
export function followTaskReplayViewport(
  terminal: ReplayTerminal,
  restoredViewport: number | null,
): number | null {
  if (
    restoredViewport === null ||
    terminal.buffer.active.type !== "normal" ||
    terminal.buffer.active.viewportY !== restoredViewport
  )
    return null;
  const buffer = terminal.buffer.active;
  for (let row = buffer.length - 1; row >= 0; row--) {
    if (!buffer.getLine(row)?.translateToString(true).trim()) continue;
    // Follow actual log text until it fills the padding, rather than jumping back into blank rows.
    // 实际日志填满补齐的空行前跟随日志末尾，避免再次跳入空白区域。
    const target = Math.min(buffer.baseY, Math.max(0, row - Math.max(0, terminal.rows - 2)));
    if (target === buffer.baseY) {
      terminal.scrollToBottom();
      return null;
    }
    if (target !== buffer.viewportY) terminal.scrollToLine(target);
    return buffer.viewportY;
  }
  return restoredViewport;
}
