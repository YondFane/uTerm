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

The ordinary and Personal collectors use `shared/fixtures/client-ui-parity.json` for the same
project name, file bytes, terminal names and font size. Both capture eight workspace scenes. The
ordinary collector changes language and appearance through its real settings controls and checks
actual saved state and PTY generation. The Personal collector also verifies targeted background-tab
close. Missing, duplicate, stale-source or mismatched-fixture records fail validation.

普通版与个人版采集器共用
`shared/fixtures/client-ui-parity.json`，统一项目名称、文件字节、终端名称及字号，并各采集八组工作区场景。普通版通过真实设置控件改变语言和外观，核对实际保存结果及 PTY
generation；个人版额外检查按目标关闭后台标签。缺失、重复、过期源码或测试数据不符的记录均会校验失败。

The isolated macOS runner prepares a display of at least 1280×900, records its actual modes and
bounds in `display.json`, and fails if the required area is unavailable. Actual content dimensions
remain mandatory. Personal validation retains raw reports and available original PNGs before
rejecting failed acceptance. A failure-window screenshot is attempted and capture errors are
recorded. Ordinary collection waits for actual input ownership before reading host identity.

隔离 macOS 运行器准备至少 1280×900 的显示区域，将实际模式及边界记录至
`display.json`，区域不可用时失败。实际内容尺寸仍为必检项。个人版验收失败前会保留原始报告及已生成的原始 PNG，并尝试截取失败窗口，记录截图错误。普通版采集器在读取宿主身份前等待实际输入控制就绪。

For PR CI, the `ui-parity-evidence` job collects the ordinary macOS and same-source Personal ARM64
artifacts. It validates source/merge identities, OS, architecture, fixture hash and PNG files, then
uploads 16 original images, `comparison.md` and `comparison.json`. Collection runs on Ubuntu and
never replaces a missing native capture with a browser render. `comparisonReady` means the images
are ready for review; `functionalParityAccepted` remains false until all acceptance rows are met.
This candidate's new collection flow still requires actual CI execution and visual inspection.

PR CI 的 `ui-parity-evidence` 任务汇集普通 macOS 版及同源码 Personal
ARM64 产物，校验源码／merge、系统、架构、样例哈希及 PNG 后，上传 16 张原图、`comparison.md` 和
`comparison.json`。汇集任务在 Ubuntu 运行，不会用浏览器渲染替代缺失的原生截图。`comparisonReady`
仅表示图片可供对照；在所有验收项满足前，`functionalParityAccepted`
始终为 false。当前候选采集流程仍需实际 CI 执行及看图核对。

## Local checks / 本地检查

Linux checks pass 444 existing Node tests with 11 platform skips, 17 Python package/evidence policy
tests, seven paired-evidence policy tests, 19 backend tests with QA enabled (one ignored),
TypeScript/production build, repository formatting, shell syntax and documentation checks. The
Python fixtures validate rejection rules only; they are not application screenshots. Swift
compilation and real-window interaction have not run for this candidate.

Linux 已通过 444 项现有 Node 回归（11 项按平台跳过）、17 项 Python 安装包／证据策略测试、七项成对证据策略测试、19 项启用 QA 的后端测试（一项忽略）、TypeScript／生产构建、全仓格式、Shell 语法及文档检查。Python 样例仅验证拒绝规则，不属于应用截图；当前候选代码尚未执行 Swift 编译和真实窗口交互。
