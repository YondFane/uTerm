import test from "node:test";
import assert from "node:assert/strict";
import { resolveLanguage, translate } from "../src/lib/i18n.ts";
import { defaults, readSettings } from "../src/lib/settings.ts";

test("system language resolves Chinese and falls back to English", () => {
  assert.equal(resolveLanguage(["zh-CN"]), "zh-Hans");
  assert.equal(resolveLanguage(["zh-HK"]), "zh-Hans");
  assert.equal(resolveLanguage(["ja-JP"]), "en");
  assert.equal(resolveLanguage(["ko-KR"]), "en");
  assert.equal(resolveLanguage(["fr-CA"]), "en");
  assert.equal(resolveLanguage(["de-DE"]), "en");
  assert.equal(resolveLanguage(["de-DE", "zh-CN"]), "zh-Hans");
});

test("Simplified Chinese keeps the source text instead of falling back to English", () => {
  assert.equal(translate("zh-Hans", "设置"), "设置");
  assert.equal(translate("zh-Hans", "应用语言"), "应用语言");
  assert.equal(translate("en", "设置"), "Settings");
});

test("unsupported language preferences are rejected", () => {
  assert.throws(() => readSettings(JSON.stringify({ ...defaults, language: "ja" })));
});

test("workspace welcome actions and descriptions have English translations", () => {
  for (const text of [
    "开始工作",
    "专注于下一行。",
    "项目、终端与 Agent，在一个工作空间中。",
    "打开项目",
    "新建终端",
    "新建聊天",
    "选择目录，开始你的工作。",
    "在当前项目中启动 Shell。",
    "与本地 Agent 一起处理任务。",
    "无需项目，直接打开 Shell。",
    "本地运行 · 自由掌控",
    "所有命令",
  ]) {
    assert.notEqual(translate("en", text), text);
    assert.equal(translate("zh-Hans", text), text);
  }
});
