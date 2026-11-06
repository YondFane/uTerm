import { readFileSync, writeFileSync } from "node:fs";
import { commands, defaults } from "../src/lib/settings.ts";
import { translate } from "../src/lib/i18n.ts";
import { themes } from "../src/lib/themes.ts";
import { interfaceThemes } from "../src/lib/interface-themes.ts";

const labels = (key) => ({
  en: /\p{Script=Han}/u.test(key) ? translate("en", key) : key,
  "zh-Hans": key,
});
const catalog = {
  version: 1,
  settingsKeys: [...new Set([...Object.keys(defaults), "agentNotifications"])],
  commands: commands.map(([id, title, defaultShortcut]) => ({
    id,
    labels: labels(title),
    defaultShortcut,
  })),
  themes: themes.map((theme) => ({ ...theme, labels: labels(theme.name) })),
  interfaceThemes: interfaceThemes.map((theme) => ({
    ...theme,
    labels: labels(theme.name),
    descriptions: labels(theme.description),
  })),
};
const expected = JSON.stringify(catalog, null, 2) + "\n";
const path = "shared/contracts/settings-ui-v1.json";
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== expected) {
    throw Error("Native settings catalog is stale. Run pnpm settings:generate.");
  }
} else writeFileSync(path, expected);
