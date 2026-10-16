import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const assets = new Map([
  ["", ["index.html", "text/html; charset=utf-8"]],
  ["index.html", ["index.html", "text/html; charset=utf-8"]],
  ["style.css", ["style.css", "text/css; charset=utf-8"]],
  ["site.js", ["site.js", "text/javascript; charset=utf-8"]],
  ["icon.svg", ["icon.svg", "image/svg+xml"]],
]);
const port = Number(process.env.UTERM_SITE_PORT ?? 1431);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("UTERM_SITE_PORT must be a port between 1 and 65535.");
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/" || url.pathname === "/uTerm") {
    response.writeHead(302, { Location: `/uTerm/${url.search}` });
    response.end();
    return;
  }
  const asset = url.pathname.startsWith("/uTerm/")
    ? assets.get(url.pathname.slice("/uTerm/".length))
    : undefined;
  if (!asset || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  try {
    const body = await readFile(new URL(`../site/${asset[0]}`, import.meta.url));
    response.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    console.error(error);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Unable to read website asset");
  }
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`uTerm website: http://127.0.0.1:${port}/uTerm/?lang=zh-CN`);
});
