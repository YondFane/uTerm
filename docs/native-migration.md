---
title: Native clients and shared core / 原生客户端与共享核心
status: active
type: reference
created: 2026-11-02
updated: 2026-11-02
---

# Native clients and shared core / 原生客户端与共享核心

## Baseline and boundaries / 基线与边界

The migration branch starts at release `4f10848868ac09a3667e140938c345b265f9dd58`. Main
`0c6a7fee2eef238e72c9ecf34db99634f205d04c` has the same file tree and an additional merge commit. No
main-only code is imported. Application version stays 0.2.3; the existing macOS minimum is 14.0.
This work does not publish releases or modify stable updater feeds.

迁移分支基于上述 release 提交。main 仅多出合并历史，文件内容一致；未挑选其他代码。应用版本保持 0.2.3，macOS 最低版本保持 14.0。本任务不发布版本或修改稳定更新清单。

```mermaid
flowchart TD
  React[Windows React] --> Tauri[Tauri adapters]
  Swift[macOS SwiftUI / AppKit] --> FFI[C ABI adapters]
  Tauri --> Core[uterm-core]
  FFI --> Core
  Core --> Ports[Platform ports]
  Core --> Host[utermd-local]
  Web[CodeMirror / PDF / xterm web content] --> Transport[Client transport]
  Transport --> Tauri
  Transport --> FFI
```

Core must not depend on Tauri, DOM, SwiftUI or AppKit. Window/menu/notification/file-picker adapters
stay in their client. The host remains a separate crate and process. Keep each Cargo manifest and
lockfile independent; no top-level workspace migration is intended.

核心不依赖 UI 框架；窗口、菜单、通知和选择器属于客户端适配。宿主保持独立 crate 和进程，各自 Cargo
manifest 与 lockfile 继续隔离。

## Capability ownership / 能力归属

| Capability / 能力                    | Existing owner / 现有归属                       | Migration boundary / 迁移边界                                     |
| ------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------- |
| Workspaces, projects / 工作区、项目  | `src/lib/workspace.ts`, App reducers            | Core validates and commits transitions; UI owns layout/focus      |
| Settings / 设置                      | `src/lib/settings.ts`, WebView storage          | Core validates and persists; client applies fonts/appearance      |
| PTY and replay / 终端与回放          | `crates/utermd-local`, Tauri session links      | Reuse host authentication, IDs, generation, sequence and ack      |
| Files and drafts / 文件与草稿        | Rust files service, CodeMirror, editor recovery | Shared root/conflict rules; reuse editor with transport           |
| Git / 版本控制                       | Rust Git service, React presentation            | Shared Git commands; native entry and shared content views        |
| SSH and SFTP / 远程连接              | Rust SSH/auth/tunnel services, host SSH PTY     | Shared authentication and transfers; platform credential port     |
| Java/Python tasks / 运行任务         | Rust launch services, host task pipeline        | Preserve task generations, final output and stop ownership        |
| Databases / 数据库                   | Rust database services, bundled Java engine     | Reuse workers and verified driver/runtime catalogs                |
| Redis / Redis 工作台                 | Rust client and protected mutation rules        | Shared guarded operations, credentials through platform port      |
| Agents / Agent                       | Host agents/hooks, Rust installation and usage  | Preserve commands, reporter paths and authentication              |
| Notifications / 通知                 | Shared activity, Tauri native dispatch          | Native client adapter, same state and deduplication semantics     |
| Menus, shortcuts, updates / 平台交互 | Tauri, TS view state, updater                   | Native AppKit/Sparkle candidate path; stable Tauri route retained |

This table is a migration target, not a claim that services already moved. The checked-in
`shared/contracts/tauri-baseline.json` inventories the baseline IPC names and storage declarations.

此表描述迁移职责，不表示已经迁移。基线 IPC 名称和存储声明见上述清单。

## Storage and process inventory / 存储与进程清单

