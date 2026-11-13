import test from "node:test";
import assert from "node:assert/strict";
import { settingsSections, matchesSettingsSection } from "../src/lib/settings-search.ts";
import { translate } from "../src/lib/i18n.ts";

const find = (query) =>
  settingsSections
    .filter((section) => matchesSettingsSection(section, query, translate("en", section.label)))
    .map((section) => section.id);
test("settings navigation search shares bilingual field aliases without modifying its catalog", () => {
  const before = JSON.stringify(settingsSections);
  assert.deepEqual(find("　ｊｄｋ　注册　"), ["java"]);
  assert.deepEqual(find("maven proxy"), ["maven"]);
  assert.deepEqual(find("自动 更新"), ["updates"]);
  assert.deepEqual(find("fontSize"), ["appearance"]);
  assert.deepEqual(find("fileTabLimit"), ["general"]);
  assert.deepEqual(find("defaultShell"), ["workspace"]);
  assert.ok(find("theme").includes("appearance"));
  assert.deepEqual(find("nonexistent-unique-query"), []);
  assert.equal(find("").length, 12);
  assert.equal(JSON.stringify(settingsSections), before);
});
