import { useEffect } from "react";
import { contentInvoke } from "./content-host";
import { localizeMessage } from "./i18n";

export function useNativeModalLayout(
  selector: string,
  method: string,
  version: unknown,
  fail: (error: string) => void,
) {
  useEffect(() => {
    const dialog = document.querySelector<HTMLDialogElement>(selector);
    const form = dialog?.querySelector("form");
    if (!dialog || !form || typeof ResizeObserver === "undefined") return;
    let active = true;
    let lastHeight = 0;
    const measure = () => {
      if (!active) return;
      const style = getComputedStyle(dialog);
      const height = Math.ceil(
        dialog.scrollHeight +
          parseFloat(style.borderTopWidth) +
          parseFloat(style.borderBottomWidth),
      );
      if (!Number.isFinite(height) || height < 40 || height > 4096 || height === lastHeight) return;
      lastHeight = height;
      void contentInvoke(method, { height }).catch((reason) => {
        if (active) fail(localizeMessage(String(reason)));
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(form);
    observer.observe(dialog);
    void document.fonts?.ready.then(measure);
    measure();
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [selector, method, version]);
}
