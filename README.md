# uTerm

[English](README.en.md) · [功能说明](docs/features.zh-CN.md)

uTerm 是非商业用途免费的独立桌面终端，面向 Windows 和 macOS，使用 Tauri、React、TypeScript、Rust 和 xterm.js 构建。

## 许可与商业授权

本源码树采用 [PolyForm Noncommercial 1.0.0](LICENSE)，非商业用途及协议明确允许的其他用途免费，超出这些许可范围的商业使用须事先取得 **YondFane 的单独书面授权**。协议中的个人使用、非商业组织及合理使用条款完整保留。企业商业运营、商业分发或转售、集成商业产品及收费或托管服务，如不属于协议已允许的用途，均需另行授权。

授权申请方式及中英文说明见 [NOTICE](NOTICE)。YondFane 保留对其具有充分权利的代码自行商业化及另行授权的权利；本项目属于源码可用软件，不属于 OSI 认可的开源软件。第三方依赖及资源继续适用各自的许可。

## 功能

- 本地终端与 Agent 会话，按工作区、项目和 Git Worktree 组织。
- SSH 连接管理，复用系统 OpenSSH，提供远程终端与 SFTP 文件编辑、上传和下载。
- Redis 工作台，支持直连、TLS、SSH 隧道、Key 浏览与受控编辑。
- 分屏、键盘导航、会话链接和后台会话重连。
- 项目文件、带冲突检查和草稿恢复的文本编辑、Markdown 与 PDF 预览。
- Git 状态、差异、提交和 Worktree；GitHub Issue 与 Pull Request。
- Agent 配置、活动与用量；可配置主题、字体、快捷键，支持简体中文和英文。

退出应用只分离窗口，不终止后台会话。**关闭会话**会终止所选进程。会话服务需要认证，且只监听本机回环地址。

## SSH 使用