| Store / 存储                   | Version, owner and semantics / 版本、所有者与语义                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uterm.desktop.workspace.v1`   | Workspace schema 7; TS imports schemas 3–6 with one-time backups; null selections and empty rosters remain meaningful                                                                                            |
| `uterm.desktop.settings.v1`    | Settings schema 1; TS fills only documented missing defaults, then validates                                                                                                                                     |
| `uterm.desktop.editorDraft.v1` | Editor recovery snapshot; invalid bytes retained under `.invalid`; save conflicts retain drafts                                                                                                                  |
| Other WebView keys / 其他键    | Notifications, Git favorites and version-scoped PDF marks; `.backup`, `.invalid` and workspace-version backup suffixes are retained. Fonts/panes are settings fields; database drafts remain client-owned memory |
| Rust app data / Rust 应用数据  | Java/Python configs, component catalogs, connection state and local control are rooted at the client's resolved app-data directory                                                                               |
| Credentials / 凭据             | macOS Keychain / Windows credential APIs; do not export secret values into workspace JSON, FFI events or CI artifacts                                                                                            |
| Host / 宿主                    | `local-daemon-v1` owns authenticated endpoint, session processes, bounded replay and task state; closing a client only detaches                                                                                  |

Production identity is `sh.uterm.desktop`; legacy development is `sh.uterm.desktop.dev`. Native QA
uses `sh.uterm.desktop.qa.native`, never adopts production storage or a production host, and does
not register `uterm://`. UI-only focus, temporary view selection and composition state remain client
owned. Persisted drafts and sessions cannot be replaced by an empty native view.

生产、旧开发和原生 QA 身份完全分离；QA 不接管生产存储、宿主或链接协议。临时焦点和输入法状态属于客户端，已有草稿与会话不能被原生空视图覆盖。

At the baseline, `Sessions::host_executable` staged the Tauri executable. The current implementation
uses `crates/uterm-core/src/host.rs` for staging and retains compatible active versions.
`crates/utermd-local/src/bin/utermd-local.rs` dispatches `--local-daemon`, `--local-task`,
`--agent-report`, SSH askpass and `--control`; the native package bundles this Rust executable, not
the Swift UI binary, as its helper. `daemon.rs`, `tasks.rs` and `activity_bridge.rs` retain PTY/task
lifetime, replay and hook ownership. Clients detach on quit; explicit session close terminates only
the specified generation.

基线使用 Tauri 程序作为宿主，当前由共享 Rust 模块暂存并保留兼容活跃版本。独立 helper 承担上述命令入口，Swift
UI 程序不作为 Rust 宿主。PTY、任务、回放及 hooks 保持既有归属，退出仅断连，明确关闭只终止指定 generation。

Concrete source boundaries are
`src-tauri/src/{files,git,ssh,ssh_auth,ssh_tunnels,java,python,database,redis}.rs`,
`src/lib/{workspace,settings,file-document,useFileDocument}.ts` and the corresponding React views.
`src/lib/shared-state.ts` exports the WebView-owned keys and freezes workspace/settings writes only
after successful import. `crates/uterm-core/src/store.rs` retains `legacy-original.json`,
`snapshot-v1.json` and up to eight `backups`; legacy `.backup`/`.invalid` and schema-version backups
remain in the original WebView storage. Editor draft recovery stays in `file-document.ts` until M3;
database edit drafts remain transient UI state.
`src-tauri/src/{ssh_auth,redis_credentials,database}.rs` handle credential adapters; credentials
must not be added to migrated JSON. The baseline inventory records exact IPC/storage source paths
and declaration lines without containing user data.

上述源码路径明确文件、Git、远程连接、任务与数据服务边界；WebView 导出后由共享存储保存原始数据、快照及备份。原 WebView 恢复键保留，编辑器草稿在 M3 前保持原路径，数据库编辑草稿仍为临时界面状态。凭据通过平台适配，不进入迁移 JSON；基线清单只记录源码声明，不含用户数据。

## Contract draft / 契约草案

- Versioned control envelopes carry an operation ID, method and parameters. Replies retain the ID
  and either a result or a structured error. Unknown versions/methods fail explicitly.
- Snapshot revisions detect stale writes; migration tokens detect re-entry. `null`, absent fields,
  empty strings and collections keep their existing meanings. Rust DTOs will generate TS/Swift
  boundary types and CI will check drift.
- Operations run off the UI thread. Cancellation targets an operation, not a session. Closing the
  client drains callbacks and detaches streams; only an explicit close-session request kills a PTY.
