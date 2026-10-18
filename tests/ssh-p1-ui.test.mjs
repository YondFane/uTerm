import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act, useState } from "react";

test("forwarding rules require explicit start, retain failures and protect active rules", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { SshTunnels } = await server.ssrLoadModule("/src/components/SshTunnels.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  let starts = 0,
    stops = 0,
    saved = [],
    allowSave = true;
  function Harness() {
    const [rules, setRules] = useState([]);
    const [statuses, setStatuses] = useState([]);
    return React.createElement(SshTunnels, {
      rules,
      statuses,
      save(value) {
        if (!allowSave) return false;
        saved = value;
        setRules(value);
        return true;
      },
      async start(rule) {
        starts++;
        if (starts === 1) throw new Error("SSH_FORWARD_PORT_BUSY");
        setStatuses([{ id: rule.id, state: "running" }]);
      },
      async stop() {
        stops++;
        setStatuses([]);
      },
    });
  }
  const change = async (element, value) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
        element,
        value,
      );
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  const submit = async () =>
    act(async () =>
      document
        .querySelector("form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
  const button = (label) =>
    [...document.querySelectorAll("button")].find((item) => item.textContent === label);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const ports = document.querySelectorAll('input[type="number"]');
    await change(ports[0], "18080");
    await change(ports[1], "80");
    allowSave = false;
    await submit();
    assert.match(document.querySelector('[role="alert"]').textContent, /Could not save/);
    assert.equal(starts, 0);
    allowSave = true;
    await submit();
    assert.equal(saved.length, 1);
    assert.equal(starts, 0);
    await act(async () => button("Start forwarding").click());
    assert.match(document.querySelector('[role="alert"]').textContent, /Local port is in use/);
    assert.equal(saved.length, 1);
    await act(async () => button("Start forwarding").click());
    assert.equal(button("Remove forwarding").disabled, true);
    assert.match(document.body.textContent, /Local port listening/);
    await change(ports[0], "18080");
    await change(ports[1], "81");
    await submit();
    assert.equal(saved.length, 1);
    assert.match(document.querySelector('[role="alert"]').textContent, /duplicate local port/);
    await act(async () => button("Stop forwarding").click());
    assert.equal(stops, 1);
    assert.equal(button("Remove forwarding").disabled, false);
    await act(async () => button("Remove forwarding").click());
    assert.equal(saved.length, 0);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
