import type { Terminal } from "@xterm/xterm";

/** Uses small wheel steps with speed-based acceleration and batches application input.
 * 使用小步滚轮滚动并按速度加速，同时合并应用输入。 */
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
  let previousMode = "";
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
    const magnitude = Math.abs(event.deltaY);
    const mode =
      event.deltaMode === Wheel.DOM_DELTA_PAGE
        ? "page"
        : event.deltaMode === Wheel.DOM_DELTA_LINE || magnitude >= 40
          ? "wheel"
          : "pixel";
    const nextContext = application ? `application:${tracking}` : "scrollback";
    const nextDirection = Math.sign(event.deltaY);
    const elapsed = event.timeStamp - previousTime;
    const reset =
      nextContext !== context ||
      nextDirection !== direction ||
      mode !== previousMode ||
      elapsed < 0 ||
      elapsed > 200;
    if (reset) remainder = 0;
    let distance: number;
    if (mode === "wheel") {
      // Browsers report notches as large pixel deltas or several lines; start with a small step.
      // 浏览器将滚轮刻度报告为较大的像素位移或数行，先将其归一为小步滚动。
      const unit = event.deltaMode === Wheel.DOM_DELTA_LINE ? 3 : 100;
      const acceleration = reset ? 1 : Math.min(6, Math.max(1, 120 / Math.max(20, elapsed)));
      distance = nextDirection * Math.max(1, magnitude / unit) * acceleration;
    } else if (mode === "page") {
      distance = event.deltaY * terminal.rows;
    } else {
      // Trackpad pixels already express speed; keep their distance and fractional precision.
      // 触控板像素位移本身已包含速度信息，保留原有距离和小数精度。
      const screenHeight = element.querySelector(".xterm-screen")?.getBoundingClientRect().height;
      const cellHeight = screenHeight
        ? screenHeight / terminal.rows
        : (terminal.options.fontSize ?? 14) * (terminal.options.lineHeight ?? 1);
      distance = event.deltaY / cellHeight;
    }
    if (event.altKey) distance *= terminal.options.fastScrollSensitivity ?? 5;
    context = nextContext;
    direction = nextDirection;
    previousMode = mode;
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
