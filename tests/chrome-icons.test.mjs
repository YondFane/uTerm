import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "./vite-server.mjs";

const contract = JSON.parse(
  readFileSync(new URL("../shared/contracts/chrome-ui-v1.json", import.meta.url)),
);

test("ordinary SVG controls render the shared native paths without changing their stroke geometry", async () => {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  try {
    const { SidebarIcon, ToolbarIcon } = await server.ssrLoadModule(
      "/src/components/SidebarIcon.tsx",
    );
    for (const [group, Component] of [
      ["sidebar", SidebarIcon],
      ["toolbar", ToolbarIcon],
    ]) {
      for (const [name, path] of Object.entries(contract.icons[group])) {
        if (group === "toolbar" && ["python", "close"].includes(name)) continue;
        const html = renderToStaticMarkup(React.createElement(Component, { name }));
        assert.ok(html.includes(`d="${path}"`), `${group}.${name} no longer uses the shared path`);
        assert.match(html, /viewBox="0 0 24 24"/);
        assert.match(html, /stroke-width="2"/);
        assert.match(html, /stroke-linecap="round"/);
        assert.match(html, /stroke-linejoin="round"/);
      }
    }
  } finally {
    await server.close();
  }
});
