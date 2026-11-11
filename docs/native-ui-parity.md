---
title: Native UI parity acceptance / 原生界面一致性验收
status: active
type: reference
created: 2026-11-10
updated: 2026-11-11
---

# Native UI parity acceptance / 原生界面一致性验收

The ordinary macOS client at release source `3f91a6aac4c348c21276a4fe97136d77d5a84a6a` is the
comparison baseline. Compare both actual applications at the same candidate source, language,
appearance, content size and fixture data. Shared Rust behavior and build success alone do not
establish UI parity.

普通 macOS 客户端的 release 源码 `3f91a6aac4c348c21276a4fe97136d77d5a84a6a`
为对照基线。两版真实应用须使用同一候选源码、语言、外观、内容尺寸和测试数据。共享 Rust 行为或构建成功不能单独证明界面一致。

The goal includes matching layout, visible controls, icons, typography, spacing and colors as well
as function and interaction. Native platform APIs do not exempt the Personal client from these
visual requirements. Existing 0.2.9 evidence covers 30 matched navigation/workspace scenarios; it is
retained at PR #51 and is not acceptance of the new Java candidate or the complete interface.

目标包含布局、可见控件、图标、字体、间距及颜色与功能／交互的一致性。原生平台 API 不能作为 Personal 界面不同的豁免理由。0.2.9 已有 30 组导航／工作区对照证据保留于 PR
#51，不能作为新增 Java 候选或完整界面的一致性验收。

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

The project sidebar candidate adds nested sessions/Worktrees, durable pin/collapse, manual peer
ordering and local drag targets, project rename/move/removal, and empty-workspace deletion. Personal
QA invokes actual project menu actions and the disclosure button, checks shared saved state, rejects
a stale reorder and retains the original PTY generation. Extra `personal-*-sidebar-collapsed.png`
and `personal-*-sidebar-expanded.png` images show these scenarios. Compilation and execution of this
candidate remain pending; the drag path is not yet accepted. The common fixture includes the literal
workspace name to avoid differing default names in paired captures.

项目侧栏候选代码增加嵌套会话／Worktree、持久置顶／折叠、同组手动排序与本地拖动、项目重命名／移动／移除，以及空工作区删除。个人版 QA 实际调用项目菜单及展开按钮，检查共享保存结果、拒绝过期重排并保留原 PTY
generation。额外的 `personal-*-sidebar-collapsed.png`、`personal-*-sidebar-expanded.png`
展示相应场景。此候选代码尚待编译和执行，拖动路径未验收。共同样例还包含工作区字面名称，避免成对截图的默认名称不同。

The isolated macOS runner prepares a display of at least 1280×900, records its actual modes and
bounds in `display.json`, and fails if the required area is unavailable. Actual content dimensions
remain mandatory. Personal validation retains raw reports and available original PNGs before
rejecting failed acceptance. A failure-window screenshot is attempted and capture errors are
recorded. Ordinary collection waits for actual input ownership before reading host identity. The
Personal collector measures actual content bounds and adjusts the real window frame in at most five
attempts. Each scene records the measured attempts; failing to reach 720 pixels still fails
acceptance.

隔离 macOS 运行器准备至少 1280×900 的显示区域，将实际模式及边界记录至
`display.json`，区域不可用时失败。实际内容尺寸仍为必检项。个人版验收失败前会保留原始报告及已生成的原始 PNG，并尝试截取失败窗口，记录截图错误。普通版采集器在读取宿主身份前等待实际输入控制就绪。

个人版采集器测量实际内容边界，最多五次调整真实窗口 frame；每个场景记录测量尝试，未达到 720 像素仍验收失败。

For PR CI, the `ui-parity-evidence` job collects the ordinary macOS and same-source Personal ARM64
artifacts. It validates source/merge identities, OS, architecture, fixture hash and PNG files, then
uploads 64 original images, `comparison.md` and `comparison.json`. Collection runs on Ubuntu and
never replaces a missing native capture with a browser render. `comparisonReady` means the images
are ready for review; `functionalParityAccepted` remains false until all acceptance rows are met.
This candidate's new collection flow still requires actual CI execution and visual inspection.

PR CI 的 `ui-parity-evidence` 任务汇集普通 macOS 版及同源码 Personal
ARM64 产物，校验源码／merge、系统、架构、样例哈希及 PNG 后，上传 64 张原图、`comparison.md` 和
`comparison.json`。汇集任务在 Ubuntu 运行，不会用浏览器渲染替代缺失的原生截图。`comparisonReady`
仅表示图片可供对照；在所有验收项满足前，`functionalParityAccepted`
始终为 false。当前候选采集流程仍需实际 CI 执行及看图核对。

