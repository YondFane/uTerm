---
name: uterm-release
description: Prepare and publish uTerm releases with version headings, concise bilingual feature
  highlights and usage instructions, then merge the published release into main. Use for uTerm release
  preparation, tagging, publishing, post-release main synchronization or editing release notes; not for
  unrelated projects or ordinary code changes.
---

# uTerm 发布

在当前仓库内执行，遵循根目录
`AGENTS.md`。仅在用户明确要求时提交、推送、打标签或修改线上 Release；仅调整 Skill 或编写说明不构成这些操作的授权。

## 发布说明：功能点与使用教程

- 核对远端最新稳定版本、当前分支与工作区。以上一个稳定版本标签到目标发布提交的真实差异为依据，包含计划提交的改动，排除更新通道标签、预发布版本及未纳入的改动。无法确认基准时先说明问题，不猜测功能。
- 在 `release-notes/uTerm-vMAJOR.MINOR.PATCH.md` 编写简短说明，首行使用一级标题
  `# uTerm MAJOR.MINOR.PATCH`（例如 `# uTerm 0.1.32`），版本号与文件名及发布标签一致。空一行后保留
  `## 中文` 和 `## English`，内容逐项对应。
- 正文只写本次发布的功能点和简短使用教程：新增了什么、在哪里打开、如何操作。每项通常一到两句话，可将功能与用法合写，避免重复介绍。只涉及修复时，简述用户能感知的修复结果，不虚构新增功能。
- 不写测试数量、QA 过程、CI/构建结果、内部实现、开发记录、完整兼容性清单或“验证与已知限制”章节。确实影响某项功能使用的条件，紧跟该项用法用一句话说明，例如“Push/Pull 需先设置上游分支”。
- 下载链接、平台信息及必要的安装提示由现有发布流水线附加，不在手写正文中重复铺陈。不以“uTerm
  x.y.z 发布 / release”替代实际内容，不保留 TODO、模板提示或无依据的宣传。

## 发版前检查

- 同步应用版本号，核对发布说明首行的版本标题与应用版本及目标标签一致，并在打标签前提交版本化发布说明。功能指南仍只描述当前产品，不追加发布流水账。
- 检查 `scripts/release.mjs` 与 `.github/workflows/uterm-release.yml` 的实际取值，调用
  `releaseNotes(tag)` 核对正文。若 `DESKTOP_RELEASE_NOTES`
  或其他配置覆盖说明，覆盖内容也必须保留正确的版本标题，且简短、双语一致并符合上述范围。说明缺失、仅有占位内容、缺少版本标题或版本不匹配时阻止发布，不使用脚本兜底代替。
- 执行相关测试及文档检查，按仓库要求记录真实验证结果；这些是发布前工作，不写进面向用户的发布说明。
- 发布获授权后，先推送 `release`，再从经过审阅的提交创建并推送 `uTerm-vMAJOR.MINOR.PATCH`
  标签。不要移动已发布标签。

## 发布结果验收

- 区分“已提交”“已触发构建”“已发布”，CI 未完成时不可声称已发布。
- 核对 GitHub
  Release 和稳定更新清单的正文均以正确的版本标题开头，其后为本次简短双语功能与用法说明，版本和下载链接正确，保留流水线附加的下载入口和必要安装提示。线上说明为空、仅有占位内容、缺少版本标题或版本不匹配时报告为未完成，不移动标签补救。
- 用户只要求调整规则时，仅更新规则；修改已有 Release 或更新清单需用户明确要求，并保留其下载链接与必要安装提示。

## 发布完成后合入 main

每次用户授权的正式发版，在 CI、公开安装包、稳定更新清单及 Latest 标记均验收成功后，将本次已发布的
`release` 提交合入远端
`main`。这一步属于正式发版的收尾流程，不另行等待用户重复提出同步请求。只修改规则或编写文档时，不执行发布或分支同步。

1. 记录版本标签及其不可变提交，重新获取 `origin/release` 和 `origin/main`。确认发布提交属于
   `origin/release`；构建期间若追加了未发布提交，同步到 `main`
   的范围截至本次版本标签，不夹带后续改动。

2. 使用干净的 `main`，或从最新 `origin/main`
   建立临时同步分支。可快进时优先快进；分叉时正常合并已发布提交，保留双方历史。先检查合并结果，按
   `uterm-commit` 技能写对齐的中英文合并说明，并执行合并涉及层的检查。不要重置
   `main`、强推、移动标签或覆盖用户改动。

3. 推送到 `origin/main`，核对远端提交并用祖先关系确认版本标签的提交已包含在远端 `main`
   中。远端并发更新时，先获取并重新合并、检查，再重试普通推送；同一原因连续失败两次后报告阻碍，不循环推送。

4. 分支保护需要 PR 时，按仓库允许的 PR 流程完成同步，不绕过检查或审查。权限、冲突或必要的人工审查尚未解决时，分别报告“版本已发布”和“main 同步未完成”，说明当前同步分支或 PR，不能把发版收尾标记为完成。

最终结果同时报告发布版本、发布提交和远端 `main`
同步状态。同步失败不回滚已经发布的版本，也不重新发布相同版本。
