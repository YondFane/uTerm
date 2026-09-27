import test from "node:test";
import assert from "node:assert/strict";
import { checkSource, checkSources } from "../scripts/i18n-check.mjs";
import {
  englishMessages,
  translate,
  tx,
  localizeMessage,
  setUiLanguage,
  getUiLanguage,
  subscribeLanguage,
  missingTranslations,
} from "../src/lib/i18n.ts";
import { editorPhrases } from "../src/lib/editor-i18n.ts";
import { isStaleWorkingDiffError } from "../src/lib/git-diff.ts";

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
test("every registered message has matching parameters and a non-Chinese English value", () => {
  assert.ok(Object.keys(englishMessages).length > 500);
  for (const [key, value] of Object.entries(englishMessages)) {
    assert.ok(value.trim(), key);
    assert.doesNotMatch(value, /\p{Script=Han}/u, key);
    assert.deepEqual(placeholders(value), placeholders(key), key);
    assert.equal((value.match(/\$/g) ?? []).length, (key.match(/\$/g) ?? []).length, key);
    const params = Object.fromEntries(placeholders(key).map((p) => [p, "sample"]));
    assert.doesNotMatch(translate("en", key, params), /\p{Script=Han}/u, key);
    assert.equal(translate("zh-Hans", key, params), key.replace(/\{\w+\}/g, "sample"));
  }
});
test("all source UI literals and backend messages pass the coverage gate", () => {
  assert.deepEqual(checkSources(), []);
});
test("the coverage gate rejects raw JSX, attributes, missing keys and invalid parameters", () => {
  for (const code of [
    "const X = () => <button>遗漏按钮</button>;",
    "const X = () => <button>Forgotten button</button>;",
    'const X = () => <button title="Forgotten hint" />;',
    'const X = () => tx("missing-key");',
    'const X = () => tx(tx("保存"));',
    'const X = () => tx("移至 {p0}", {wrong: "folder"});',
    "const X = () => `未翻译 ${name}`;",
  ])
    assert.ok(checkSource("src/components/Fixture.tsx", code).length, code);
  assert.deepEqual(
    checkSource("src/components/Fixture.tsx", 'const X = () => <button>{tx("保存")}</button>;'),
    [],
  );
});
test("missing translations report diagnostics instead of silently returning Chinese", () => {
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    for (const language of ["en", "zh-Hans"])
      assert.equal(translate(language, "未登记测试词"), "[Missing translation]");
    assert.ok(missingTranslations.has("未登记测试词"));
    assert.equal(logs.length, 1);
    assert.throws(() => translate("en", "移至 {p0}"), /parameter/);
  } finally {
    console.error = original;
    missingTranslations.clear();
  }
});
test("language subscriptions switch both ways without replacing user data", () => {
  let calls = 0;
  const unsubscribe = subscribeLanguage(() => calls++);
  try {
    setUiLanguage("en");
    assert.equal(tx("保存"), "Save");
    assert.equal(tx("移至 {p0}", { p0: "中文项目 {p0}" }), "Move to 中文项目 {p0}");
    assert.equal(localizeMessage("D:\\中文项目\\文件.txt"), "D:\\中文项目\\文件.txt");
    assert.equal(
      localizeMessage("Unknown vendor error: 中文内容"),
      "Unknown vendor error: 中文内容",
    );
    assert.equal(
      localizeMessage("无法创建 Worktree：找不到用户目录。"),
      "Could not create worktree: User directory not found.",
    );
    assert.ok(isStaleWorkingDiffError("文件已变化，请刷新列表。"));
    setUiLanguage("zh-Hans");
    assert.equal(localizeMessage("User directory not found."), "找不到用户目录。");
    assert.equal(tx("保存"), "保存");
    assert.equal(calls, 2);
  } finally {
    unsubscribe();
    setUiLanguage("zh-Hans");
  }
});
test("editor built-in phrases follow the active language and retain substitution tokens", () => {
  try {
    setUiLanguage("en");
    assert.equal(editorPhrases().Find, "Find");
    assert.equal(editorPhrases()["replaced $ matches"], "replaced $ matches");
    setUiLanguage("zh-Hans");
    assert.equal(editorPhrases().Find, "查找");
    assert.equal(editorPhrases()["replaced $ matches"], "已替换 $ 处匹配");
    assert.equal(getUiLanguage(), "zh-Hans");
  } finally {
    setUiLanguage("zh-Hans");
  }
});
