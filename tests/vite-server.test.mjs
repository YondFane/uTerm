import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "vite";
import { createServer } from "./vite-server.mjs";

test("concurrent SSR servers render without watching Cargo outputs or opening WebSocket ports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uterm-vite-resources-"));
  const servers = [];
  const occupied = createNetServer();
  t.after(async () => {
    await Promise.all(servers.map((server) => server.close()));
    if (occupied.listening) await new Promise((resolve) => occupied.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const target = join(root, "crates/uterm-core/target/debug");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "build-script.exe"), "owned build output");
  await writeFile(join(root, "entry.ts"), "export const value: number = 42;");

  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  const errors = [];
  const logger = createLogger("silent");
  logger.error = (message) => errors.push(message);

  const options = {
    root,
    configFile: false,
    customLogger: logger,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      middlewareMode: true,
      hmr: false,
      watch: {},
      ws: { port: occupied.address().port, host: "127.0.0.1" },
    },
    plugins: [
      {
        name: "owned-test-transform",
        transform(code, id) {
          if (id.endsWith("/entry.ts")) return code.replace("42", "43");
        },
      },
    ],
  };
  await Promise.all(
    [0, 1].map(async () => {
      const server = await createServer(options);
      servers.push(server);
      assert.equal((await server.ssrLoadModule("/entry.ts")).value, 43);
      assert.equal(server.httpServer, null);
      assert.equal(server.config.server.watch, null);
      assert.equal(server.config.server.ws, false);
      assert.deepEqual(server.watcher.getWatched(), {});
      server.watcher.add(target);
      assert.deepEqual(server.watcher.getWatched(), {});
    }),
  );
  await writeFile(join(target, "build-script.pdb"), "changed during parallel compilation");
  assert.equal(occupied.listening, true);
  assert.deepEqual(errors, []);
});
