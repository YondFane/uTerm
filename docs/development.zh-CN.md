---
title: uTerm 开发指南
status: active
type: reference
created: 2026-10-17
updated: 2026-10-18
---

# uTerm 开发指南

[English](development.md) · [下载与快速开始](../README.zh-CN.md)

在本仓库中构建、验证和打包 uTerm。功能用法与当前验收状态见[功能指南](features.zh-CN.md)。

**章节导航**

- [开发](#开发)
- [数据库组件开发](#数据库组件开发)
- [安装器维护](#安装器维护)
- [项目官网](#项目官网)
- [验证](#验证)
- [打包与发布](#打包与发布)
- [目录](#目录)

## 开发

Agent 设置可在确认后使用本机 Node.js/npm 安装 OpenCode、Claude、Codex、Gemini、Pi、MiniMax、Qwen
Code、Copilot CLI 和 iFlow CLI，需要网络及 npm 全局目录写入权限。Hermes 使用官方平台安装脚本。

Agent 软件包为可选组件，不随 uTerm 打包；其他程序可手动安装并配置可执行文件路径。

登录自启动由 Rust 依赖 `tauri-plugin-autostart`
提供，可在设置 → 通用中开关，无需额外 JavaScript 依赖。

需要 Node.js 22.13 或以上、pnpm 11.22.0、Rust stable 和 Git。Windows 需要 MSVC 工具链、Visual Studio
C++ Build Tools、Windows SDK 和 WebView2。

macOS 需要 Xcode 命令行工具。

```sh
pnpm install --frozen-lockfile
pnpm uterm:dev
```

`pnpm dev` 仅启动浏览器前端预览；桌面文件、进程和系统集成需要运行 Tauri 应用。

## 数据库组件开发

### 内置引擎与重新构建

内置连接引擎源码位于 `components/database/src/`，纳入版本控制的 `components/database/engine.jar`
嵌入桌面可执行文件。`components/database/catalog.json` 固定引擎校验值及可选驱动/运行时下载信息。

构建主应用不需要 Java；重新构建引擎需要与校验目录一致的 JDK 21.0.2，运行 `pnpm database:build`
校验生成结果与内置 JAR 一致。

修改源码后运行 `node scripts/database-component.mjs --record`，审核并同步提交源码、内置 JAR 及目录。

临时编译产物仍位于忽略的 `components/database/target/`。`.github/workflows/database-components.yml`
手动校验内置产物，无需单独发布引擎。

### 真实数据库与代理检查

`pnpm test:database` 默认跳过真实数据库测试；设置 `UTERM_MYSQL_TEST=1`、`UTERM_MYSQL_PASSWORD`
及可选的 `UTERM_MYSQL_HOST`、`UTERM_MYSQL_PORT`、`UTERM_MYSQL_USER`、`UTERM_MYSQL_DATABASE`
后执行本机集成验证。先下载与目录匹配的驱动到忽略的 `components/database/target/mysql.jar`。

测试只查询元数据/构造数据并设置会话变量，不创建或修改业务表。请勿将密码写入源文件、命令历史或测试夹具。

如需验证三种驱动的代理认证，将匹配的 `mysql.jar`、`postgresql.jar` 和 `oracle.jar`
放入同一忽略目录，并设置
`UTERM_DATABASE_PROXY_TEST=1`；此路由测试使用可丢弃的回环 SOCKS 代理，无需数据库服务。

### MongoDB 驱动协议检查

目录固定使用 Apache-2.0 许可的官方 MongoDB
Java 驱动 5.13.0（Sync、Core、BSON），按大小和 SHA-256 校验，运行时按需安装，不进入主安装包。源码中的反射适配使主应用与内置引擎构建无需下载这些驱动。

将目录中相同版本的三个 JAR 下载到忽略的 `components/database/target/mongodb/`，文件名分别为
`mongodb-driver-sync.jar`、`mongodb-driver-core.jar` 与 `bson.jar`。设置
`UTERM_MONGODB_DRIVER_TEST=1` 后运行
`node --experimental-strip-types --test tests/document-database.test.mjs`，使用真实 Java 驱动连接临时回环协议模拟服务，检查 BSON 保真、查询、聚合、写入保护与原始文档冲突检查。此测试不连接现有数据库，也不代表真实 MongoDB 部署验收。

Elasticsearch 在 `pnpm test:backend`
中使用临时 HTTP 模拟服务检查分页、精确数字、来源投影和写入版本条件，无需安装服务端。桌面原生检查使用独立应用标识符，不重启用户正在运行的应用。

### Java 与 TLS 检查

使用 JDK 17 或更新版本，可设置 `UTERM_DATABASE_JAVA_TEST=1`
验证内置 JSON 的 Unicode、控制字符及精确数值，无需数据库。启用 MySQL 测试时可加 `UTERM_MYSQL_TLS=1`
和 `UTERM_MYSQL_CA` 验证 TLS；会话超时测试只关闭测试自身的连接。

### 受控写入检查

受控写入验证需显式设置 `UTERM_DATABASE_WRITE_TEST=1`，配合上述 MySQL 变量执行
`node --experimental-strip-types --test tests/database-maintenance.test.mjs`。必须使用临时回环服务、显式非 3306 端口及
`uterm_*` 专用库；仅创建／删除唯一名称的测试表，请勿指向业务数据。

`pnpm test` 限制文件并发为四，约束并行 Vite／DOM 测试进程。SQL 补全将已有 CodeMirror
SQL 包声明为直接依赖，不捆绑额外编辑器或表格框架。

## 安装器维护

### npm 包维护

npm 安装器已发布为 `@yondfane/uterm-install`。维护者可在 `scripts/install` 目录运行
`npm pack --dry-run` 检查包内容，确认后使用 `npm publish --access public` 发布。

开发验证可直接运行 `node scripts/install/cli.mjs --help`。

### 下载缓存

安装包下载支持有限重试；更新清单提供大小和 SHA-256 时，还支持断点续传及校验后复用完整缓存。旧清单仍可安装，但重新下载。

缓存位于 Windows 的 `%LOCALAPPDATA%/uTerm/installer-cache-v1` 或 macOS 的
`~/Library/Caches/sh.uterm.desktop/installer-cache-v1`，最多保留四个文件，后续使用时清理超过七天的非当前文件。macOS 强制终止脚本后，确认没有安装器运行再移除缓存中的
`installer.lock` 目录。

脚本位于 `scripts/install/`，远程命令读取 `release` 分支中的脚本。也可从
[Releases](https://github.com/YondFane/uTerm/releases) 手动下载安装包。

## 项目官网

GitHub Pages 官网源码位于
`site/`，为无需构建的独立静态页面，支持中英文、真实截图导览、功能示意、配色预览、稳定版下载及安装命令复制。

展示素材及来源说明位于 `site/media/`；GitHub 仓库社交预览需单独上传其中的 `social-preview.png`。

使用 `pnpm site:dev` 在 `http://127.0.0.1:1431/uTerm/` 预览，使用 `pnpm site:check`
验证官网交互；可通过 `UTERM_SITE_PORT` 修改预览端口。

部署前，在仓库 Settings → Pages → Build and deployment 中将 Source 选择为 **GitHub Actions**，并确保
`github-pages` 环境允许 `release` 分支部署。`.github/workflows/pages.yml` 在 `release`
上官网文件变化时发布 `site/`，也可从该分支手动运行；不会发布桌面应用的 `index.html`。

无需新增域名或密钥。

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

国际化检查使用仅开发环境依赖 `@babel/parser` 扫描界面源码和已登记的后端消息。`pnpm test`
还通过仅开发环境依赖 `jsdom` 运行词典、占位符及双语组件测试，桌面接口与画布渲染器使用模拟实现。

独立设置预览可运行 `pnpm dev --port 1422`，然后打开
`/tests/i18n-preview.html`；它使用模拟桌面数据和独立浏览器来源设置，不连接真实会话。

Redis 集成测试单独运行 `pnpm test:redis`，需要 PATH 中有支持 TLS 的 `redis-server` 和
`openssl`。它启动临时回环服务，不访问已有数据库。

普通 `pnpm test:backend`
将四项真实服务测试标为忽略，并运行不依赖 Redis 的协议预算/超时测试；完整验证需要同时运行两个命令。运行应用本身不需要这些测试程序。

Redis 客户端关闭默认可选功能，TLS 复用现有 rustls/ring，凭据访问使用系统原生 API。

## 打包与发布

`pnpm desktop:build` 在当前系统打包原生安装程序。运行 `pnpm desktop:build --help`
查看安装包和目标平台选项。

开发构建使用 `sh.uterm.desktop.dev`；签名更新构建使用 `sh.uterm.desktop`。

macOS 上如果 Rust 构建报告过程宏动态库的 `mis-aligned LINKEDIT string pool`，可使用
`CARGO_PROFILE_RELEASE_STRIP=none pnpm desktop:build` 绕过当前工具链的剥离问题，参见
[Rust 问题记录](https://github.com/rust-lang/rust/issues/157750)。此设置只作用于该次构建，不修改项目配置。

发布工作流构建 Windows x64 和 macOS ARM64/x64。在 `release` 分支上从已审查提交创建
`uTerm-vMAJOR.MINOR.PATCH` 标签，先推送分支，再推送标签。

在 CI 中配置 `DESKTOP_UPDATER_PUBLIC_KEY`、`DESKTOP_UPDATER_PRIVATE_KEY` 和
`DESKTOP_UPDATER_KEY_PASSWORD`。Windows 证书签名还使用 `DESKTOP_WINDOWS_CERT_P12` 和
`DESKTOP_WINDOWS_CERT_PASSWORD`。

不要提交签名密钥。

稳定版本通过 CI、公开下载和更新清单检查后，将本次已发布的 `release` 提交合入 `main`
并推送。保留双方历史，不夹带后续未发布提交。冲突、分支保护及远端验证遵循发布技能；只有远端 `main`
已包含发布提交，发版收尾才算完成。

完整流程见[发布技能](../.agents/skills/uterm-release/SKILL.md)。

## 目录

| 路径                     | 职责                                      |
| ------------------------ | ----------------------------------------- |
| `src/components/`        | React 视图                                |
| `src/lib/`               | 状态、设置和纯逻辑                        |
| `src-tauri/src/`         | 桌面命令和系统集成                        |
| `crates/utermd-local/`   | 本地 PTY、输出回放和 Agent hooks          |
| `components/database/`   | 内置 JDBC 进程源码/JAR 与固定组件下载目录 |
| `tests/`                 | 前端和构建工具测试                        |
| `scripts/`、`packaging/` | 构建、发布和文档工具                      |
| `.github/workflows/`     | CI 与发布                                 |
| `docs/`                  | 当前功能与验证说明                        |
| `site/`                  | GitHub Pages 双语官网及静态资源           |
| `LICENSE`、`NOTICE`      | 公开许可、版权及中英文商业授权说明        |
| `DESIGN.md`              | 中英文界面规范、颜色变量与设计参考        |

桌面后端和本地会话服务各自维护 Cargo 清单及锁文件。源码和运行资源均保存在本仓库内。
