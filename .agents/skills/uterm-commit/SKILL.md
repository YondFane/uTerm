---
name: uterm-commit
description: "Commit and optionally push uTerm changes with scoped staging, relevant validation, and aligned Simplified Chinese and English descriptions. 在用户要求提交或推送 uTerm 代码时使用，确保暂存范围准确、验证结果真实，并提供对齐的中英文变更说明。"
---

# uTerm 代码提交 / uTerm Code Commit

在当前仓库内执行，并遵循根目录 `AGENTS.md`。只有用户明确要求时才提交；只有用户明确要求推送时才推送。提交授权不等于推送授权，也不授权修改远端提交历史。

## 提交范围 / Commit Scope

- 提交前检查工作区、当前分支、暂存区和实际差异，区分本次任务改动与用户已有或无关改动。
- 使用明确的文件路径暂存本次任务内容，不用笼统暂存掩盖范围问题。无法可靠拆分重叠改动时，先说明阻碍，不猜测归属。
- 提交前复核暂存差异；不得提交密钥、构建产物、依赖目录或仓库规则禁止的文件。
- 按改动层执行相关验证。验证失败时说明失败是否由本次改动引起；不要绕过提交钩子或伪造通过结果。

## 中英文提交说明 / Bilingual Commit Description

- 标题使用简洁的英文 Conventional Commit 风格，例如 `fix: improve usage settings`。标题描述这一提交的主要目的，不罗列测试结果。
- 提交正文必须同时包含 `中文：` 与 `English:` 两部分。两部分逐项对应，只描述已暂存差异中的真实变化和用户可感知结果，不添加未实现内容、AI 署名或宽泛宣传。
- 内容简单时每种语言一条即可；包含多个独立变化时使用对齐的项目符号。推荐格式：

```text
fix: improve usage settings

中文：
- 切换 Agent 标签时自动读取用量。

English:
- Read usage automatically when switching Agent tabs.
```

## 推送与结果 / Push and Result

- 用户只要求“提交”时止于本地提交。用户同时要求“推送”时，在提交成功后推送当前分支到其已配置远端；不擅自创建标签、Release、PR、强推或改写历史。
- 完成后报告提交哈希、标题、实际包含的范围、验证结果，以及是否已成功推送。推送或验证失败时给出准确错误和当前状态，不把“已提交”“已推送”或“已发布”混为一谈。
