---
name: uterm-release
description: Prepare and publish uTerm releases with detailed bilingual change descriptions. Use for uTerm release preparation, tagging, publishing or editing release notes; not for unrelated projects or ordinary code changes.
---

# uTerm 发布

在当前仓库内执行，遵循根目录 `AGENTS.md`。仅在用户明确要求时提交、推送、打标签或修改线上 Release；仅调整 Skill 或编写说明不构成这些操作的授权。

## 发布说明是前置条件

1. 核对远端最新稳定版本、当前分支与工作区。以上一个稳定版本标签到目标发布提交的真实差异为依据；将计划纳入本次提交的未提交改动一起审阅。排除更新通道标签、预发布版本以及未包含在目标提交中的改动。无法确认基准时先说明问题，不猜测改动。
2. 在 `release-notes/uTerm-vMAJOR.MINOR.PATCH.md` 编写详细说明。必须含 `## 中文` 和 `## English`，两部分内容逐项对应。用户可感知的每项改动应说明“改了什么、对使用有什么影响”，不能仅复制提交标题或文件列表。
3. 按实际改动使用以下分类，不强行填充没有变化的分类：
   - 新增功能 / Features：入口、操作方式及适用条件。
   - 改进 / Improvements：行为、交互或性能变化；未测量的性能收益不得写成事实。
   - 问题修复 / Fixes：可识别的问题现象与修复后的行为。
   - 兼容性与使用要求 / Compatibility and requirements：新增依赖、平台限制、设置或数据兼容性以及必要的用户操作。
   - 验证与已知限制 / Validation and known limitations：实际完成的测试与检查，未验证的原生平台/安装流程、仍存在的警告。构建通过不等于实际安装或运行验收。
4. 不得使用“uTerm x.y.z 发布 / release”作为全部正文，不得保留 TODO、模板提示或虚构改动。少量改动可以简短，但仍必须具体。对照差异检查是否遗漏重要功能、修复或限制；测试结果只能引用本次已确认的证据。

## 发版前检查

- 同步应用版本号；确认发布说明文件已纳入目标提交。版本说明是发版产物，功能指南仍只描述当前产品，不追加开发日记或历史流水账。
- 检查 `scripts/release.mjs` 与 `.github/workflows/uterm-release.yml` 的实际取值。调用 `releaseNotes(tag)` 核对最终读取的正文；脚本存在缺失文件兜底并不代表可以省略说明。
- 若 `DESKTOP_RELEASE_NOTES` 或其他配置覆盖说明，必须检查覆盖后的正文同样完整且双语一致。不通过检查就停止发布，不先打标签再补说明。
- 执行与改动相关的测试及文档检查，记录真实结果。发布授权下，先推送 `release`，再从经过审阅的提交创建并推送 `uTerm-vMAJOR.MINOR.PATCH` 标签。不要移动已发布标签。

## 发布结果验收

- 区分“已提交”“已触发构建”“已发布”，CI 未完成时不可声称已发布。
- 发布完成后检查 GitHub Release 正文是否含详细中英文说明，并保留自动生成的下载链接、签名/公证限制和平台信息。
- 检查版本安装包及稳定更新清单的版本、链接和说明。线上正文或更新说明为空/占位时报告为未完成；不要通过修改已发布标签补救。
- 若用户只授权调整规则，不回填已有 Release；若用户要求补充已有版本说明，按该版本实际差异编写并仅更新获授权的发布内容，保留下载链接与限制说明。
