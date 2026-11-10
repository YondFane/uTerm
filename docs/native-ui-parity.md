---
title: Native UI parity acceptance / 原生界面一致性验收
status: active
type: reference
created: 2026-11-10
updated: 2026-11-10
---

# Native UI parity acceptance / 原生界面一致性验收

The ordinary macOS client at release source `a33f890f1bdac1afe8f6e37955f9be08edf7732a` is the
comparison baseline. Compare both actual applications at the same candidate source, language,
appearance, content size and fixture data. Shared Rust behavior and build success alone do not
establish UI parity.

普通 macOS 客户端的 release 源码 `a33f890f1bdac1afe8f6e37955f9be08edf7732a`
为对照基线。两版真实应用须使用同一候选源码、语言、外观、内容尺寸和测试数据。共享 Rust 行为或构建成功不能单独证明界面一致。

## Acceptance scope / 验收范围

Every row requires equivalent visible actions, keyboard/focus behavior, saved results, cancellation
and error recovery. Pending means no same-source paired acceptance exists; it does not assert that
every listed behavior is absent. Native platform APIs may differ while their user-facing behavior
must match.

每项须对齐可见操作、键盘／焦点、保存结果、取消及错误恢复。“待验收”表示尚无同源码的两版对照结论，不表示所列行为全部缺失。原生平台 API 可以不同，用户操作结果必须一致。

| Area / 区域     | Checks / 核对项                                                                                                                                 | Status / 状态    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Toolbar / 顶栏  | Open project/file, terminal, default/custom Agent, command palette / 打开项目／文件、终端、默认／自定义 Agent、命令面板                         | Pending / 待验收 |
| Toolbar / 顶栏  | Split, zoom, sidebar/tools, shortcuts, busy states / 分屏、缩放、侧栏／工具、快捷键、忙碌状态                                                   | Pending / 待验收 |
| Sidebar / 侧栏  | Workspace create/rename/delete/switch; search and filters / 工作区增删改切换、搜索及分类                                                        | Pending / 待验收 |
| Sidebar / 侧栏  | Project order, pinning, collapse, Worktrees, context menus / 项目排序、置顶、折叠、Worktree、右键菜单                                           | Pending / 待验收 |
| Sidebar / 侧栏  | SSH, database and Redis entry points, grouping and credentials / SSH、数据库及 Redis 入口、分组及凭据                                           | Pending / 待验收 |
| Sessions / 会话 | Create/select/rename/close, selected/background generation safety / 新建／切换／重命名／关闭、前后台 generation 安全                            | Pending / 待验收 |
| Sessions / 会话 | Drag order, grouping/ungrouping, cross-workspace movement, persistent layout / 拖动排序、组合／取消组合、跨工作区移动、布局持久化               | Pending / 待验收 |
| Content / 内容  | File tabs, drafts, conflicts, Markdown/PDF and marks / 文件标签、草稿、冲突、Markdown／PDF 及标记                                               | Pending / 待验收 |
| Tools / 工具    | Files, hidden files, quick open, content search and root boundaries / 文件、隐藏文件、快速打开、内容搜索及根目录边界                            | Pending / 待验收 |
| Tools / 工具    | Git/GitHub, SFTP/transfers/tunnels, database and Redis workbenches / Git／GitHub、SFTP／传输／隧道、数据库及 Redis 工作台                       | Pending / 待验收 |
| Tasks / 任务    | Java/Maven/Python panels, selectors, arguments, logs and stop / Java／Maven／Python 面板、选择器、参数、日志及停止                              | Pending / 待验收 |
| Settings / 设置 | One complete entry, all sections/defaults, search, theme import and shortcuts / 统一完整入口、全部分类／默认值、搜索、主题导入及快捷键          | Pending / 待验收 |
| Settings / 设置 | Save/reload/reset, concurrent conflicts, retained drafts, restart and update preferences / 保存／重读／重置、并发冲突、草稿保留、重启及更新偏好 | Pending / 待验收 |

## Evidence / 证据

Use isolated application identities and temporary projects. Capture both actual windows for English
and Simplified Chinese, dark and light appearance, and 1100×720 and 640×720 content sizes. Each
scene needs the platform, architecture, system, source head SHA, tested merge SHA, scenario and
screenshot filename. Upload original PNGs and reports as accessible CI artifacts. Link paired
screenshots per row and record actual operation assertions; images alone cannot prove cancellation,
conflict handling, session safety or persistence.

使用隔离应用标识及临时项目，采集两版真实窗口：中英文、深浅主题、1100×720 及 640×720 内容尺寸。逐场景记录平台、架构、系统、源码 head
SHA、实际测试 merge SHA、操作及截图文件名。原始 PNG 和报告上传为可访问的 CI
artifacts。每项关联成对截图及实际操作断言；仅图片不能证明取消、冲突处理、会话安全或持久化。

The personal smoke driver includes an eight-scene workspace grid and checks that closing a
background tab retains the selected terminal generation. Its package validator rejects missing,
duplicate or mismatched-source scene records. This is one client's evidence collection, not a
completed two-client comparison. Same-source native compilation, execution, actual images and paired
comparison remain pending until the candidate runs on macOS CI.

个人版冒烟入口包含八组工作区截图及关闭后台标签后保留所选终端 generation 的检查。安装包校验器拒绝场景缺失、重复或源码不符的记录。这仅是单端证据采集，不代表两版对照完成。同源码原生编译、运行、真实截图及成对比较仍待候选代码在 macOS
CI 执行。

## Local checks / 本地检查

Linux checks pass 444 existing Node tests with 11 platform skips, 15 Python package/evidence policy
tests, TypeScript/production build, repository formatting, shell syntax and documentation checks.
The Python fixtures validate rejection rules only; they are not application screenshots. Swift
compilation and real-window interaction have not run for this candidate.

Linux 已通过 444 项现有 Node 回归（11 项按平台跳过）、15 项 Python 安装包／证据策略测试、TypeScript／生产构建、全仓格式、Shell 语法及文档检查。Python 样例仅验证拒绝规则，不属于应用截图；当前候选代码尚未执行 Swift 编译和真实窗口交互。
