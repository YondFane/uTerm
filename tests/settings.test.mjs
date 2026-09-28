import test from "node:test";
import assert from "node:assert/strict";
import {
  availableAgents,
  defaults,
  readSettings,
  binding,
  chord,
  validateShortcuts,
  sessionFromLink,
  sessionLink,
} from "../src/lib/settings.ts";
test("settings round trip and invalid data is rejected without normalizing it away", () => {
  assert.deepEqual(readSettings(JSON.stringify(defaults)), defaults);
  for (const patch of [
    { version: 2 },
    { fontSize: 999 },
    { scrollback: -1 },
    { cursorStyle: "triangle" },
    { fontThicken: "yes" },
    { usageRemote: "yes" },
    { language: "de" },
    { shortcuts: { unknown: "" } },
  ])
    assert.throws(() => readSettings(JSON.stringify({ ...defaults, ...patch })));
});
test("platform shortcuts avoid project and terminal search collisions", () => {
  for (const mac of [true, false]) {
    validateShortcuts(defaults, mac);
    assert.notEqual(binding(defaults, "search", mac), binding(defaults, "terminalSearch", mac));
  }
  assert.equal(
    chord({ metaKey: false, ctrlKey: true, shiftKey: true, altKey: false, code: "KeyP" }, false),
    "Mod+Shift+KeyP",
  );
  assert.equal(
    chord({ metaKey: true, ctrlKey: true, shiftKey: true, altKey: false, code: "KeyP" }, true),
    "",
  );
  assert.equal(binding({ ...defaults, shortcuts: { palette: "" } }, "palette", true), "");
});
test("sidebar shortcuts support platform modifiers, customization and disabling", () => {
  for (const mac of [true, false]) {
    assert.equal(binding(defaults, "toggleSidebar", mac), "Mod+KeyB");
    assert.equal(binding(defaults, "toggleInspector", mac), "Mod+Alt+KeyB");
    validateShortcuts(defaults, mac);
    const settings = readSettings(
      JSON.stringify({
        ...defaults,
        shortcuts: { toggleSidebar: "", toggleInspector: "Mod+Shift+KeyB" },
      }),
    );
    assert.equal(binding(settings, "toggleSidebar", mac), "");
    assert.equal(binding(settings, "toggleInspector", mac), "Mod+Shift+KeyB");
    validateShortcuts(settings, mac);
  }
});
test("rebindings reject collisions and reserved editing keys", () => {
  assert.throws(() =>
    validateShortcuts({ ...defaults, shortcuts: { settings: "Mod+KeyP" } }, true),
  );
  assert.throws(() =>
    validateShortcuts({ ...defaults, shortcuts: { settings: "Mod+KeyC" } }, true),
  );
  validateShortcuts({ ...defaults, shortcuts: { settings: "Mod+Alt+Comma" } }, false);
});
test("session links cannot carry terminal commands or paths", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  assert.equal(sessionFromLink(sessionLink(id)), id);
  assert.equal(sessionFromLink(`uterm://session/${id}`), id);
  for (const value of [
    `uterm://session/${id}?cmd=whoami`,
    `uterm://session/${id}#test`,
    "uterm://new/session",
    "https://session/id",
  ])
    assert.throws(() => sessionFromLink(value));
});

test("incomplete settings are rejected and unknown fields are not retained", () => {
  const incomplete = { ...defaults };
  delete incomplete.opacity;
  assert.throws(() => readSettings(JSON.stringify(incomplete)));
  assert.throws(() => readSettings("{}"));
  const settings = readSettings(JSON.stringify({ ...defaults, extra: "unrecognized" }));
  assert.deepEqual(settings, defaults);
});
import { importTheme } from "../src/lib/themes.ts";
test("Ghostty theme import only accepts colors and valid palette indices", () => {
  const theme = importTheme(
    "background = 123456\nforeground = #abcdef\npalette = 3=#876543\ncommand = malicious",
    "Example",
  );
  assert.equal(theme.background, "#123456");
  assert.equal(theme.yellow, "#876543");
  assert.equal(theme.command, undefined);
  assert.equal(
    readSettings(JSON.stringify({ ...defaults, customThemes: [theme], darkTheme: theme.id }))
      .darkTheme,
    theme.id,
  );
  for (const source of [
    "background = url(https://example.com)",
    "palette=16=#123456",
    "command = shell",
  ])
    assert.throws(() => importTheme(source, "Invalid"));
});

test("inspector position defaults for old settings and supports persistent swapping and shortcuts", () => {
  const old = { ...defaults };
  delete old.inspectorPosition;
  assert.equal(readSettings(JSON.stringify(old)).inspectorPosition, "right");
  for (const inspectorPosition of ["left", "right"]) {
    const settings = readSettings(JSON.stringify({ ...defaults, inspectorPosition }));
    assert.equal(readSettings(JSON.stringify(settings)).inspectorPosition, inspectorPosition);
  }
  for (const inspectorPosition of [null, true, "center", 0])
    assert.throws(() => readSettings(JSON.stringify({ ...defaults, inspectorPosition })));
  assert.equal(binding(defaults, "swapPanes", true), "");
  for (const mac of [true, false]) {
    const custom = { ...defaults, shortcuts: { swapPanes: "Mod+Alt+KeyS" } };
    validateShortcuts(custom, mac);
    assert.equal(binding(readSettings(JSON.stringify(custom)), "swapPanes", mac), "Mod+Alt+KeyS");
  }
});

test("agents require explicit enablement and invalid saved selections are rejected", () => {
  const old = { ...defaults };
  delete old.enabledAgents;
  assert.deepEqual(readSettings(JSON.stringify(old)).enabledAgents, []);
  assert.deepEqual(availableAgents(readSettings(null), ["claude", "codex"]), []);
  const settings = readSettings(
    JSON.stringify({ ...defaults, enabledAgents: ["codex", "custom-agent"] }),
  );
  assert.deepEqual(readSettings(JSON.stringify(settings)).enabledAgents, ["codex", "custom-agent"]);
  assert.deepEqual(availableAgents(settings, ["claude", "codex", "custom-agent"]), [
    "codex",
    "custom-agent",
  ]);
  assert.deepEqual(availableAgents(settings, ["claude"]), []);
  for (const enabledAgents of [
    null,
    true,
    "codex",
    ["codex", "codex"],
    [42],
    ["../program"],
    [""],
  ]) {
    assert.throws(() => readSettings(JSON.stringify({ ...defaults, enabledAgents })));
  }
});
