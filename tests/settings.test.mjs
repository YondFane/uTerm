import test from "node:test";
import assert from "node:assert/strict";
import {
  availableAgents,
  defaults,
  readSettings,
  binding,
  chord,
  shortcutCommand,
  shortcutLabel,
  validateShortcuts,
  sessionFromLink,
  sessionLink,
} from "../src/lib/settings.ts";
test("font shortcuts accept plus and equals, respect platform modifiers and custom bindings", () => {
  const key = (code, patch = {}) => ({
    code,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...patch,
  });
  assert.equal(shortcutCommand(defaults, key("Minus"), false), "fontDecrease");
  assert.equal(shortcutCommand(defaults, key("Equal"), false), "fontIncrease");
  assert.equal(shortcutCommand(defaults, key("Equal", { shiftKey: true }), false), "fontIncrease");
  assert.equal(shortcutCommand(defaults, key("Equal", { altKey: true }), false), undefined);
  assert.equal(shortcutCommand(defaults, key("Equal"), true), undefined);
  assert.equal(
    shortcutCommand(defaults, key("Equal", { ctrlKey: false, metaKey: true }), true),
    "fontIncrease",
  );
  const custom = {
    ...defaults,
    shortcuts: { fontIncrease: "Mod+Alt+KeyI", palette: "Mod+Shift+Equal" },
  };
  assert.equal(shortcutCommand(custom, key("Equal", { shiftKey: true }), false), "palette");
  assert.equal(shortcutCommand(custom, key("Equal"), false), undefined);
  assert.equal(shortcutCommand(custom, key("KeyI", { altKey: true }), false), "fontIncrease");
  const older = { ...defaults, shortcuts: { palette: "Mod+Minus" } };
  assert.equal(binding(older, "fontDecrease", false), "");
  assert.doesNotThrow(() => validateShortcuts(older, false));
  assert.equal(shortcutCommand(older, key("Minus"), false), "palette");
  assert.equal(shortcutLabel("Mod+Minus", false), "Ctrl+-");
  assert.equal(shortcutLabel("Mod+Equal", true), "⌘++");
});
test("settings round trip and invalid data is rejected without normalizing it away", () => {
  assert.deepEqual(readSettings(JSON.stringify(defaults)), defaults);
  for (const patch of [
    { version: 2 },
    { automaticUpdates: "yes" },
    { fileTabLimit: 0 },
    { fileTabLimit: 1.5 },
    { fileTabLimit: "10" },
    { fontSize: 999 },
    { scrollback: -1 },
    { cursorStyle: "triangle" },
    { fontThicken: "yes" },
    { usageRemote: "yes" },
    { usageRefreshInterval: 9 },
    { usageRefreshInterval: 3601 },
    { usageRefreshInterval: 10.5 },
    { language: "de" },
    { shortcuts: { unknown: "" } },
  ])
    assert.throws(() => readSettings(JSON.stringify({ ...defaults, ...patch })));
});
test("connection sections default visible for old settings and preserve independent choices", () => {
  const { showSshConnections, showRedisConnections, ...old } = defaults;
  const migrated = readSettings(JSON.stringify(old));
  assert.equal(migrated.showSshConnections, true);
  assert.equal(migrated.showRedisConnections, true);
  for (const ssh of [false, true]) {
    for (const redis of [false, true]) {
      const settings = readSettings(
        JSON.stringify({ ...defaults, showSshConnections: ssh, showRedisConnections: redis }),
      );
      assert.equal(settings.showSshConnections, ssh);
      assert.equal(settings.showRedisConnections, redis);
    }
  }
  for (const key of ["showSshConnections", "showRedisConnections"])
    for (const value of [null, 0, 1, "false", []])
      assert.throws(() => readSettings(JSON.stringify({ ...defaults, [key]: value })));
});
test("active icon colors default to the theme and reject invalid saved colors", () => {
  const { activeIconColor, ...old } = defaults;
  assert.equal(readSettings(null).activeIconColor, "");
  assert.equal(readSettings(JSON.stringify(old)).activeIconColor, "");
  for (const color of ["", "#62d98a", "#AABBCC", "#000000", "#ffffff"]) {
    const saved = readSettings(JSON.stringify({ ...defaults, activeIconColor: color }));
    assert.equal(readSettings(JSON.stringify(saved)).activeIconColor, color);
  }
  for (const color of [
    null,
    false,
    123,
    [],
    "red",
    "#abc",
    "#gg1234",
    "#12345678",
    "var(--ui-text)",
  ])
    assert.throws(() => readSettings(JSON.stringify({ ...defaults, activeIconColor: color })));
});
test("sidebar styles default to navigation for old settings and persist valid choices", () => {
  const { sidebarStyle, ...old } = defaults;
  assert.equal(readSettings(null).sidebarStyle, "navigation");
  assert.equal(readSettings(JSON.stringify(old)).sidebarStyle, "navigation");
  for (const style of ["classic", "navigation"]) {
    const saved = readSettings(JSON.stringify({ ...defaults, sidebarStyle: style }));
    assert.equal(readSettings(JSON.stringify(saved)).sidebarStyle, style);
  }
  for (const style of [null, false, 0, "", "compact", [], {}])
    assert.throws(() => readSettings(JSON.stringify({ ...defaults, sidebarStyle: style })));
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
test("workspace shortcuts use platform modifiers and preserve existing custom bindings", () => {
  for (const mac of [true, false]) {
    for (const [id, code] of [
      ["nextWorkspace", "BracketRight"],
      ["previousWorkspace", "BracketLeft"],
    ]) {
      const event = { metaKey: mac, ctrlKey: !mac, altKey: true, shiftKey: false, code };
      assert.equal(binding(defaults, id, mac), `Mod+Alt+${code}`);
      assert.equal(shortcutCommand(defaults, event, mac), id);
      const disabled = readSettings(JSON.stringify({ ...defaults, shortcuts: { [id]: "" } }));
      assert.equal(shortcutCommand(disabled, event, mac), undefined);
      const existing = { ...defaults, shortcuts: { agents: `Mod+Alt+${code}` } };
      assert.equal(binding(existing, id, mac), "");
      assert.equal(shortcutCommand(existing, event, mac), "agents");
      validateShortcuts(existing, mac);
      const custom = readSettings(
        JSON.stringify({ ...defaults, shortcuts: { [id]: "Mod+Shift+Digit9" } }),
      );
      assert.equal(binding(custom, id, mac), "Mod+Shift+Digit9");
      validateShortcuts(custom, mac);
    }
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

test("usage refresh interval defaults for old settings and accepts whole seconds", () => {
  const old = { ...defaults };
  delete old.usageRefreshInterval;
  assert.equal(readSettings(JSON.stringify(old)).usageRefreshInterval, 60);
  for (const usageRefreshInterval of [10, 30, 60, 3600])
    assert.equal(
      readSettings(JSON.stringify({ ...defaults, usageRefreshInterval })).usageRefreshInterval,
      usageRefreshInterval,
    );
});

test("file tab limit defaults for old settings and accepts a minimum of one", () => {
  const { fileTabLimit, ...old } = defaults;
  assert.equal(readSettings(JSON.stringify(old)).fileTabLimit, 10);
  assert.equal(readSettings(JSON.stringify({ ...defaults, fileTabLimit: 1 })).fileTabLimit, 1);
});

test("automatic updates are opt-in and compatible with previous settings", () => {
  const { automaticUpdates, ...old } = defaults;
  assert.equal(readSettings(JSON.stringify(old)).automaticUpdates, false);
  assert.equal(
    readSettings(JSON.stringify({ ...defaults, automaticUpdates: true })).automaticUpdates,
    true,
  );
});

test("file and diff font sizes upgrade old settings and validate independently", () => {
  const old = { ...defaults };
  delete old.fileFontSize;
  delete old.gitDiffFontSize;
  assert.deepEqual(readSettings(JSON.stringify(old)), defaults);
  for (const key of ["fileFontSize", "gitDiffFontSize"]) {
    for (const value of [10, 14, 20, 32]) {
      const settings = readSettings(JSON.stringify({ ...defaults, [key]: value }));
      assert.equal(settings[key], value);
      assert.equal(settings[key === "fileFontSize" ? "gitDiffFontSize" : "fileFontSize"], 14);
      assert.equal(settings.fontSize, defaults.fontSize);
      assert.equal(settings.interfaceSize, defaults.interfaceSize);
    }
    for (const value of [9, 33, 14.5, "20", null])
      assert.throws(() => readSettings(JSON.stringify({ ...defaults, [key]: value })));
  }
});