- Terminal output is a separate binary channel: original bytes, generation, sequence and ordered
  acknowledgement. Ack follows consumption; bounded replay/backpressure are not replaced with
  JSON/Base64. Late events must not update a different generation or newer snapshot.
- C ABI buffers have explicit lengths and one free function; callbacks document their thread and
  lifetime. Rust panics must be caught before the C boundary. Swift publishes state on its main
  actor.

控制消息带版本及操作 ID；错误、取消和关闭均有明确边界。快照 revision 保护写入，终端原始字节独立传输，不增加 Base64。C
ABI 明确所有权与回调线程，Rust panic 不跨语言，Swift 在主线程更新界面。

## Stage status and evidence / 阶段状态与证据

| Stage / 阶段 | Current state / 当前状态                                                            | Evidence and next work / 证据与下一步                                                                            |
| ------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| M0           | CI verified / CI 已验证                                                             | Both native architectures and legacy Tauri jobs passed                                                           |
| M1           | Implemented; platform CI passed, acceptance gaps / 已实现，平台 CI 通过，验收未闭合 | Shared validation, canonical storage, FFI, generated contracts and legacy client adoption                        |
| M2           | In progress / 开发中                                                                | Real host, shared session operations and native terminal in development / 真实宿主、共享会话操作及原生终端开发中 |
| M3           | Pending / 待实现                                                                    | Files, Git, SSH and task workflows, one at a time                                                                |
| M4           | Pending / 待实现                                                                    | Remaining capabilities, native interaction and measurements                                                      |
| M5           | Pending / 待实现                                                                    | Candidate packaging, signed update and rollback exercises                                                        |

Linux cloud has Node 26.13.0 and Rust 1.99.1, and has no Swift/Xcode or interactive Mac. The
baseline file tree passed 343 frontend tests (ten skipped), 59 host tests (three ignored), 150
backend tests (ten ignored), production and Linux desktop builds in the previous task. That evidence
is tied to the baseline tree, not new native code. M0 CI records PR head separately from the tested
merge SHA, macOS/Xcode/Swift versions, startup logs and the ad-hoc-signed QA App on Apple Silicon
and Intel. Native interaction and performance have not been measured. A graphical smoke is not human
acceptance.

云端不是 macOS。既有检查只证明基线文件树；原生代码必须经过新 CI。CI 区分 PR
head 与实际测试合并 SHA，并保存工具链、启动结果和 QA
App。原生交互及性能仍未测量，图形启动冒烟不等同人工验收。

### M0 evidence / M0 证据

