import { useRef } from "react";
import type { MouseEvent, PointerEvent } from "react";

export function outsideDialog(
  rect: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number,
) {
  return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
}

export function useDialogBackdrop(close: () => void) {
  const startedOutside = useRef(false);
  const outside = (event: MouseEvent<HTMLDialogElement>) =>
    event.target === event.currentTarget &&
    outsideDialog(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
  return {
    onPointerDown(event: PointerEvent<HTMLDialogElement>) {
      startedOutside.current = event.button === 0 && outside(event);
    },
    onPointerCancel() {
      startedOutside.current = false;
    },
    onClick(event: MouseEvent<HTMLDialogElement>) {
      // Both ends must be outside so dragging from an input cannot dismiss the dialog.
      // 按下与点击结束都须在外部，避免从输入框拖动时误关窗口。
      const dismiss = startedOutside.current && outside(event);
      startedOutside.current = false;
      if (dismiss) close();
    },
  };
}
