import { useSyncExternalStore } from "react";

export type FileClipboard = { directory: string; path: string } | null;
let clipboard: FileClipboard = null;
let confirmed: FileClipboard = null;
let revision = 0;
let epoch = 0;
let writer:
  { save: (value: FileClipboard) => Promise<void>; failed: (reason: unknown) => void } | undefined;
let pending = Promise.resolve();
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
  const current = ++revision;
  const adapter = writer;
  const sourceEpoch = epoch;
  if (!adapter) confirmed = value;
  listeners.forEach((listener) => listener());
  if (!adapter) return;
  // Serialize native clipboard updates so a late failure cannot restore an unconfirmed source.
  // 串行更新原生文件剪贴板，避免迟到的失败恢复尚未确认的来源。
  pending = pending
    .then(() => adapter.save(value))
    .then(
      () => {
        if (epoch === sourceEpoch) confirmed = value;
      },
      (reason) => {
        if (epoch !== sourceEpoch) return;
        if (revision === current) {
          clipboard = confirmed;
          listeners.forEach((listener) => listener());
        }
        adapter.failed(reason);
      },
    );
}

export function restoreFileClipboard(value: FileClipboard) {
  epoch++;
  revision++;
  clipboard = confirmed = value;
  listeners.forEach((listener) => listener());
}

export function installFileClipboardWriter(
  save: (value: FileClipboard) => Promise<void>,
  failed: (reason: unknown) => void,
) {
  const adapter = { save, failed };
  epoch++;
  writer = adapter;
  return () => {
    if (writer === adapter) {
      writer = undefined;
      epoch++;
    }
  };
}

export function useFileClipboard() {
  return useSyncExternalStore(subscribe, snapshot);
}
