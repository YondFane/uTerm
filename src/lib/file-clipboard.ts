import { useSyncExternalStore } from "react";

type FileClipboard = { directory: string; path: string } | null;
let clipboard: FileClipboard = null;
const listeners = new Set<() => void>();
const snapshot = () => clipboard;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// Keep the source root across panel remounts, without persisting paths to disk.
// 跨面板重新挂载保留源项目根目录，但不将路径持久化到磁盘。
export function setFileClipboard(value: FileClipboard) {
  clipboard = value;
  listeners.forEach((listener) => listener());
}

export function useFileClipboard() {
  return useSyncExternalStore(subscribe, snapshot);
}
