import { Channel, invoke } from "@tauri-apps/api/core";
import { sshError, type RemoteRoot } from "./file-target";
export interface RemoteTransfer {
  id: string;
  direction: "upload" | "download";
  name: string;
  completed: number;
  total: number;
  state: "running" | "done" | "cancelled" | "error";
  error?: string;
}
let tasks: RemoteTransfer[] = [];
const listeners = new Set<() => void>();
export const transferSnapshot = () => tasks;
export const subscribeTransfers = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function change(id: string, value: Partial<RemoteTransfer>) {
  tasks = tasks.map((task) => (task.id === id ? { ...task, ...value } : task));
  listeners.forEach((listener) => listener());
}
export function dismissTransfer(id: string) {
  tasks = tasks.filter((task) => task.id !== id || task.state === "running");
  listeners.forEach((listener) => listener());
}
export async function startRemoteTransfer(
  root: RemoteRoot,
  path: string,
  direction: "upload" | "download",
  overwrite: boolean,
): Promise<boolean> {
  const id = crypto.randomUUID();
  tasks = [
    ...tasks,
    { id, direction, name: path || root.path, completed: 0, total: 0, state: "running" },
  ];
  listeners.forEach((listener) => listener());
  const events = new Channel<Pick<RemoteTransfer, "id" | "name" | "completed" | "total">>();
  let pending: Pick<RemoteTransfer, "id" | "name" | "completed" | "total"> | null = null;
  let lastProgressAt = -Infinity;
  const flushProgress = () => {
    if (!pending) return;
    change(id, { name: pending.name, completed: pending.completed, total: pending.total });
    pending = null;
  };
  events.onmessage = (progress) => {
    if (progress.id !== id) return;
    pending = progress;
    // Bound UI updates while retaining the final byte count. 限制界面更新频率，同时保留最终字节数。
    const now = Date.now();
    if (now - lastProgressAt >= 100) {
      lastProgressAt = now;
      flushProgress();
    }
  };
  try {
    await invoke("ssh_transfer", { root, path, direction, id, overwrite, events });
    flushProgress();
    change(id, { state: "done" });
    return true;
  } catch (error) {
    flushProgress();
    change(id, {
      state: String(error).includes("SSH_TRANSFER_CANCELLED") ? "cancelled" : "error",
      error: sshError(error),
    });
    return false;
  }
}
