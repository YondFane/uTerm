import type { Terminal } from "@xterm/xterm";

/** Preserves wheel distance for scrollback and application scrolling, batching each event's input.
 * 保留回滚历史及应用滚动的滚轮距离，并合并每次滚轮事件产生的输入。 */
export function attachTerminalScrollInput(
  terminal: Terminal,
  send: (data: Uint8Array) => void,
): () => void {
  const encoder = new TextEncoder();
  let batch: Uint8Array[] | null = null;
  const forward = (data: Uint8Array) => {
    if (batch) batch.push(data);
    else send(data);
  };
  const input = terminal.onData((value) => forward(encoder.encode(value)));
  const binary = terminal.onBinary((value) =>
    forward(Uint8Array.from(value, (character) => character.charCodeAt(0))),
  );
  const element = terminal.element;
  const Wheel = element?.ownerDocument.defaultView?.WheelEvent;
  const delegated = new WeakSet<WheelEvent>();
  let remainder = 0;
  let direction = 0;
  let context = "";
  let previousTime = -Infinity;
  const wheel = (event: WheelEvent) => {
    if (
      !element ||
      !Wheel ||
      delegated.has(event) ||
      event.defaultPrevented ||
      !event.cancelable ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !Number.isFinite(event.deltaY) ||
      event.deltaY === 0 ||
      Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
      terminal.rows < 1
    )
      return;
    const tracking = terminal.modes.mouseTrackingMode;
    const application =
      terminal.buffer.active.type === "alternate" || (tracking !== "none" && tracking !== "x10");
    if (application && terminal.options.disableStdin) return;
    const screenHeight = element.querySelector(".xterm-screen")?.getBoundingClientRect().height;
    const cellHeight = screenHeight
      ? screenHeight / terminal.rows
      : (terminal.options.fontSize ?? 14) * (terminal.options.lineHeight ?? 1);
    let distance = event.deltaY;
    if (event.deltaMode === Wheel.DOM_DELTA_PIXEL) distance /= cellHeight;
    else if (event.deltaMode === Wheel.DOM_DELTA_PAGE) distance *= terminal.rows;
    // Keep fine trackpad movement precise; mouse-wheel notches cover more history.
    // 保留触控板细微移动的精度，让鼠标滚轮刻度覆盖更多历史内容。
    if (event.deltaMode !== Wheel.DOM_DELTA_PIXEL || Math.abs(event.deltaY) >= 40) distance *= 2;
    if (event.altKey) distance *= terminal.options.fastScrollSensitivity ?? 5;
    const nextContext = application ? `application:${tracking}` : "scrollback";
    const nextDirection = Math.sign(distance);
    if (
      nextContext !== context ||
      nextDirection !== direction ||
      event.timeStamp - previousTime > 200
    )
      remainder = 0;
    context = nextContext;
    direction = nextDirection;
    previousTime = event.timeStamp;
    distance += remainder;
    const wholeLines = Math.trunc(distance);
    remainder = distance - wholeLines;
    const limit = application ? Math.min(12, terminal.rows) : terminal.rows * 4;
    const lines = Math.sign(wholeLines) * Math.min(Math.abs(wholeLines), limit);
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!lines) return;
    if (!application) {
      terminal.scrollLines(lines);
      return;
    }
    // xterm 6 emits one application report per wheel event; delegate each line for native encoding.
    // xterm 6 每个滚轮事件只发送一条应用报告；逐行委托给它，以保留原有协议编码。
    batch = [];
    try {
      for (let index = 0; index < Math.abs(lines); index++) {
        const step = new Wheel("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          buttons: event.buttons,
          altKey: event.altKey,
          deltaMode: Wheel.DOM_DELTA_LINE,
          deltaY: Math.sign(lines),
        });
        delegated.add(step);
        element.dispatchEvent(step);
      }
    } finally {
      const chunks = batch;
      batch = null;
      const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
      if (length) {
        const data = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        send(data);
      }
    }
  };
  element?.addEventListener("wheel", wheel, { capture: true, passive: false });
  return () => {
    element?.removeEventListener("wheel", wheel, true);
    input.dispose();
    binary.dispose();
  };
}
