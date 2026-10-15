import test from "node:test";
import assert from "node:assert/strict";
import {
  interfaceThemes,
  interfacePalette,
  isLightInterfaceTheme,
} from "../src/lib/interface-themes.ts";
import { defaults, readSettings } from "../src/lib/settings.ts";
import { translate } from "../src/lib/i18n.ts";

test("all six interface themes persist independently of terminal preferences", () => {
  assert.equal(interfaceThemes.length, 6);
  assert.equal(new Set(interfaceThemes.map((theme) => theme.id)).size, 6);
  for (const theme of interfaceThemes) {
    const settings = { ...defaults, interfaceTheme: theme.id, fontSize: 19 };
    assert.deepEqual(readSettings(JSON.stringify(settings)), settings);
    assert.notEqual(translate("en", theme.name), theme.name);
    assert.notEqual(translate("en", theme.description), theme.description);
  }
});
test("new and absent settings use Black in dark mode; invalid choices are rejected", () => {
  assert.equal(readSettings(null).interfaceTheme, "black");
  assert.equal(readSettings(null).appearance, "dark");
  const settings = { ...defaults, fontSize: 19 };
  delete settings.interfaceTheme;
  assert.equal(readSettings(JSON.stringify(settings)).interfaceTheme, "black");
  assert.equal(readSettings(JSON.stringify(settings)).fontSize, 19);
  for (const interfaceTheme of ["unknown", null, 42, {}])
    assert.throws(() => readSettings(JSON.stringify({ ...defaults, interfaceTheme })));
});
function luminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((part) => parseInt(part, 16) / 255)
    .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
test("all palettes have complete tokens and readable normal text", () => {
  for (const theme of interfaceThemes)
    for (const light of [true, false]) {
      const palette = interfacePalette(theme.id, light);
      assert.deepEqual(Object.keys(palette).sort(), Object.keys(interfaceThemes[0].dark).sort());
      for (const color of Object.values(palette)) assert.match(color, /^#[0-9a-f]{6}$/);
      for (const foreground of ["text", "muted", "accent"])
        for (const background of ["canvas", "sidebar", "surface"]) {
          const a = luminance(palette[foreground]),
            b = luminance(palette[background]);
          assert.ok(
            (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5,
            `${theme.id} ${light} ${foreground}/${background}`,
          );
        }
    }
});

test("Paper and Clear Sky stay light without changing terminal appearance preferences", () => {
  for (const id of ["paper", "sky"]) {
    assert.equal(isLightInterfaceTheme(id, false), true);
    assert.deepEqual(interfacePalette(id, false), interfacePalette(id, true));
    assert.equal(
      readSettings(JSON.stringify({ ...defaults, interfaceTheme: id })).appearance,
      "dark",
    );
  }
  assert.equal(isLightInterfaceTheme("black", false), false);
});
