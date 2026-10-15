import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createReadStream, readFileSync, readdirSync } from "node:fs";

const pdfRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
// Keep paths rather than resident buffers; PDF resources are read only when needed.
// 仅保存路径而非驻留缓冲区，PDF 资源在需要时才读取。
const pdfAssets = new Map<string, string>();
for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
  for (const name of readdirSync(join(pdfRoot, directory))) {
    if (/\.(bcmap|pfb|ttf|wasm|js)$/.test(name) || name.startsWith("LICENSE"))
      pdfAssets.set(`pdf-assets/${directory}/${name}`, join(pdfRoot, directory, name));
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "local-pdf-assets",
      generateBundle() {
        for (const [fileName, path] of pdfAssets)
          this.emitFile({ type: "asset", fileName, source: readFileSync(path) });
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = (request.url ?? "").split("?")[0].replace(/^\//, "");
          const file = pdfAssets.get(path);
          if (!file) return next();
          response.setHeader(
            "Content-Type",
            path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
          );
          const stream = createReadStream(file);
          stream.on("error", next);
          response.on("close", () => stream.destroy());
          stream.pipe(response);
        });
      },
    },
  ],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**"] },
  },
  build: { target: "es2022" },
});
