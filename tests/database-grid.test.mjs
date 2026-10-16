import test from "node:test";
import assert from "node:assert/strict";
import { databaseObjects, databaseSelect, databaseClipboard } from "../src/lib/database.ts";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";

test("database metadata retains namespaces and quotes names without interpolating SQL", () => {
  const objects = databaseObjects({
    columns: [
      { name: "TABLE_NAME" },
      { name: "TABLE_CAT" },
      { name: "TABLE_SCHEM" },
      { name: "TABLE_TYPE" },
    ],
    rows: [['student`"', "db`test", 'schema"test', "TABLE"]],
  });
  assert.equal(objects[0].catalog, "db`test");
  assert.equal(databaseSelect("mysql", objects[0]), 'SELECT * FROM `db``test`.`student``"`');
  assert.equal(databaseSelect("oracle", objects[0]), 'SELECT * FROM "schema""test"."student`"""');
  assert.equal(databaseSelect("postgresql", objects[0]), databaseSelect("oracle", objects[0]));
});

test("copying result ranges preserves NULL, empty cells, binary and TSV escaping", () => {
  const result = {
    columns: [{ name: "id" }, { name: "value" }, { name: "binary" }],
    rows: [
      ["1", null, { binary: "AA==", truncated: true }],
      ["2", "", { binary: "AB==", truncated: false }],
      ["3", 'a\tb\n"quoted"', "last"],
    ],
  };
  assert.equal(databaseClipboard(result, [0, 0, 1, 1], true), "id\tvalue\n1\tNULL\n2\t");
  assert.equal(databaseClipboard(result, [2, 1, 2, 1]), '"a\tb\n""quoted"""');
  assert.equal(databaseClipboard(result, [0, 2, 0, 2]), "AA== …");
});

test("grid supports keyboard range copying, row selection, resizing and literal value inspection", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const copies = [];
  let fail = false;
  Object.defineProperty(navigator, "clipboard", {
    value: {
      async writeText(value) {
        if (fail) throw new Error("denied");
        copies.push(value);
      },
    },
    configurable: true,
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { DatabaseGrid } = await server.ssrLoadModule("/src/components/DatabaseGrid.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const errors = [];
  const result = {
    columns: [
      { name: "id", type: "INTEGER" },
      { name: "value", type: "VARCHAR" },
    ],
    rows: [
      ["1", null],
      ["2", '<script>alert("x")</script>'],
      ["3", ""],
    ],
  };
  const click = (text) =>
    act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === text)
        .click(),
    );
  try {
    await act(async () =>
      root.render(
        React.createElement(DatabaseGrid, { result, report: (message) => errors.push(message) }),
      ),
    );
    const grid = document.querySelector(".database-results");
    await act(async () =>
      document
        .querySelector('[data-cell="0:0"]')
        .dispatchEvent(
          new window.MouseEvent("pointerdown", { bubbles: true, buttons: 1, button: 0 }),
        ),
    );
    for (const key of ["ArrowDown", "ArrowRight"])
      await act(async () =>
        grid.dispatchEvent(
          new window.KeyboardEvent("keydown", { key, shiftKey: true, bubbles: true }),
        ),
      );
    await click("Copy with headers");
    assert.equal(copies.at(-1), 'id\tvalue\n1\tNULL\n2\t"<script>alert(""x"")</script>"');
    const separator = document.querySelector('[role="separator"]');
    await act(async () =>
      separator.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    assert.equal(separator.getAttribute("aria-valuenow"), "180");
    separator.setPointerCapture = () => {};
    separator.hasPointerCapture = () => true;
    await act(async () => {
      separator.dispatchEvent(
        new window.MouseEvent("pointerdown", { clientX: 180, bubbles: true }),
      );
      separator.dispatchEvent(
        new window.MouseEvent("pointermove", { clientX: 230, bubbles: true }),
      );
    });
    assert.equal(separator.getAttribute("aria-valuenow"), "230");
    assert.equal(document.activeElement, separator);
    await act(async () =>
      document
        .querySelector('[data-cell="1:1"]')
        .dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })),
    );
    assert.equal(document.querySelector("dialog").open, true);
    assert.equal(document.querySelector("dialog pre").textContent, '<script>alert("x")</script>');
    assert.equal(document.querySelector("script"), null);
    await click("Close");
    await act(async () => document.querySelector('button[aria-label="Select row 3"]').click());
    await click("Copy selection");
    assert.equal(copies.at(-1), "3\t");
    fail = true;
    await click("Copy selection");
    assert.match(errors.at(-1), /Could not copy/);
    await act(async () =>
      root.render(
        React.createElement(DatabaseGrid, { result: { columns: [], rows: [] }, report: () => {} }),
      ),
    );
    assert.equal(document.querySelector('[data-selected="true"]'), null);
    const wide = {
      columns: Array.from({ length: 256 }, (_, at) => ({ name: `column_${at}`, type: "VARCHAR" })),
      rows: Array.from({ length: 200 }, (_, row) =>
        Array.from({ length: 256 }, (_, col) => `${row}:${col}`),
      ),
    };
    await act(async () =>
      root.render(React.createElement(DatabaseGrid, { result: wide, report: () => {} })),
    );
    assert.ok(
      document.querySelectorAll("td[data-cell]").length < 500,
      "Only visible rows and columns should render",
    );
    await act(async () =>
      document
        .querySelector('[data-cell="0:0"]')
        .dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0 })),
    );
    for (let at = 0; at < 30; at++)
      await act(async () =>
        grid.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        ),
      );
    assert.equal(document.querySelector('[data-cell="0:30"]').textContent, "0:30");
    assert.ok(document.querySelectorAll("td[data-cell]").length < 500);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