Settings add 24 matched navigation scenes: twelve common categories at English dark 900×640 and
Chinese light 660×640. Native QA presses actual AppKit buttons; ordinary QA clicks the rendered
settings navigation. Both assert actual content dimensions, selected section and unchanged drafts.
The collector requires every settings scene, source identity and original image. The Java
environment candidate now uses the shared component service, with loaded catalog assertions and
local JDK registration tests. Its new native execution remains pending; captures alone cannot
establish complete settings parity.

设置另采集 24 组匹配导航场景：十二个共有分类，分别使用英文深色 900×640 与中文浅色 660×640。原生 QA 按下实际 AppKit 按钮，普通版点击渲染的设置导航；两版均检查实际内容尺寸、所选分类及草稿未变。汇集器要求完整分类场景、源码身份及原图。Java 开发环境候选分类现接入共享组件服务，增加目录加载断言与本机 JDK 注册测试。新增原生执行仍待完成，不能只凭截图证明完整设置一致性。

## Source-bound CI findings / 绑定源码的 CI 结果

At head `a10d2985b59afd04ebb0cd72ea93417d426b54a6`, tested merge
`ad48fd33a0872a82f98bf2a8e8a23a58b0a990ae`, the
[ARM native job](https://github.com/YondFane/uTerm/actions/runs/42753479192/job/129622306101) passed
its complete native interaction matrix. Its
[artifact](https://github.com/YondFane/uTerm/actions/runs/42753479192/artifacts/13735681350) retains
actual settings, terminal and file-tool screenshots. This is regression evidence for that source,
not acceptance of later candidates or full paired parity.

源码 `a10d2985b59afd04ebb0cd72ea93417d426b54a6`、实际测试 merge
`ad48fd33a0872a82f98bf2a8e8a23a58b0a990ae` 的
[ARM 原生任务](https://github.com/YondFane/uTerm/actions/runs/42753479192/job/129622306101)
已通过完整原生交互矩阵。[产物](https://github.com/YondFane/uTerm/actions/runs/42753479192/artifacts/13735681350)保留实际设置、终端和文件工具截图。这是该源码的回归证据，不能作为后续候选代码或完整两版一致性验收。

At head `0da8f364dd1c734885c45b8bf7e0bb4d72dcf4cb`, tested merge
`143b26396bc2cc71cb812e0fcad445d3cbd2b756`, the ARM Personal collector retained
[original images and reports](https://github.com/YondFane/uTerm/actions/runs/42756610518/artifacts/13735713914)
when acceptance failed. `display.json` confirms 1280×960, but all eight workspace images and actual
content bounds are 684 pixels tall. File lists were readable, but the required height was not met.
This failure remains a failure; the candidate's measured-frame correction needs a new CI run.

源码 `0da8f364dd1c734885c45b8bf7e0bb4d72dcf4cb`、实际测试 merge
`143b26396bc2cc71cb812e0fcad445d3cbd2b756`
的 ARM 个人版在验收失败时保留了[原图及报告](https://github.com/YondFane/uTerm/actions/runs/42756610518/artifacts/13735713914)。`display.json`
确认显示区域为 1280×960，但八张工作区原图及实际内容边界高度均为 684 像素。文件列表可读，规定高度未满足。该结果仍为失败；候选代码的实测 frame 修正需要新的 CI 执行。

At head `07b0c7f89416c608916b15489395c52d60817285`, tested merge
`cbd1054915d21f25ab5e21866238b0cbf3ee4bf6`, the ARM Personal run failed the actual disclosure-button
expansion check. Its
[artifact](https://github.com/YondFane/uTerm/actions/runs/42758139510/artifacts/13736453774) retains
`personal-initial-sidebar-collapsed.png`, `personal-initial-failure.png` and the raw timeout report.
The collapsed image confirms the hierarchical row and running terminal; expansion was not accepted.
The candidate refreshes already-created disclosure buttons when busy state changes and keeps the
same operation assertion for a new run.

源码 `07b0c7f89416c608916b15489395c52d60817285`、实际测试 merge
`cbd1054915d21f25ab5e21866238b0cbf3ee4bf6`
的 ARM 个人版在真实展开按钮检查中失败。[产物](https://github.com/YondFane/uTerm/actions/runs/42758139510/artifacts/13736453774)保留
`personal-initial-sidebar-collapsed.png`、`personal-initial-failure.png`
及原始超时报告。折叠图确认层级行与运行中的终端，展开未验收。候选代码在忙碌状态变化时刷新已有展开按钮，并保留相同操作断言供新一轮执行。

At head `a2b0fa8766b4ac487375d1148d7427b54671c7ec`, tested merge
`fc916280c8200a1af45ade7e59c80f22f3684cfe`, ARM Personal completed actual project pin/collapse/order
and stale-write checks and captured all 18 settings navigation images. Its
[artifact](https://github.com/YondFane/uTerm/actions/runs/42760190596/artifacts/13737527887) retains
the originals and failed report. Workspace capture still failed: AppKit saw a 1024×768 display with
only 684 pixels available, despite the earlier helper reporting 1280×960. The candidate uses a
login-session display transaction and a separate `--verify-only` process checking both CoreGraphics
and AppKit, keeping `display-verified.json`. No size requirement is waived.

源码 `a2b0fa8766b4ac487375d1148d7427b54671c7ec`、实际测试 merge
`fc916280c8200a1af45ade7e59c80f22f3684cfe`
的 ARM 个人版完成真实项目置顶／折叠／排序与过期写入检查，并采集全部 18 张设置导航原图。[产物](https://github.com/YondFane/uTerm/actions/runs/42760190596/artifacts/13737527887)保留原图及失败报告。工作区截图仍失败：此前辅助进程报告 1280×960，实际 AppKit 却看到 1024×768、仅 684 像素可用。候选代码改用登录会话显示事务，并用独立
`--verify-only` 进程核对 CoreGraphics／AppKit，保留 `display-verified.json`。尺寸要求未豁免。

Standalone native Maven settings add actual save-button, literal-path, peer-conflict and project
preservation checks plus `native-settings-maven-conflict.png`. Both matched Maven scenes require
loaded controls matching the shared fixture. These new controls, independent read bridge and display
configuration still require current-source macOS execution.

独立原生 Maven 设置新增真实保存按钮、字面路径、并发冲突及项目配置保留检查，并采集
`native-settings-maven-conflict.png`。两版匹配 Maven 场景要求已加载控件符合共同样例。新增控件、独立读取桥接及显示配置仍需当前源码 macOS 执行。

At source `cd27f9797a23bc97c78a409dc359f1df7f6cc625`, both Personal architectures passed display
preparation including the fresh-process AppKit verification, but app compilation failed on one
optional-value access in the new Maven QA assertion. The candidate unwraps that optional; the
previous failure does not count as runtime acceptance.

源码 `cd27f9797a23bc97c78a409dc359f1df7f6cc625`
的两种 Personal 架构均通过显示准备及独立进程 AppKit 复查，但应用编译因新增 Maven
QA 断言的一处可选值访问失败。候选代码已解包该值；此前失败不能作为运行时验收。

The native database components candidate uses the existing shared service for download, resume,
import, remove, cancel and local Java selection. Settings and the workbench share one event reader
with separate subscribers, preventing event loss from competing consumers. Native QA captures the
read-only catalog without creating a download directory; the real PostgreSQL fixture verifies
component notifications reach both the settings observer and WebKit. Paired component images require
a loaded catalog. No new native execution result is claimed before CI runs this candidate.

原生数据库组件候选页面沿用共享服务的下载、续传、导入、移除、取消及本机 Java 选择。设置和工作台共用单一事件读取，各自订阅通知，避免竞争消费而丢失事件。原生 QA 采集只读目录且检查未创建下载目录；真实 PostgreSQL 样例验证组件通知同时到达设置观察器与 WebKit。成对组件截图必须先加载目录。CI 执行此候选代码前，不宣称新增原生运行结果。

At source `d44086b6a8ec75687e5609a50a8e4601e01f95af`, both Personal architectures and the native
matrix failed compilation because the component page exceeded Swift expression type-checking limits
([ARM log](https://github.com/YondFane/uTerm/actions/runs/42765375356/job/129660526340)). The
candidate extracts separate catalog, component, actions, progress and footer expressions. No runtime
result from that failed build is counted as acceptance.

源码 `d44086b6a8ec75687e5609a50a8e4601e01f95af`
的两种 Personal 架构及原生矩阵均因组件页面超过 Swift 表达式类型推断限制而编译失败（[ARM 日志](https://github.com/YondFane/uTerm/actions/runs/42765375356/job/129660526340)）。候选代码将目录、组件、操作、进度与底栏分别提取；失败构建不计为运行验收。

Native interface/terminal font pickers use the same preset values and bilingual labels as the
ordinary client. Actual AppKit control QA retains custom values without writes, chooses presets and
checks their exact shared-core round trip; `native-settings-custom-font.png` records the custom
entry. The two-client category grid also captures these controls. These checks require fresh native
execution and do not close the full settings acceptance row.

原生界面／终端字体选择器复用普通版的预设值及双语名称。真实 AppKit 控件 QA 检查自定义值未被隐式写入、选择预设并核对共享核心的完整值往返；`native-settings-custom-font.png`
记录自定义项，两版分类截图也覆盖相应控件。这组检查仍需新的原生执行，不据此完成整项设置验收。

At head `72c168b957b2cef86a06a38e0d840d7d9e89e746`, tested merge
`6783ae035fabaec71e595b4b5fd312216ce761b7`, ARM Personal compiled and passed 43 Swift tests.
[Original evidence](https://github.com/YondFane/uTerm/actions/runs/42767545238/artifacts/13740209277)
retains 21 settings scenes, including loaded Maven and database controls. The run failed when the
collector clicked the next category during a repeated Maven read's temporary disabled state. Both
native collectors now wait for actual enabled navigation and validate loaded controls after window
layout. Maven settings reuse loaded drafts until explicit reload. This incomplete result does not
satisfy the full screenshot grid or two-client acceptance.

源码 `72c168b957b2cef86a06a38e0d840d7d9e89e746`、测试 merge
`6783ae035fabaec71e595b4b5fd312216ce761b7` 的 ARM Personal 编译及 43 项 Swift 测试通过。
[原始证据](https://github.com/YondFane/uTerm/actions/runs/42767545238/artifacts/13740209277)保留 21 组设置场景，包含已加载的 Maven 与数据库控件。采集器在 Maven 重读暂时禁用导航时点击下一分类，故运行失败。两种原生采集器现均等待真实导航恢复可用，并在窗口布局后核对加载完成。Maven 设置复用已加载草稿，直至显式重读；此次不完整结果不满足截图网格或两版一致性验收。

Shared session operations add pinning, peer reorder, existing-session grouping and pane
repositioning. Grouping follows the ordinary TypeScript algorithm's alternating nested axes and leaf
pruning; ungrouping selects its target. Revision conflicts and invalid roster/Worktree/pin targets
fail without modifying the stored document. Native sidebar/tab menus expose these operations, and
the sidebar drag path accepts its own table's captured source only. Actual-menu QA checks preserved
PTY generations/views and captures `native-session-ungrouped.png` and `native-session-grouped.png`.
The native drag gesture remains explicitly unexecuted; no session acceptance row is closed from
shared-core tests alone.

共享会话操作增加置顶、同组重排、已有会话组合及面板位置调整。组合遵循普通版 TypeScript 算法的嵌套轴交替和叶子裁剪，取消组合选中操作目标。revision 冲突或非法列表／Worktree／置顶组目标不会修改存储文档。原生侧栏及标签菜单提供这些操作，侧栏拖动仅接受自身表格记录的来源。真实菜单 QA 检查 PTY
generation／视图未变，并采集
`native-session-ungrouped.png`、`native-session-grouped.png`。原生拖动手势明确标为未执行，不以共享核心测试单独完成会话验收。

At head `ab03155c512e8cf277f2112ba8bd52826e58b53b`, tested merge
`cf45d9553308bd2c7b830c45f871cd34a7929fe5`, both Personal packages and the ordinary Mac/Windows
interaction matrices passed. The new ordinary screenshot phase failed its viewport-size assertion
([originals](https://github.com/YondFane/uTerm/actions/runs/42778323852/artifacts/13746127038)): its
QA window replaced production's overlay title bar with a standard title bar. The harness now
inherits the production main-window configuration and keeps the 720-pixel assertion. Failure reports
include actual inner/outer dimensions; original captures are retained.

源码 `ab03155c512e8cf277f2112ba8bd52826e58b53b`、测试 merge
`cf45d9553308bd2c7b830c45f871cd34a7929fe5`
的两种 Personal 安装包及普通版 Mac／Windows 交互矩阵通过。新增普通版截图阶段因视口尺寸断言失败（[原图](https://github.com/YondFane/uTerm/actions/runs/42778323852/artifacts/13746127038)）：QA 窗口把正式版覆盖式标题栏替换成标准标题栏。启动器现继承正式主窗口配置，并保留 720 像素断言；失败报告包含实际内外尺寸，原图继续保留。

The same head's ARM native matrix retained actual SFTP/remote-output checks but timed out when a
password-session command was sent immediately after PTY ownership
([original report](https://github.com/YondFane/uTerm/actions/runs/42778323682/artifacts/13747005526)).
Native key and password QA now requires the parsed authenticated remote prompt before sending the
command, while keeping the real password/SFTP and generation assertions. Fresh native execution is
required; no authentication check is waived.

同一源码的 ARM 原生矩阵已完成真实 SFTP／远端输出检查，但在 PTY 取得所有权后立即向密码会话发送命令时超时（[原始报告](https://github.com/YondFane/uTerm/actions/runs/42778323682/artifacts/13747005526)）。原生密钥及密码 QA 现均要求已解析的认证后远端提示符，再发送命令；保留真实密码、SFTP 及 generation 断言。这组修改仍需新的原生执行，未豁免认证检查。

At head `ebb2afea26ed250086e45d729f3c9e3a920f86e4`, tested merge
`7377aaf29a01aee0d463eb9e5b67cc717601b12e`, both Personal packages, both full native matrices and
Windows signed-update QA passed. Ordinary Mac interaction passed and its capture reached the actual
1100×720 viewport, then the backend rejected numeric/locale screenshot scene names
([original failure](https://github.com/YondFane/uTerm/actions/runs/42782967854/artifacts/13750761295)).
The isolated QA validator now accepts ASCII letters, digits and hyphens, retaining its length and
path-component restrictions. The QA-enabled backend passes 20 tests with one explicit ignore;
new-source real capture is still required. An existing Windows OpenSSH configuration test also timed
out on that head; its first-attempt log is retained and does not count as a pass.

源码 `ebb2afea26ed250086e45d729f3c9e3a920f86e4`、测试 merge
`7377aaf29a01aee0d463eb9e5b67cc717601b12e`
的两种 Personal 安装包、两种完整原生矩阵及 Windows 签名更新 QA 通过。普通版 Mac 交互通过，截图达到实际 1100×720 视口后，后端拒绝了含数字／语言名称的截图场景名（[失败原图](https://github.com/YondFane/uTerm/actions/runs/42782967854/artifacts/13750761295)）。隔离 QA 校验现允许 ASCII 字母、数字及连字符，保留长度与路径组成限制。启用 QA 的 20 项后端测试通过，一项明确忽略；仍需新源码真实采集。同一源码的一项既有 Windows
OpenSSH 配置测试超时，首次日志保留，不计为通过。

At head `b1795ba4854893df3555d25aea319779e32684a2`, tested merge
`34e144db07faa1ed6829d620b17d13eb866a78ac`, the Windows ordinary matrix passed. Mac ordinary
interaction passed and all 30 original workspace/settings captures were generated, but phase-exit
validation incorrectly expected the default three scenes
([originals and failed report](https://github.com/YondFane/uTerm/actions/runs/42789504113/artifacts/13751935385)).
Both phase and full-grid validation now require the exact scene identities derived from the shared
fixture. Regressions reject missing, duplicate, substituted and extra scenes and follow fixture
changes. The retained run is not rewritten as passing; fresh same-source captures remain required.

源码 `b1795ba4854893df3555d25aea319779e32684a2`、测试 merge
`34e144db07faa1ed6829d620b17d13eb866a78ac`
的 Windows 普通版矩阵通过。Mac 普通版交互通过并生成全部 30 张原始工作区／设置截图，但阶段退出校验错误地使用默认三个场景（[原图与失败报告](https://github.com/YondFane/uTerm/actions/runs/42789504113/artifacts/13751935385)）。阶段及完整网格现均要求共同样例定义的完整场景名称。回归拒绝缺失、重复、替换和额外场景，并跟随样例变更。保留的运行不会改写为通过；仍需新源码的真实截图。

## Local checks / 本地检查

Linux checks pass 448 Node tests with 11 platform skips and 237 shared-core tests (17 explicitly
ignored), including five session tests and the Rust/TypeScript grouping comparison; 18 Python
package/evidence policy tests, ten paired-evidence policy tests, 20 backend tests with QA enabled
(one ignored), TypeScript/production build, repository formatting, shell syntax and documentation
checks. The Python fixtures validate rejection rules only; they are not application screenshots.
Swift compilation and real-window interaction have not run for this candidate.

Linux 已通过 448 项 Node 回归（11 项按平台跳过）及 237 项共享核心测试（17 项显式忽略），包含五项会话测试及 Rust／TypeScript 组合算法对照；另通过 18 项 Python 安装包／证据策略测试、十项成对证据策略测试、20 项启用 QA 的后端测试（一项忽略）、TypeScript／生产构建、全仓格式、Shell 语法及文档检查。Python 样例仅验证拒绝规则，不属于应用截图；当前候选代码尚未执行 Swift 编译和真实窗口交互。
