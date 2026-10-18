import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("file viewer headers omit Windows extended prefixes without changing file identities", async () => {
  const dom = new JSDOM("", { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.matchMedia = () => ({ matches: false });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { FileEditor } = await server.ssrLoadModule("/src/components/FileEditor.tsx");
    const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
    const cases = [
      [
        String.raw`\\?\D:\TRAE_WORKSPACE\GitHub\uTerm`,
        "AGENTS.md",
        String.raw`D:\TRAE_WORKSPACE\GitHub\uTerm\AGENTS.md`,
      ],
      ["//?/D:/资料/项目/", "src/说明.md", String.raw`D:\资料\项目\src\说明.md`],
      [String.raw`\\?\UNC\server\share`, "docs/guide.md", String.raw`\\server\share\docs\guide.md`],
      ["//?/UNC/server/share/", "guide.md", String.raw`\\server\share\guide.md`],
      ["C:/", "guide.md", String.raw`C:\guide.md`],
      ["/home/user/project", "docs/guide.md", "/home/user/project/docs/guide.md"],
    ];
    for (const [directory, path, expected] of cases) {
      const file = {
        id: 1,
        directory,
        path,
        kind: "text",
        text: "# Guide",
        saved: "# Guide",
        version: "1",
        line_ending: "\n",
        bom: false,
        readonly: false,
        jump: 0,
      };
      const original = structuredClone(file);
      const markup = renderToStaticMarkup(
        React.createElement(
          SettingsProvider,
          null,
          React.createElement(FileEditor, { editor: { document: file } }),
        ),
      );
      const result = dom.window.document.createElement("div");
      result.innerHTML = markup;
      assert.equal(result.querySelector(".editor-header small").textContent, expected);
      assert.equal(result.querySelector(".editor-header > div").title, expected);
      assert.equal(
        result.querySelector(".editor-header strong").textContent,
        path.split("/").at(-1),
      );
      assert.deepEqual(file, original);
    }
  } finally {
    await server.close();
    dom.window.close();
  }
});
