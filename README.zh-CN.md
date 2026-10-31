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
