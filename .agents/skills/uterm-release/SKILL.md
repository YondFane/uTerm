---
name: uterm-release
description: Prepare and publish uTerm releases with concise bilingual feature highlights and usage instructions. Use for uTerm release preparation, tagging, publishing or editing release notes; not for unrelated projects or ordinary code changes.
---

# uTerm 发布

在当前仓库内执行，遵循根目录 `AGENTS.md`。仅在用户明确要求时提交、推送、打标签或修改线上 Release；仅调整 Skill 或编写说明不构成这些操作的授权。

## 发布说明：功能点与使用教程

- 核对远端最新稳定版本、当前分支与工作区。以上一个稳定版本标签到目标发布提交的真实差异为依据，包含计划提交的改动，排除更新通道标签、预发布版本及未纳入的改动。无法确认基准时先说明问题，不猜测功能。
- 在 `release-notes/uTerm-vMAJOR.MINOR.PATCH.md` 编写简短说明，保留 `## 中文` 和 `## English`，内容逐项对应。
- 正文只写本次发布的功能点和简短使用教程：新增了什么、在哪里打开、如何操作。每项通常一到两句话，可将功能与用法合写，避免重复介绍。只涉及修复时，简述用户能感知的修复结果，不虚构新增功能。
- 不写测试数量、QA 过程、CI/构建结果、内部实现、开发记录、完整兼容性清单或“验证与已知限制”章节。确实影响某项功能使用的条件，紧跟该项用法用一句话说明，例如“Push/Pull 需先设置上游分支”。
- 下载链接、平台信息及必要的安装提示由现有发布流水线附加，不在手写正文中重复铺陈。不以“uTerm x.y.z 发布 / release”替代实际内容，不保留 TODO、模板提示或无依据的宣传。

## 发版前检查

- 同步应用版本号，并在打标签前提交版本化发布说明。功能指南仍只描述当前产品，不追加发布流水账。
- 检查 `scripts/release.mjs` 与 `.github/workflows/uterm-release.yml` 的实际取值，调用 `releaseNotes(tag)` 核对正文。若 `DESKTOP_RELEASE_NOTES` 或其他配置覆盖说明，覆盖内容也必须简短、双语一致且符合上述范围。缺失或占位说明阻止发布，不使用脚本兜底代替。
- 执行相关测试及文档检查，按仓库要求记录真实验证结果；这些是发布前工作，不写进面向用户的发布说明。
- 发布获授权后，先推送 `release`，再从经过审阅的提交创建并推送 `uTerm-vMAJOR.MINOR.PATCH` 标签。不要移动已发布标签。

## 发布结果验收

- 区分“已提交”“已触发构建”“已发布”，CI 未完成时不可声称已发布。
- 核对 GitHub Release 和稳定更新清单的正文均为本次简短双语功能与用法说明，版本和下载链接正确，保留流水线附加的下载入口和必要安装提示。线上说明为空或占位时报告为未完成，不移动标签补救。
- 用户只要求调整规则时，仅更新规则；修改已有 Release 或更新清单需用户明确要求，并保留其下载链接与必要安装提示。
