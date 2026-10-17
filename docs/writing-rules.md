---
title: Documentation writing rules / 文档编写规范
status: active
type: reference
created: 2026-10-17
updated: 2026-10-17
---

# Documentation writing rules / 文档编写规范

Apply these rules when creating or editing repository documentation. Read this file and both feature
guides before updating feature documentation. The repository requirements in
[AGENTS.md](../AGENTS.md) also apply.

新建或修改仓库文档时遵循本规范。更新功能文档前，先阅读本文件及两份功能指南，同时遵循
[AGENTS.md](../AGENTS.md) 中的仓库要求。

**Contents / 章节导航**

- [Structure and navigation / 结构与导航](#structure-and-navigation--结构与导航)
- [Paragraphs and whitespace / 段落与留白](#paragraphs-and-whitespace--段落与留白)
- [Steps, lists and tables / 步骤、列表与表格](#steps-lists-and-tables--步骤列表与表格)
- [Feature behavior and validation / 功能说明与验证](#feature-behavior-and-validation--功能说明与验证)
- [Bilingual alignment / 中英文对齐](#bilingual-alignment--中英文对齐)
- [Checks before completion / 完成前检查](#checks-before-completion--完成前检查)

## Structure and navigation / 结构与导航

- Use one `#` title per document. Use `##` for major areas, `###` for specific features or reader
  tasks, and `####` only for details within a feature. Do not skip heading levels.

  每份文档只使用一个 `#` 标题。`##` 划分主要领域，`###` 对应具体功能或读者任务，`####`
  仅补充功能内的细节，不跳过标题层级。

- Give headings concrete names such as “Connection setup” or “SQL execution scope”. Add a small
  linked contents list when a document has more than five major sections. Keep existing anchors
  usable when reorganizing content.

  标题使用“连接配置”“SQL 执行范围”等具体名称。主要章节超过五个时，提供简短的链接目录。重排内容时保留已有章节链接的可用性。

- Keep one reader task in each subsection. Split a subsection when it starts mixing unrelated
  controls, workflows or constraints. Introduce an unfamiliar feature before listing its details.

  每个小节围绕一个读者任务展开。内容开始混合不同控件、操作流程或限制时，拆分小节。列出细节之前，先介绍读者尚不熟悉的功能。

## Paragraphs and whitespace / 段落与留白

- Keep each paragraph to one idea, usually one to three short sentences. Start a new paragraph when
  moving from an entry point to its behavior, from behavior to a restriction, or from usage to
  validation. Do not join a whole feature into a single paragraph with semicolons.

  一段只讲一个要点，通常使用一到三个短句。从入口转到行为、从行为转到限制、从用法转到验证时，另起一段。不要用连续分号把整个功能挤在一个段落中。

- Leave a blank line around headings, paragraphs, lists, code fences and tables. Use a blank line
  between list items that contain multiple sentences or wrapped explanatory text. Avoid repeated
  empty lines and decorative separators as substitutes for headings.

  标题、段落、列表、代码块和表格前后留一个空行。列表项包含多句说明或换行正文时，项与项之间留一个空行。不要用连续空行或装饰分隔线代替标题结构。

- Wrap prose with the repository's 100-column Prettier setting and `--prose-wrap always` so source
  files are readable as well as rendered pages. Source wrapping alone does not split a rendered
  paragraph; use blank lines to create actual paragraph spacing.

  使用仓库 Prettier 的 100 列设置及 `--prose-wrap always`
  对正文换行，兼顾源码和渲染后的阅读。源码自动换行不会拆开渲染后的段落，段落间距必须通过空行表达。

## Steps, lists and tables / 步骤、列表与表格

- Use numbered lists for actions that must happen in order. Put the entry point before the steps,
  and describe the visible result after the relevant action.

  有先后顺序的操作使用编号列表，先交代入口，再给出步骤，并在对应操作后说明可见结果。

- Use bullets for parallel behavior, choices, safeguards or limits. Keep one related point per item;
  keep the condition and its consequence together. Use prose for connected explanations rather than
  mechanically turning every sentence into a bullet. Prefer at most two levels of nesting.

  并列的行为、选项、保护条件或限制使用无序列表。每项围绕一个相关要点，条件与结果放在同一项。连贯解释保留为段落，不要机械地把每句话改成列表；嵌套优先控制在两层以内。

- Use tables for short comparisons, mappings, defaults and limits. Avoid long paragraphs in cells;
  explain complex behavior in the surrounding subsection. Give command blocks a language label and
  keep commands separate from prose.

  简短的对照、映射、默认值和限制可以用表格。表格单元格不要塞入长段落，复杂行为放回所属小节。命令代码块标明语言，并与说明文字分开。

## Feature behavior and validation / 功能说明与验证

Explain the entry point, behavior and expected result first, then place relevant limits nearby. Keep
automated checks, native inspection and pending acceptance under a separate validation heading. A
small feature does not need empty template sections.

先说明入口、行为和预期结果，再就近说明限制。自动化检查、原生检查及待验收项放在独立验证标题下。简单功能不需要保留空模板栏目。

- State which checks actually ran, the platform and whether they used real services or fixtures.
  Keep passed checks and remaining acceptance limits easy to distinguish.

  只记录实际执行的检查，写明平台及使用真实服务还是模拟数据，让已通过检查和待验收限制便于区分。

- Update the existing feature subsection and its current evidence. Do not append repeated QA
  paragraphs, change logs, development diaries or release history to the feature guides. Keep
  versioned release notes in `release-notes/` and follow the release skill for their separate
  format.

  更新功能所属小节及当前验证证据，不在功能指南末尾不断追加重复 QA 段落、变更日志、开发日记或发布历史。版本化发布说明保留在
  `release-notes/`，其独立格式遵循发布技能要求。

- Formatting changes must preserve facts, numeric limits, shortcuts and acceptance status. A
  documentation-only check does not establish application, platform or credential acceptance.

  排版修改必须保留事实、数值限制、快捷键及验收状态。纯文档检查不能作为应用、平台或凭据验收证据。

## Bilingual alignment / 中英文对齐

Update `features.md` and `features.zh-CN.md` together. Keep section order, heading levels, feature
scope, defaults, commands, limits and validation conclusions aligned. Natural phrasing may differ;
do not compress one language into longer, denser paragraphs. Keep language-switch links working.

同步更新 `features.md` 和
`features.zh-CN.md`，保持章节顺序、标题层级、功能范围、默认值、命令、限制及验证结论一致。表述可以自然调整，但不能把某种语言压缩成更长、更密的段落。保留有效的语言切换链接。

Use the application's established Simplified Chinese and English terminology. Put literal paths,
commands, settings keys and identifiers in inline code; use bold sparingly for scan points.

沿用应用既有的简体中文和英文术语。路径、命令、设置键和标识符使用行内代码；粗体仅用于少量阅读重点。

## Checks before completion / 完成前检查

1. Read the changed subsections in both languages. Check the heading outline, paragraph spacing,
   list grouping and rendered Markdown, including a narrow reading width for dense sections.

   通读两种语言的修改小节，检查标题大纲、段落间距、列表分组及 Markdown 渲染；密集章节还需检查较窄阅读宽度。

2. Preserve the required front matter and update both guides' `updated` dates to the actual edit
   date. Run `pnpm docs:sync`; do not edit generated index rows by hand.

   保留必需的文档元数据，两份指南的 `updated` 日期同步为实际编辑日期。运行
   `pnpm docs:sync`，不手动修改生成的索引行。

3. Run `pnpm docs:check` and explicitly format/check the changed Markdown files. The repository's
   general `format:check` command does not include these Markdown files. For example:

   运行 `pnpm docs:check`，并明确对修改的 Markdown 文件执行格式化和检查。仓库通用的 `format:check`
   命令不包含这些 Markdown 文件，例如：

   ```sh
   pnpm exec prettier --write --prose-wrap always docs/features.md docs/features.zh-CN.md docs/writing-rules.md
   pnpm exec prettier --check --prose-wrap always docs/features.md docs/features.zh-CN.md docs/writing-rules.md
   pnpm docs:sync
   pnpm docs:check
   ```

4. Verify local links and review the diff for accidental content loss, changed values or unsupported
   claims. Metadata and formatting checks do not verify translation accuracy or factual
   completeness.

   检查本地链接及差异，确认没有意外删文、修改数值或增加无依据结论。元数据和格式检查不能验证翻译准确性与事实完整性。