Commit `3b362bd163d9bb5cec4336523f204b304b7df967` passed native workflow
[41389663733](https://github.com/YondFane/uTerm/actions/runs/41389663733) on ARM and Intel. Both
opened a visible window with one screen and exited with code 0. The tested merge SHA was
`7249babf2eb79bfca7bea7ed6a85190b1b3e2938`. Xcode 16.4/Swift 6.1.2 ran on macOS 15.8.2 ARM and
15.7.9 Intel. Legacy Tauri workflow
[41389663452](https://github.com/YondFane/uTerm/actions/runs/41389663452) passed macOS and Windows.

上述提交的两种原生架构均完成真实窗口启动并正常退出；旧 Tauri 的 macOS／Windows 检查也通过。源码 SHA、测试合并 SHA 与工具链分别记录；不代表人工交互或性能验收。

### M1 data and ABI / M1 数据与 ABI

The Tauri bootstrap imports normalized legacy workspace/settings and opaque raw auxiliary keys. Rust
owns schema 1, SHA-256 revisions, an exclusive writer lease, atomic replacement, the immutable
original export and eight prior snapshots. Re-import returns existing newer data for the same source
token; a different source fails. Corrupt data is never silently replaced. Recovery verifies the
current digest and backup digest and preserves damaged bytes. Writes complete before UI publication;
quit waits for the save queue. A stale writer must explicitly reload, retaining its draft.

Tauri 启动时导出规范化旧数据和原始辅助键，Rust 管理 schema、revision、单写者、原子写入及备份。重复迁移不会覆盖后续修改，损坏数据不会自动重置。恢复前核对当前及备份摘要并保留损坏字节；保存完成后才发布界面状态，退出等待队列。冲突需明确重载，草稿保留。

C ABI 1 uses borrowed input spans, owned async copies and allocation IDs for idempotent buffer
release. Worker replies and local snapshot invalidations retain operation IDs. Subscription
callbacks borrow bytes only for their invocation; synchronous events run on the calling thread.
Close drains operations and callbacks. Do not synchronously call, subscribe or close from a
callback; enqueue after return. Cancellation skips work not started and suppresses pending delivery;
it does not roll back a committed write or interrupt a callback already executing. Events are local
to the handle; external writers are detected by revision checks. Consumers reload the current
snapshot on invalidation instead of ordering hash strings. Terminal transport is not routed through
JSON FFI.

C
ABI 明确输入、异步副本、分配 ID 和回调生命周期，关闭等待操作与回调结束。回调内不能同步重入，应排队执行。取消不撤销已提交写入，也不打断正在执行的回调。事件仅作用于当前句柄，其他写者通过 revision 检测；收到失效事件后读取当前快照，不按哈希字符串排序。终端字节不通过 JSON
FFI。

Rust DTOs generate checked-in TS/Swift types with `pnpm contracts:generate`; CI runs
`pnpm contracts:check`. `pnpm test:core` exercises storage and C ABI. `tests/core-contract.test.mjs`
executes a real Rust process and compares legacy defaults, settings boundaries and selection/project
transitions. `scripts/macos-native-test.sh` links the Rust static library and exercises Swift calls,
events, stale writes and reopening. M1 native ARM/Intel CI passed for head
`4ffa97c08809a3761880b6374ccc5b8a58c1ccce`, tested merge `7a4fa0f0e87bea35f549e79a3ab21801c9807c78`:
[run 41393862162](https://github.com/YondFane/uTerm/actions/runs/41393862162). Artifacts:
[ARM](https://github.com/YondFane/uTerm/actions/runs/41393862162/artifacts/13118805408) and
[Intel](https://github.com/YondFane/uTerm/actions/runs/41393862162/artifacts/13118363170), named
`native-qa-macos-15-4ffa97c08809a3761880b6374ccc5b8a58c1ccce` and
`native-qa-macos-15-intel-4ffa97c08809a3761880b6374ccc5b8a58c1ccce`. Each contains toolchain,
core/FFI/Swift logs, window report and QA App. These M1 artifacts contain no terminal screenshots.
Legacy [run 41393862160](https://github.com/YondFane/uTerm/actions/runs/41393862160) passed both
platform jobs. Many existing session/layout reducers still live in TS; removal requires
corresponding shared operations and dual-client acceptance. Auxiliary drafts remain on their
original path until M3.

类型由 Rust
DTO 生成并检查漂移；兼容测试运行真实 Rust 进程。Swift 测试覆盖调用、事件、过期写入及重开，M1 双架构及旧客户端 CI 已通过上述对应 SHA；产物含报告和 QA
App，不含终端截图。会话／布局的既有 TS
reducer 尚未全部替代，必须补齐共享操作和双端验收后删除；辅助草稿在 M3 前继续使用原路径。

## Development commands / 开发命令

Linux M1 checks passed: ten storage tests, four C ABI tests, three real-process
compatibility/adapter tests, 345 existing frontend checks (ten skipped), 150 backend tests (ten
ignored), host tests, TypeScript, production and Linux desktop builds, formatting, translation
coverage and documentation checks. The full frontend run predates the third adapter test; that test
ran separately against the same application code. M1 macOS bridge and Windows automated checks
subsequently passed as linked above; native recovery interaction remains pending.

Linux 的上述检查使用临时目录和测试数据，没有接管真实会话。完整前端检查之后新增的第三项适配测试单独通过，应用代码一致。M1
macOS 桥接及 Windows 自动检查随后通过，原生恢复交互仍待验收。

On a Mac with Xcode 16.4 selected, run `bash scripts/macos-native-build.sh`, then
`bash scripts/macos-native-smoke.sh` from the repository. The latter requires an actual logged-in
GUI session and WindowServer and fails when unavailable. The QA binary opens an actual native
window, records visibility and screen information, requests normal termination, and the harness
verifies its exit code. It starts no host, loads no production data and has no simulated sessions.

在选定 Xcode
16.4 的 Mac 上运行上述脚本。启动冒烟要求真实图形会话，缺失时失败；程序创建实际窗口并正常退出，由脚本检查退出码。M0 不启动宿主、不读取生产数据、不构造虚假会话。

## Issue alignment / Issue 对齐

Continue branch `feat/native-macos-shared-core` and Draft PR
[#12](https://github.com/YondFane/uTerm/pull/12). Tracking
[#13](https://github.com/YondFane/uTerm/issues/13) and all acceptance criteria remain authoritative.
Do not merge, tag, publish or modify `release`/`main` directly. YondFane is the authenticated
executor; only active M2 tasks #29–#32 are assigned and claimed. No project/status labels are
invented.

沿用当前分支和 Draft
PR；总跟踪与原验收标准不变。本轮只认领正在处理的 M2 任务，不合并、不发版、不直接修改受保护目标分支。

| Stage / 阶段 | Issues / 任务 | Existing implementation and gaps / 既有实现与缺口                                                                                                                                                                                                                                                                                       |
| ------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 #14       | #20–#23       | Baseline inventory, QA App and both CI paths exist. Archive earlier evidence; screenshot and repeatable workload/interaction checklist still need completion. / 基线清单、QA App 和两条 CI 已存在，优先归档；截图与可重复负载／交互清单待补。                                                                                           |
| M1 #15       | #24–#28       | Shared state, import/recovery, C ABI and Swift/Tauri adapters exist. Old-reader export, additional failure modes and native recovery interaction remain. / 共享状态、迁移恢复、FFI 及双端适配已存在，旧读取器导出、补充失败模式及原生恢复交互待补。                                                                                     |
| M2 #16       | #29–#32       | Active: shared host/helper, native shell, cached SwiftTerm views, binary sequence/ack and split/reconnect. New source requires native/Windows CI and screenshots. Manual IME/Agent TUI/sleep acceptance remains unavailable. / 正在实现共享宿主、原生外壳、缓存终端、二进制确认及分屏重连；本次源码待平台 CI 与截图，人工验收尚无条件。 |
| M3 #17       | #33–#37       | Existing Tauri services remain; native/shared adoption not yet complete. / 保留既有 Tauri 服务，原生与共享迁移未完成。                                                                                                                                                                                                                  |
| M4 #18       | #38–#43       | Basic native settings are partial groundwork only; full capability, interaction and measurement gates remain. / 基础原生设置仅为部分前置实现，完整功能、交互与测量未完成。                                                                                                                                                              |
| M5 #19       | #44–#47       | QA App is ad-hoc signed, not a release candidate acceptance. Signed updates, actual upgrade/rollback and formal signing/notarization remain. / QA App 临时签名不等于候选验收，更新、实际升级回退及正式签名公证待完成。                                                                                                                  |

### M2 implementation and verification / M2 实现与验证

The same Rust host broker and link registry now serve Tauri and the native bridge. The helper is
staged outside the read-only bundle by digest; active compatible hosts retain their executable. The
standalone executable also owns the existing control CLI entry. Shared session operations use the
canonical revision, including split layout, selection and removal. SwiftTerm 1.20.0 fits the
selected Xcode 16.4 toolchain; the current latest SwiftTerm requires a newer Swift tools version. No
renderer performance improvement is claimed.

Tauri 与原生桥接复用宿主管理和连接注册表。helper 按摘要暂存到包外，兼容的活动宿主保留原执行文件；独立程序复用 control
CLI。会话／分屏使用规范 revision。SwiftTerm 版本按工具链兼容选择，不宣称性能改善。

The native harness opens two real PTYs, verifies Unicode/ANSI and alternate-screen return, checks
cached view identity, hides/reopens the window, records language/theme/width screenshots, then
quits. A second process reconnects to the same generations, replays output and explicitly closes the
test sessions. All data lives under a private temporary QA root. Screenshots and reports are
uploaded by the native workflow, with source head and tested merge SHA in `toolchain.txt`. Until
that run passes, this is an implemented harness, not completed acceptance.

原生脚本实现真实双 PTY、视图保留、隐藏重开、双语／主题／宽度截图及第二进程重连关闭。数据隔离在临时 QA 目录，工作流上传截图、报告及两种 SHA；CI 实际通过前，不将脚本存在视为验收完成。

Rust and TypeScript share numeric fixtures covering 0, 2^53−1, 2^53, 2^53+1 and u64::MAX. Swift
checks exact `UInt64` decoding and decimal acknowledgement encoding. TypeScript currently rejects
unsafe values; full-range support is still open. Multi-client input/resize arbitration, manual input
methods, real Agent TUI, copy/paste, sleep and multiple displays remain acceptance gaps.

三种语言共用数值边界样例。Swift 需验证逐位精确解码／确认；TypeScript 超范围明确拒绝，完整范围支持仍开放。多客户端输入／尺寸仲裁及人工交互仍有缺口。

Local M2 validation on Linux x86_64 (Node 26.13.0, Rust 1.99.1) passed 347 frontend tests with ten
skipped, 148 backend tests with ten ignored (two terminal tests moved into the shared core), 16 core
tests and four FFI tests. Production build, generated-contract drift, formatting, i18n and
documentation checks passed. Host tests and Linux desktop compilation run separately; their logs
must be checked before recording success. Native Swift compilation and screenshots still await this
branch's new macOS CI.

本地上述结果只覆盖 Linux；迁移到共享核心的测试保留，未将数量减少解释为删减验收。宿主测试、新 control
CLI 测试及桌面编译也已通过，Swift 编译及截图待新 CI。

M2 head `9449c3e1881f28b5172ee8ebfef90fca26da447d`: legacy Windows/macOS
[41407004301](https://github.com/YondFane/uTerm/actions/runs/41407004301) passed. Native
[41407004364](https://github.com/YondFane/uTerm/actions/runs/41407004364) failed at Swift
compilation; its archived baseline/toolchain/dependency files are evidence of that failure, not
runtime screenshots. The next correction exposes the bridge error initializer, uses the SwiftTerm
delegate contract and observes window focus without overriding a non-open third-party method.
`Package.resolved` is taken from this real CI resolution and subsequent builds enforce it.

上述 M2 提交的旧客户端 CI 通过，原生编译失败，未执行原生运行。修复桥接访问权限、委托契约及焦点接入；依赖锁来自真实 CI，后续构建强制使用锁定版本。

Legacy CI retains its original `release` PR/push and manual triggers, commands and independent Cargo
workspaces. Its `legacy-checks-<runner>-<head>` artifact now collects source/toolchain records,
core/FFI/contract, host, frontend, backend, docs, formatting and desktop-build logs even on failure.
Explicit Bash steps retain pipe failure handling on both Windows and macOS. These artifacts prove
commands and compilation; they contain no native interaction screenshots or installer acceptance.

旧客户端 CI 保留原分支触发、命令及 Cargo 隔离；新增 artifacts 保存两种 SHA、工具链及各检查日志，失败也上传。Windows 与 macOS 使用显式 Bash 管道失败检查，报告不冒充原生交互或安装验收。

At head `1d54ee1d62892c29ac4392c76752960e9548b74e`, native ARM
[41408360042](https://github.com/YondFane/uTerm/actions/runs/41408360042) built successfully and
passed 16 core, four FFI and five Swift tests. The real window report records ready state and one
screen but the process timed out on termination: not a passed smoke. Termination is changed to
cancel the initial synchronous request, drain work asynchronously, then request final termination. A
timeout now captures a process sample before cleanup. Legacy Windows
[41408360035](https://github.com/YondFane/uTerm/actions/runs/41408360035) failed because the
existing slow-start fixture did not reach its ready marker; the next run bounds Rust test
parallelism to four without removing the responsiveness assertion. These failed runs remain part of
the evidence.

上述提交的 ARM 构建及核心／桥接测试通过，真实窗口可见但退出超时，不能标为 smoke 通过；修正退出流程并增加超时进程采样。Windows 既有慢启动样例未达到 ready，下一轮限定并发且保留响应性断言，保留失败证据。

### Export compatibility and recovery boundary / 导出兼容与恢复边界

`tests/core-contract.test.mjs` now sends legacy keys through a real Rust process, creates a split,
changes settings, exports current values and passes them into `readWorkspace`/`readSettings`. Both
reader source files are unchanged from `origin/release`;
`git diff --quiet origin/release -- src/lib/workspace.ts src/lib/settings.ts` confirms the target.
Four focused tests passed on Linux with
`node --experimental-strip-types --test tests/core-contract.test.mjs`. The new export case checks
IDs, layout, selection, settings, original draft/invalid/backup bytes and repeat import. Platform CI
for this added test is pending; its frontend log will be archived by the legacy workflow.

真实 Rust 导出已交给未修改的 release 读取器，本地四项专项检查通过；新增测试覆盖 ID、布局、选中项、设置、辅助恢复字节及重复导入。新增测试的平台结果待 CI，不沿用旧提交。

The data formats are canonical document schema 1 containing workspace schema 7 and settings schema
1; legacy export is `{revision, values}`, where each `values` entry is the original WebView key and
its string value. Workspace/settings strings reflect the current snapshot; auxiliary strings remain
unchanged. `shared/fixtures/legacy-state.json` provides repeatable normalized defaults without user
data. The process test constructs both old source values and an updated split/session example.

规范文档 schema 1 包含工作区 schema 7 与设置 schema 1；导出为
`{revision, values}`，values 保留键名和字符串值，主状态反映当前快照，辅助值保持原样。默认值及更新后分屏样例可由测试重复构造，不含用户数据。

For recovery, keep the original WebView data and the canonical directory (including
`legacy-original.json`, `snapshot-v1.json` and `backups`) before attempting a client replacement.
Stop client writes and export the latest canonical state first; quitting detaches rather than kills
the host. Verify an exported JSON file with the old readers before using it in any isolated old QA
client. Restoring only an old executable does not restore post-migration settings or drafts. An
automatic WebView import or tested install-level downgrade is not supplied by this format test; keep
the prior data copy and use the current recovery UI if the snapshot is corrupt. Do not overwrite the
canonical copy or resume two authoritative clients during recovery. Credential stores remain
platform-owned and are not part of the JSON export. Actual installation replacement, host retention
and full data rollback remain #46; native recovery interaction and dependency acceptance keep #28
open.

恢复前保留旧 WebView 数据及整个规范目录，停止客户端写入并导出最新状态；退出只断连宿主。导出先经旧读取器校验，再用于隔离旧 QA。仅替换旧程序不能恢复迁移后的设置或草稿。格式测试未提供自动 WebView 导入或安装级降级验收；保留先前副本，损坏快照使用当前恢复界面，不覆盖规范副本或同时运行两个权威写者。凭据仍由系统管理。实际安装替换、宿主保留和完整回退属于 #46；原生恢复及依赖未验收前 #28 保持开放。

Head `b57954302207490e0125d1e95023fa5edbe3318f` native ARM passed normal window termination, but
real PTY smoke failed while inspecting Unicode text. The QA text reader used raw cells, including
wide-character padding, and omitted SwiftTerm's combining-character provider. It now uses both
renderer APIs and a focused parser test covering color, Unicode, alternate screen and input-mode
toggles. This test does not establish actual IME, clipboard or mouse interaction. The smoke creates
a real temporary project, captures terminal diagnostics on failure and closes only its isolated host
sessions in cleanup. New native verification remains pending.

该提交的 ARM 退出冒烟已通过，真实 PTY
Unicode 检查失败；修正文本采集并增加解析器检查，不将模式解析当输入法／剪贴板／鼠标交互。脚本使用临时项目，失败记录终端诊断，结束清理自身隔离宿主，仍待新原生验证。

The Windows slow-start fixture failed again with bounded parallelism. The test now compiles a tiny
native disposable probe with the active Rust toolchain before measuring startup, avoiding a
PowerShell cold start inside the two-second capability-probe budget. It still opens an actual Agent
process, waits for the marker inside the five-second probe and checks concurrent HostStatus within
one second, then explicitly closes that generation. This fixture change needs Windows verification;
no production probe timeout or responsiveness assertion was relaxed.

Windows 在限定并发后仍复现同步失败；测试先编译小型原生探测样例，保留真实进程、慢探测、1 秒状态响应及明确关闭，不放宽生产超时或验收断言，等待 Windows 结果。