在侧栏“SSH 连接”点击加号，填写主机地址、端口（默认 22）和用户名，或切换到 Host 别名模式沿用 `~/.ssh/config`（Windows 为 `%USERPROFILE%\.ssh\config`）。选择自动认证、私钥文件/ssh-agent 或密码；密码可在连接窗口输入并可选保存到系统凭据库，未记住的密码重启后需重新输入。点击连接旁的加号启动 SSH 终端，点击连接名称打开远程文件；密码模式首次通过原生对话框确认主机指纹，自动/密钥模式先在终端确认。Windows 需要安装系统 OpenSSH 客户端可选功能。应用复用系统 OpenSSH，远端需启用 SFTP；密码模式暂不支持跳板机或验证码，带口令私钥用于文件/隧道前需加入 ssh-agent。详见[功能说明](docs/features.zh-CN.md#ssh-与远程文件)。

## Redis 使用

在侧栏“Redis 连接”点击加号，填写地址、端口、DB 和可选认证信息，可先测试连接。支持直连、TLS 自定义 CA/服务端名称，以及选择已有 SSH 连接建立隧道并复用其端口、用户名和认证方式。保存后点击连接名称，再点击“连接”打开工作台；默认只读，勾选“允许编辑”后可修改 String/Hash、Key 和 TTL。密码默认仅在内存中使用，可选择存入系统凭据库。应用不包含 Redis 服务端或 `redis-cli`。详见[功能说明](docs/features.zh-CN.md#redis-连接与工作台)。

## 数据库连接与可选组件

侧栏“数据库”支持 MySQL、PostgreSQL 和 Oracle（服务名连接）。点击加号配置连接，应用自动检测并优先使用可运行的本机 Java 17 或更新版本；未检测到时，可通过“安装或管理连接组件”选择本机 Java，或在线/离线安装运行时，再按需安装对应驱动。下载中断或取消后保留进度，点击“继续下载”可重试；下载源不支持续传时重新下载。连接引擎已内置，无需单独下载安装；主安装包不包含 Java 或数据库驱动。底部数据库图标默认高亮，点击可独立显示或隐藏连接区域；隐藏保留工作台和连接。组件也可在“设置 → 数据库组件”管理。详见[功能说明](docs/features.zh-CN.md#数据库连接与可选组件)。

从侧栏打开“数据库组件”会暂时隐藏项目工具面板，返回项目后恢复原来选择的工具及左右位置，侧栏底部工具栏保持原位。

工作台通过对象树浏览库／模式、表和视图。双击表打开独立的数据／结构视图，SQL 草稿及查询结果保留。对象区宽度、SQL／结果高度和结果列宽可调整，分页固定在底部；结果支持选区、带表头复制及单元格值查看。表预览使用独立只读连接，不提交或回滚 SQL 事务。三批范围与体积预算见[数据库工作台实施计划](docs/database-workbench-plan.zh-CN.md)。

内置连接引擎源码位于 `components/database/src/`，纳入版本控制的 `components/database/engine.jar` 嵌入桌面可执行文件。`components/database/catalog.json` 固定引擎校验值及可选驱动/运行时下载信息。构建主应用不需要 Java；重新构建引擎需要与校验目录一致的 JDK 26.0.2.1，运行 `pnpm database:build` 校验生成结果与内置 JAR 一致。修改源码后运行 `node scripts/database-component.mjs --record`，审核并同步提交源码、内置 JAR 及目录。临时编译产物仍位于忽略的 `components/database/target/`。`.github/workflows/database-components.yml` 手动校验内置产物，无需单独发布引擎。

`pnpm test:database` 默认跳过真实数据库测试；设置 `UTERM_MYSQL_TEST=1`、`UTERM_MYSQL_PASSWORD` 及可选的 `UTERM_MYSQL_HOST`、`UTERM_MYSQL_PORT`、`UTERM_MYSQL_USER`、`UTERM_MYSQL_DATABASE` 后执行本机集成验证。先下载与目录匹配的驱动到忽略的 `components/database/target/mysql.jar`。测试只查询元数据/构造数据并设置会话变量，不创建或修改业务表。请勿将密码写入源文件、命令历史或测试夹具。 如需验证三种驱动的代理认证，将匹配的 `mysql.jar`、`postgresql.jar` 和 `oracle.jar` 放入同一忽略目录，并设置 `UTERM_DATABASE_PROXY_TEST=1`；此路由测试使用可丢弃的回环 SOCKS 代理，无需数据库服务。

使用 JDK 17 或更新版本，可设置 `UTERM_DATABASE_JAVA_TEST=1` 验证内置 JSON 的 Unicode、控制字符及精确数值，无需数据库。启用 MySQL 测试时可加 `UTERM_MYSQL_TLS=1` 和 `UTERM_MYSQL_CA` 验证 TLS；会话超时测试只关闭测试自身的连接。

## 一行命令安装

使用 npm 或 pnpm（需要 Node.js 22.13 或以上）：

```sh
npx @yondfane/uterm-install
# 或
pnpm dlx @yondfane/uterm-install
```

也可全局安装命令入口，再运行安装器：

```sh
npm install -g @yondfane/uterm-install
# 或 pnpm add -g @yondfane/uterm-install
uterm-install
```

全局安装只添加命令入口，运行 `uterm-install` 才安装桌面应用；`uterm-install --help` 查看说明。包不使用安装生命周期脚本。卸载 npm 包不会卸载桌面应用。

npm 安装器已发布为 `@yondfane/uterm-install`。维护者可在 `scripts/install` 目录运行 `npm pack --dry-run` 检查包内容，确认后使用 `npm publish --access public` 发布。开发验证可直接运行 `node scripts/install/cli.mjs --help`。

macOS（Apple Silicon / Intel），在终端运行：

```sh
curl -fsSL https://raw.githubusercontent.com/YondFane/uTerm/release/scripts/install/install.sh | bash
```

Windows x64，在 PowerShell 中运行：

```powershell
irm https://raw.githubusercontent.com/YondFane/uTerm/release/scripts/install/install.ps1 | iex
```

需要访问 GitHub。macOS 安装到 `~/Applications/uTerm.app`，完成后从访达打开；已有用户级或系统级安装时停止，请使用应用内更新。安装包未经 Apple 公证，首次启动可能需要在“隐私与安全”中批准。Windows 下载稳定版安装程序并打开向导，按提示完成安装。无需 Node.js、Rust 或管理员终端。

脚本位于 `scripts/install/`，远程命令读取 `release` 分支中的脚本。也可从 [Releases](https://github.com/YondFane/uTerm/releases) 手动下载安装包。

## 开发

Agent 设置可在确认后使用本机 Node.js/npm 安装 OpenCode、Claude、Codex 和 Gemini，需要网络及 npm 全局目录写入权限。Agent 软件包为可选组件，不随 uTerm 打包；其他程序可手动安装并配置可执行文件路径。

登录自启动由 Rust 依赖 `tauri-plugin-autostart` 提供，可在设置 → 通用中开关，无需额外 JavaScript 依赖。

需要 Node.js 22.13 或以上、pnpm 11.22.0、Rust stable 和 Git。Windows 需要 MSVC 工具链、Visual Studio C++ Build Tools、Windows SDK 和 WebView2。macOS 需要 Xcode 命令行工具。

```sh
pnpm install --frozen-lockfile
pnpm uterm:dev
```

`pnpm dev` 仅启动浏览器前端预览；桌面文件、进程和系统集成需要运行 Tauri 应用。

## 验证

```sh
pnpm format:check
pnpm docs:check
pnpm i18n:check
pnpm test
pnpm build
pnpm test:host
pnpm test:backend
pnpm desktop:check
```

使用 `pnpm format` 格式化源码，使用 `pnpm docs:sync` 生成文档索引。构建通过不代表平台交互验收通过。

国际化检查使用仅开发环境依赖 `@babel/parser` 扫描界面源码和已登记的后端消息。`pnpm test` 还通过仅开发环境依赖 `jsdom` 运行词典、占位符及双语组件测试，桌面接口与画布渲染器使用模拟实现。独立设置预览可运行 `pnpm dev --port 1422`，然后打开 `/tests/i18n-preview.html`；它使用模拟桌面数据和独立浏览器来源设置，不连接真实会话。

Redis 集成测试单独运行 `pnpm test:redis`，需要 PATH 中有支持 TLS 的 `redis-server` 和 `openssl`。它启动临时回环服务，不访问已有数据库。普通 `pnpm test:backend` 将四项真实服务测试标为忽略，并运行不依赖 Redis 的协议预算/超时测试；完整验证需要同时运行两个命令。运行应用本身不需要这些测试程序。Redis 客户端关闭默认可选功能，TLS 复用现有 rustls/ring，凭据访问使用系统原生 API。

## 打包与发布

`pnpm desktop:build` 在当前系统打包原生安装程序。运行 `pnpm desktop:build --help` 查看安装包和目标平台选项。开发构建使用 `sh.uterm.desktop.dev`；签名更新构建使用 `sh.uterm.desktop`。

macOS 上如果 Rust 构建报告过程宏动态库的 `mis-aligned LINKEDIT string pool`，可使用 `CARGO_PROFILE_RELEASE_STRIP=none pnpm desktop:build` 绕过当前工具链的剥离问题，参见 [Rust 问题记录](https://github.com/rust-lang/rust/issues/157750)。此设置只作用于该次构建，不修改项目配置。

发布工作流构建 Windows x64 和 macOS ARM64/x64。在 `release` 分支上从已审查提交创建 `uTerm-vMAJOR.MINOR.PATCH` 标签，先推送分支，再推送标签。在 CI 中配置 `DESKTOP_UPDATER_PUBLIC_KEY`、`DESKTOP_UPDATER_PRIVATE_KEY` 和 `DESKTOP_UPDATER_KEY_PASSWORD`。Windows 证书签名还使用 `DESKTOP_WINDOWS_CERT_P12` 和 `DESKTOP_WINDOWS_CERT_PASSWORD`。不要提交签名密钥。

## 目录

| 路径 | 职责 |
| --- | --- |
| `src/components/` | React 视图 |
| `src/lib/` | 状态、设置和纯逻辑 |
| `src-tauri/src/` | 桌面命令和系统集成 |
| `crates/utermd-local/` | 本地 PTY、输出回放和 Agent hooks |
| `components/database/` | 内置 JDBC 进程源码/JAR 与固定组件下载目录 |
| `tests/` | 前端和构建工具测试 |
| `scripts/`、`packaging/` | 构建、发布和文档工具 |
| `.github/workflows/` | CI 与发布 |
| `docs/` | 当前功能与验证说明 |
| `LICENSE`、`NOTICE` | 公开许可、版权及中英文商业授权说明 |
| `DESIGN.md` | 中英文界面规范、颜色变量与设计参考 |

桌面后端和本地会话服务各自维护 Cargo 清单及锁文件。源码和运行资源均保存在本仓库内。
