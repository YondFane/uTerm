import { createServer as createViteServer } from "vite";

export function createServer(options = {}) {
  return createViteServer({
    ...options,
    server: {
      ...options.server,
      // Snapshot render tests need neither Cargo file watchers nor shared WebSocket ports.
      // 快照渲染测试不需要监听 Cargo 文件，也不需要共享的 WebSocket 端口。
      middlewareMode: true,
      hmr: false,
      ws: false,
      watch: null,
    },
  });
}
