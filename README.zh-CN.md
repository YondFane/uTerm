<p align="center">
  <img src="site/icon.svg" width="64" height="64" alt="uTerm" />
</p>

# uTerm

**终端、Agent，回到项目里。**

面向 Windows 与 macOS 的项目式终端工作台，集中管理编程 Agent、Git
Worktree 与远程开发。让终端、代码、运行任务和数据连接，留在所属项目身边。

**[下载 uTerm](https://yondfane.github.io/uTerm/?lang=zh-CN#download)** ·
[探索官网](https://yondfane.github.io/uTerm/?lang=zh-CN) · [English](README.md) ·
[功能指南](docs/features.zh-CN.md)

![Windows 上的 uTerm：示例项目、并排终端、Git 更改和 Worktree](site/media/workspace.png)

_真实 Windows 工作区，使用临时示例项目和真实本地 Shell 会话。_

[下载](#下载) · [快速开始](#快速开始) · [工作流](#可以做什么) · [命令安装](#一行命令安装) ·
[开发](#开发) · [许可与反馈](#许可与反馈)

## 下载

| 你的设备            | 安装包                                                                        |
| ------------------- | ----------------------------------------------------------------------------- |
| Windows x64         | [Windows · .exe](https://yondfane.github.io/uTerm/?lang=zh-CN#download)       |
| macOS Apple Silicon | [Apple Silicon · .dmg](https://yondfane.github.io/uTerm/?lang=zh-CN#download) |
| macOS Intel         | [Intel · .dmg](https://yondfane.github.io/uTerm/?lang=zh-CN#download)         |

官网会查找最新稳定版中匹配的安装包，也可以在
[GitHub Releases](https://github.com/YondFane/uTerm/releases/latest)
手动选择。桌面安装包无需 Node.js 或 Rust；下载需要访问 GitHub。

macOS 安装包未经 Apple 公证，首次启动可能需要在**系统设置 → 隐私与安全**中批准。Windows 按安装向导提示操作。

## 快速开始

1. **添加项目**。打开 uTerm，选择**添加项目**并选取本地文件夹。已有 Git
   Worktree 会显示在所属项目下。
2. **打开会话**。启动终端，或在**设置 → Agent**中启用已安装的 Agent
   CLI。右击会话，选择**与……分组**，即可分屏工作。各 Agent CLI 使用自己的登录认证。
3. **运行与检查**。从项目菜单或工具栏打开 **Java 构建与运行**或
   **Python 运行**。在底部面板查看输出，在 **Git** 中检查代码变更。

退出应用会分离窗口，本地会话仍继续运行。再次打开即可重新连接；**关闭会话**才会终止所选进程。

Agent 的安装、配置、Hooks 和通知都在**设置 → Agent**中。参见
[Agent 配置](docs/features.zh-CN.md#agent-与设置)、 [TRAE CLI](docs/features.zh-CN.md#trae-cli) 和
[无需 Hooks 的通知](docs/features.zh-CN.md#无需-hooks-的通知)。

## 可以做什么

| 把工作放在一起   | 在 uTerm 中                                                                           |
| ---------------- | ------------------------------------------------------------------------------------- |
| **项目与 Agent** | 按工作区、项目和 Git Worktree 组织终端与 Agent，分屏处理并行任务。                    |
| **构建与运行**   | 用 Maven 构建 Java，运行 Java/Python 项目，查看可搜索日志，停止或重新启动任务。       |
| **文件与 Git**   | 查看差异与提交，编辑文件时保留冲突检查和草稿恢复，预览 Markdown 与 PDF。              |
| **远程与数据**   | 打开 SSH/SFTP，浏览 Redis，查询 MySQL、PostgreSQL、Oracle、Elasticsearch 和 MongoDB。 |

**Java 和 Python 保留各自的项目上下文**。切换项目时，对应配置和日志会一同切换。右击工具栏图标可选择已启动任务；侧栏彩色 Java/Python 图标标识正在运行的项目。

- **Java**：Maven 构建、Spring Boot 开发运行和 JAR 启动，按需安装完整 JDK 8/11/17/21 与 Maven。
  [Java 与 Maven 指南](docs/features.zh-CN.md#java-与-maven-构建)。
- **Python**：使用自己的 Python
  3 或虚拟环境，运行脚本、模块、FastAPI、Flask 和 Django。Python 与项目依赖需单独准备。[Python 与日志指南](docs/features.zh-CN.md#python-项目与日志)。

界面支持简体中文与英文、六种配色、可配置字体和快捷键。数据工具默认只读，按需开启受保护的编辑。SQL 与 MongoDB 需要 Java
17+ 和所选驱动，可在应用内按需管理；Elasticsearch 无需额外运行时。

使用方法、限制与平台验证详见[完整功能指南](docs/features.zh-CN.md)。

### 看看工作流程

[打开五步工作区导览](https://yondfane.github.io/uTerm/media/tour.html?lang=zh-CN) ·
[观看 30 秒导览](site/media/workflow.mp4)

导览为上方真实 Windows 截图添加标注，属于截图导览，并非连续录屏，不展示模型请求或远程服务器连接。
[素材说明](site/media/README.md)。

## 一行命令安装

macOS · 终端：

```sh
curl -fsSL https://raw.githubusercontent.com/YondFane/uTerm/release/scripts/install/install.sh | bash
```

Windows x64 · PowerShell：

```powershell
irm https://raw.githubusercontent.com/YondFane/uTerm/release/scripts/install/install.ps1 | iex
```

已安装 Node.js 22.13 或以上：

```sh
npx @yondfane/uterm-install
```

也可以使用 `pnpm dlx @yondfane/uterm-install` 启动桌面安装器。全局安装 npm 包只管理 `uterm-install`
命令，不会安装或卸载桌面应用。使用 `uterm-install --help` 查看选项。

macOS 脚本安装至
`~/Applications/uTerm.app`，无需 sudo，也不会自动启动应用。已有安装会被保留，请使用应用内更新。下载支持有限重试；稳定版源提供大小和 SHA-256 时可校验并复用缓存。
[安装器说明](docs/features.zh-CN.md#一行命令安装)。

## 开发

基于 **Tauri · React · TypeScript · Rust · xterm.js**，使用 WebGL 渲染终端。

环境配置、命令、仓库布局、验证和发布步骤见[开发指南](docs/development.zh-CN.md)。贡献时请遵循
[AGENTS.md](AGENTS.md)
和[文档编写规范](docs/writing-rules.md)，使用项目的Prettier/rustfmt，提交前运行 `pnpm format` 与
`pnpm format:check`。

## 许可与反馈

uTerm 按 [PolyForm Noncommercial License 1.0.0](LICENSE)
提供源码，在其允许范围内免费使用。超出许可已允许范围的商业用途需另行获得书面授权；条款和授权联系方式见
[NOTICE](NOTICE)。第三方组件保留各自许可。

[报告问题或提出功能建议](https://github.com/YondFane/uTerm/issues/new)，请附上操作系统、uTerm 版本及复现步骤。

macOS 原生客户端开发与稳定发布隔离。QA 应用、平台检查和分阶段功能状态见[原生迁移说明](docs/native-migration.md)。

共享核心检查使用 `pnpm test:core` 和 `pnpm contracts:check`。共享 Java 任务检查需要 JDK 21（设置
`JAVA_HOME` 并将其 `bin` 加入 `PATH`）；应用构建仍不要求或捆绑 JDK。`uterm-core::{java,python}`
管理共用运行配置及任务规则，Tauri 提供平台适配，生成的 DTO 保持 Swift／TypeScript 边界一致。执行
`pnpm contracts:generate` 重新生成 TS／Swift 边界类型。macOS 上使用
`bash scripts/macos-native-build.sh` 和 `bash scripts/macos-native-test.sh`
构建隔离 QA 应用并运行 Rust／Swift 桥接测试。

`pnpm settings:generate` 从现有 TypeScript 设置和文案生成原生命令／主题目录， `pnpm settings:check`
核对目录；契约生成／检查已包含该目录。Core `settings.catalog` 和 `settings.validate`
读取默认值并校验平台快捷键，不保存配置；完整原生设置／菜单／开机启动仍在 #41 跟踪。

共享 Agent 规则位于 `uterm-core::{agents,agent_install}`，Pi 扩展位于
`crates/uterm-core/integrations/`。`bash scripts/macos-agent-smoke.sh`
需要 macOS 图形会话及 QA 构建；记录真实窗口／Host／已安装报告程序证据，系统通知适配器明确使用模拟，不使用提供方凭据或全局安装 CLI。

内嵌 Java 8 编码 Agent 同时提供 Java 源码和可复现的运行时字节。修改后使用 JDK 21 运行
`python3 scripts/java8-encoding-agent.py`，再执行
`python3 scripts/java8-encoding-agent.py --check`。正常 Rust／应用构建不需要 Java 编译器；Windows 互操作 CI 核对资产并运行实际所选 JDK。

原生终端 QA：`bash scripts/macos-terminal-smoke.sh`
使用临时数据及包内独立 helper，运行两个真实应用进程并保存双语／主题／宽度截图产物。还会启动系统 Vim，通过原生终端动作输入及粘贴 Unicode，核对保存文件的 UTF-8 字节并记录真实 TUI 窗口，不替代人工输入法验收。SwiftPM 解析固定的 SwiftTerm
1.20.0 依赖，不改变旧终端渲染器。

共享核心检查会明确执行文件系统失败案例。Unix 需以普通用户运行以便目录权限生效；Windows 使用文件占用租约验证替换失败。

原生并存控制 QA：`bash scripts/macos-input-control-smoke.sh`
让两个隔离原生应用进程连接同一会话，操作接管按钮及只读输入／resize 保护，记录对应源码的报告和四张真实窗口截图。人工键盘、输入法和系统剪贴板验收单独保留。

原生 Java QA：通过**文件 →
Java 构建与运行…**使用共享 Maven／JDK 配置、构建／运行操作与任务日志。`bash scripts/macos-java-smoke.sh`
需要 JDK
21 和 macOS 图形会话，编译隔离 JAR 并记录真实配置／任务／窗口证据。选择器／键盘验收和完整 Maven 工作流与脚本冒烟分别核对。Windows 启动器互操作 CI 使用 JDK
8／11／17／21 验证实际共享宿主。宿主与 Tauri 程序共用 `shared/windows/application.manifest`
提供进程 UTF-8；Unicode
Java 步骤在子进程中使用所选 JDK 自身启动器。平台执行、编译及完整 Maven／人工验收分开记录。

可选真实 Maven QA 在临时项目中使用 Maven 3.9.9 和 Spring Boot 2.7.18。设置
`JAVA_HOME`、`UTERM_MAVEN_HOME` 及可选的 `UTERM_MAVEN_REPOSITORY`，然后执行：

```sh
cargo test --locked --manifest-path crates/uterm-core/Cargo.toml --test host \
  real_maven_reactor_and_spring_boot_use_shared_task_lifetimes -- --ignored --nocapture
```

此显式测试会下载 Maven Central 依赖，所选仓库已有缓存时复用。设置 `UTERM_MAVEN_CORE_REPORT`
可保存源码／平台报告。Maven 互操作 CI 运行 Windows JDK8／11／17／21 及原生 macOS ARM／Intel
JDK21，与 Unicode 启动器及 GUI 验收分开。默认测试套件不下载 Maven 依赖。

原生 Python QA：选择本地项目或 Worktree 后使用**文件 → Python 运行…**。原生表单调用共享 Rust
Python 服务及原始任务输出通道。在 macOS 图形会话运行
`bash scripts/macos-python-smoke.sh`，使用隔离配置和真实进程检查配置冲突、输出、分离／回放、搜索／跟随、停止及重新运行，并保存截图。需要已有 Python
3，不安装 Python 或依赖包；实际平台执行结果单独记录于功能指南。

macOS 桥接测试通过 `macos/Tests/UTermTestSupport` 检查实际原生文件锁，该 C 辅助模块仅链接到测试。

`uterm-core::redis`
共享连接／凭据、TLS／SSH、二进制数据、TTL 和受保护写入规则；Tauri 命令保持既有接口及原生 CA 选择器。Core
JSON 桥接提供异步操作、有界结果、配置 CAS 及退出／恢复保护。隔离原生应用从侧栏“Redis 连接”或**文件 →
Redis 连接…**打开工作台，平台验收仍由 #39 跟踪。 `bash scripts/macos-redis-smoke.sh`
需要 macOS 图形会话、Homebrew 和 Python
3；缺少 Redis 时安装该工具，使用私有临时回环服务检查真实窗口／写入及截图，不注册系统服务。PATH 中有支持 TLS 的
`redis-server` 和 `openssl` 时运行 `pnpm test:redis`，测试使用临时回环服务；另有 `redis-cli`
时可运行 `node scripts/redis-core-smoke.mjs /绝对路径/临时证据目录` 生成来源绑定报告。共享 Redis
CI 构建经校验的 Redis 7.4.7 并上传证据。

`cargo test --locked --manifest-path crates/uterm-core/Cargo.toml --test credentials`
在 macOS／Windows 检查真实 OS 凭据查询、二进制替换、相邻条目隔离及删除。它需要访问测试用户的凭据库，仅使用唯一 QA 服务／引用名称并清理自己的记录。Linux 运行零项 OS 场景。Redis 窗口 QA 还检查 20,001 项有界分页、401 项可编辑列表、确认删除／TTL、取消应用退出及保存引用认证；各平台运行结果分别记录。

`uterm-core::{database,database_components,downloads}`
共享数据库业务、凭据绑定和组件安装／续传规则。客户端提供目录、SSH 确认、选择器和事件；Tauri 的既有数据库命令及退出保护保留。隔离原生应用可从侧栏“数据库”或**文件 → 数据库…**打开共用 SQL／文档表单和工作台，使用 Core 配置 CAS 与应用生命周期内的临时密码；验收按 #38 单独记录。
`bash scripts/macos-database-smoke.sh` 需要 macOS 图形会话、Homebrew、Python 3、curl 和 Java
17+；缺少 PostgreSQL
16 时安装该工具，下载目录校验的 JDBC 驱动，使用私有临时数据／凭据检查真实 SQL 窗口并截图，不注册 PostgreSQL 系统服务或访问生产数据库。

`uterm-core::ssh`
管理 OpenSSH 配置／路径规则、凭据绑定／系统适配、SFTP／传输服务及所属隧道生命周期。Tauri 委派相同服务，保留命令、选择器和信任提示；隔离原生应用通过**文件 →
SSH 连接…**提供配置、远程终端、SFTP 和转发；新增原生／平台验收单独跟踪。
`cargo test --locked --manifest-path crates/uterm-core/Cargo.toml --lib ssh:: -- --nocapture`
包含 Unix 已认证服务测试，需要 `/usr/sbin/sshd` 与
`ssh-keygen`；使用临时密钥、known_hosts 和数据，不修改 `~/.ssh` 或系统 SSH 服务。Core CI 产物包含
`ssh-service-core.json`；Windows 真实服务及原生界面验收单独跟踪。`PYTHONDONTWRITEBYTECODE=1 python scripts/ssh-core-qa.py CORE_BINARY EVIDENCE_DIRECTORY`
运行公开 Core 真实服务检查。平台 CI 使用 Python
3.12 并增加隔离临时密码账户；Windows 下载校验摘要的固定 OpenSSH，并恢复 CI 用户的临时 SSH 别名。`PYTHONDONTWRITEBYTECODE=1 python scripts/ssh-tauri-qa.py`
为真实 Tauri
QA 提供该服务，增加配置／SFTP／远程终端截图及实际退出／重开回放验证。Tauri 包装器还会启动私有真实 Redis，验证配置／二进制／草稿／保存／重连场景，退出后核对最终文本、TTL 和二进制值。Windows 使用校验摘要的固定社区 redis-windows
8.10.3 Cygwin 便携归档，macOS 使用 Homebrew
Redis。报告和原生截图与私有凭据／配置分开上传，不安装 Redis 系统服务。两条命令均不将私有夹具数据放入产物，创建账户要求使用一次性 CI。

同一 Tauri 包装器还会启动私有 PostgreSQL 集群，验证数据库配置、精确值、事务、取消及重连，退出后核对已提交数据和自有连接清理。Windows 使用已安装的 PostgreSQL 程序（`PGBIN`
或 Program Files）；macOS 在需要时安装 Homebrew PostgreSQL 16，不启停已有数据库服务。
`python3 -B scripts/database-protocol-qa.py EVIDENCE_DIRECTORY`
下载目录校验的驱动，将 JDBC／MongoDB 协议模拟与真实 PostgreSQL 检查分开记录。这些自动检查不宣称人工选择器或交互验收通过。

`uterm-core::{files,git,worktrees}`
管理本地文件及 Git／Worktree 规则和回归，Tauri 命令委派相同函数。新增 `git.*`
契约及生成 DTO 供隔离原生 QA 应用的**文件 →
Git…**使用，Core 现统一两端已登记项目的 Worktree 列表，原生侧栏支持选择、刷新及确认删除。Core 拒绝已保存／运行会话占用、脏文件和过期写入；Git 已删目录而元数据失败须明确刷新。两端使用 Core 收藏存储，核对 revision、保留准确旧来源并明确处理来源冲突；收藏恢复界面已有平台证据，完整人工验收仍待完成。`bash scripts/macos-git-smoke.sh`
使用临时仓库，检查真实窗口的差异／历史／复制、创建分支、编辑器冲突保护及真实 Worktree 菜单确认／取消／拒删／移除、收藏持久化及执行中取消保护，还通过独立 Rust 持锁进程确定性检查争用、一次明确重读与收藏字节不变，并保存系统截图；需要 macOS 图形会话，平台验收单独记录。核心锁定依赖包含现有 base64 解码器及遵循忽略规则的文件遍历器，原生文件／内容界面验收单独记录于迁移指南。

原生 QA 构建还执行
`pnpm build`，打包共用 Web 内容及许可声明；请先安装锁定的 pnpm 依赖。`bash scripts/macos-content-smoke.sh`
检查只读 CodeMirror／HTML／PDF 及资源边界。选择本地项目后，**文件 → 打开文件…**现通过共用编辑器及 Rust 草稿队列编辑文本。`bash scripts/macos-editor-smoke.sh`
检查真实原生编辑、草稿持久化后的 SIGKILL／重启、冲突／关闭／放弃／保存，生成报告和系统截图。此脚本需要 macOS 图形会话及隔离 QA
App，使用临时文件，不代表人工键盘／输入法验收；脚本也执行恢复选择、复制／恢复副本检查。

`pnpm qa:shared-state`
构建仅 QA 特性启用的隔离 Tauri 应用（`sh.uterm.desktop.qa.sharedstate`），在真实 WebView 中执行 Git／差异／历史／分支／Worktree 登记、编辑器导入／持久草稿／SIGKILL／重开／准确保存，以及状态保存／冲突／重载／退出／恢复场景。Windows／macOS
CI 截取原生窗口，并将报告及图片上传到
`legacy-checks-*/tauri-state-qa/`。此命令需要桌面会话，拒绝覆盖已有 QA 配置。专用配置路径链接将 QA 数据导向临时目录，不覆盖主目录变量，也不使用生产配置。自动化不代表人工键盘／输入法验收。Windows 截图使用实际 QA 窗口的 Win32
PrintWindow，逐图记录方法，屏幕复制回退必须未被遮挡；`scripts/windows-window-capture.ps1`
在截图后恢复原置顶标记。

QA 还验证真实写入锁拒绝及明确重试恢复草稿，以及 Git 收藏预览／复制／过期／缺失恢复。Tauri 共用内容通过锁定的原生 clipboard-manager 插件复制，只给主窗口写文本权限，不依赖 WebView 剪贴板许可。Windows／macOS
QA 将完整原始来源与系统剪贴板核对，原生客户端使用限定范围的 NSPasteboard 调用。 JS 与 Rust 剪贴板插件须保持相同主／次版本，Tauri
CLI 会检查这组版本。

核心 `store/editor.rs`
管理核对 revision 的多文档草稿、准确旧来源副本及明确恢复。原生和 Tauri 编辑均通过
`src/lib/editor-drafts.ts`
的有界队列接入。Tauri 在 App 前初始化准确的带版本旧来源备份及明确迁移，冻结旧草稿键，并提供来源冲突／损坏副本恢复选择。原生可编辑文件现按项目组成 AppKit 标签，重复打开复用原标签；真实窗口标签检查已在 macOS
ARM／Intel 通过，持久标签／窗口顺序及完整编辑验收仍待完成，内容写入仅限所选文件。 `pnpm test:core`
明确执行工作区／草稿快照及 Worktree 删除后元数据及 Git 收藏保存／恢复的文件系统失败／重试检查。

共享回环控制服务位于
`crates/utermd-local/src/control/server.rs`，Tauri 与核心操作复用同一队列及生命周期；宿主为该服务直接声明 Tokio 和 tempfile。`pnpm test:host`
包含真实独立 CLI／socket 回归，`pnpm test:core`
检查桥接所有权及关闭；原生控制命令经共享 Rust 分发，其余原生能力继续开发中。

`pnpm test:legacy-host` 在隔离源码／目标目录中，从记录的 release
SHA 编译未修改的历史 helper，验证真实 PTY 回放、活跃进程保留及空闲升级。报告、源码／二进制摘要和日志写入
`ci-evidence/legacy-host/`，由 Windows／macOS
CI 上传；缺少基线时获取该提交，构建使用锁定依赖。这验证从历史源码编译的 helper，不代表已发布安装包升级验收。

macOS 可运行 `bash scripts/macos-control-smoke.sh`，使用真实包内 Rust
CLI、双 PTY、对话框保护及原生截图检查控制服务。在原生设置启用**允许本地 CLI 控制**，通过
`--control --data-dir PATH`
明确传入界面显示的数据目录；helper 默认配置仍指向旧客户端。Rust 使用锁定的 UUID 依赖分配 CLI 会话身份。QA 要求 WindowServer，不修改 URI 注册。
