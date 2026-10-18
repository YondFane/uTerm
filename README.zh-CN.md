# uTerm

[English](README.md) · [官网](https://yondfane.github.io/uTerm/?lang=zh-CN) ·
[功能指南](docs/features.zh-CN.md) · [版本下载](https://github.com/YondFane/uTerm/releases)

**面向 Windows 和 macOS 的终端工作台，按项目组织编程 Agent、Git Worktree 与远程开发。**

把终端、Agent 和项目工具放在一起，按项目组织任务，在会话旁查看 Git 修改，重新打开应用后继续连接本地进程。

[下载](#下载) · [快速开始](#快速开始) · [导览](#看看工作流程) · [功能](#可以做什么) ·
[命令安装](#一行命令安装) · [许可](#许可与反馈) · [开发](#开发)

![Windows 上的 uTerm：演示项目、分屏终端、Git 变更与 Worktree](site/media/workspace.png)

_Windows 应用中的临时演示项目与真实本地 Shell 会话。截图界面为英文。_

## 下载

| 平台                | 稳定版安装包                                                                   |
| ------------------- | ------------------------------------------------------------------------------ |
| Windows x64         | [下载 Windows 版](https://yondfane.github.io/uTerm/?lang=zh-CN#download)       |
| macOS Apple Silicon | [下载 Apple Silicon 版](https://yondfane.github.io/uTerm/?lang=zh-CN#download) |
| macOS Intel         | [下载 Intel 版](https://yondfane.github.io/uTerm/?lang=zh-CN#download)         |

官网从最新稳定版解析对应安装包。无法加载发布信息时，可从
[GitHub Releases](https://github.com/YondFane/uTerm/releases/latest)
选择平台。下载桌面安装包无需 Node.js 或 Rust。

macOS 安装包未经 Apple 公证，首次打开可能需要在**系统设置 → 隐私与安全**中批准。Windows 按安装向导完成安装。下载需要访问 GitHub。

## 快速开始

1. 安装并打开 uTerm，点击**添加项目**，选择项目文件夹。
2. 新建终端；或在**设置 → Agent**
   中启用已安装的 Agent，再从项目行新建聊天。各 CLI 使用自身的登录与认证方式。
3. 右键会话，选择**与…分组**，并排显示会话。打开 **Git** 查看修改；已有 Git
   Worktree 会显示在所属项目下。

退出应用只分离窗口，本地会话继续运行；重新打开后可连接原会话。**关闭会话**才会终止所选进程。

## 看看工作流程

[观看 30 秒截图导览](site/media/workflow.mp4)

![使用临时演示项目展示 uTerm 工作区](site/media/workflow.gif)

标注导览使用真实 Windows 应用截图、本地临时项目及真实 Shell 输出；它是截图导览，并非连续录屏，不展示模型请求或远程服务器连接。[素材说明](site/media/README.md)。

## 可以做什么

| 工作流程           | uTerm 提供的功能                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 同时处理多个任务   | 按工作区、项目和 Git Worktree 组织终端与 Agent，使用分屏，并通过受支持的 Hooks 查看 Agent 活动。                               |
| 保留项目上下文     | 查看 Git 状态、差异与提交；编辑文件时保留冲突检查和草稿恢复；预览 Markdown 与 PDF。                                            |
| 使用远程系统和数据 | 复用系统 OpenSSH 连接 SSH/SFTP；浏览 Redis，查询 MySQL、PostgreSQL、Oracle、Elasticsearch 与 MongoDB，默认只读，按需受控编辑。 |

界面支持简体中文和英文、六套配色、可配置字体和快捷键。Agent 程序为可选组件，可安装或配置需要的 CLI。SQL 与 MongoDB 连接需要 Java
17+ 和所选驱动，在应用内按需管理；Elasticsearch 无需额外运行时。支持范围、限制和平台验收情况见[功能指南](docs/features.zh-CN.md)。

设置 → 外观 → 侧栏样式可选择默认的“经典侧栏”，或在内容列表旁增加纵向图标栏的“图标导航侧栏”。图标导航样式的添加按钮与命令、设置及 Agent 共用图标栏底部按钮组。选择后立即保存，拖动侧栏边缘可调整宽度，窄栏会使用紧凑操作与图标布局，底部控件换行以保持可访问。

图标导航样式下，隐藏或收起侧栏仍保留图标栏，点击分类图标可重新展开内容列表。添加菜单第一项为“新建终端”，随后是项目及 Agent 操作，SSH、Redis 和数据库连接操作位于末尾。

## 一行命令安装

macOS，在终端运行：

```sh
curl -fsSL https://raw.githubusercontent.com/YondFane/uTerm/release/scripts/install/install.sh | bash
```

Windows x64，在 PowerShell 中运行：

```powershell
irm https://raw.githubusercontent.com/YondFane/uTerm/release/scripts/install/install.ps1 | iex
```

已安装 Node.js 22.13 或以上时，也可使用以下任一命令启动同一个桌面安装器：

```sh
npx @yondfane/uterm-install
# or / 或
pnpm dlx @yondfane/uterm-install
```

也可先运行 `npm install -g @yondfane/uterm-install` 全局安装命令，再执行
`uterm-install`。安装或移除 npm 包只管理命令，不安装或卸载桌面应用。使用 `uterm-install --help`
查看选项。

macOS 脚本安装到
`~/Applications/uTerm.app`，不使用 sudo，也不启动应用。已有安装会保留，请使用应用内更新。安装包支持有限重试；稳定清单提供大小与 SHA-256 时，可校验并复用缓存。[安装器详情](docs/features.zh-CN.md#一行命令安装)。

## 许可与反馈

uTerm 是采用 [PolyForm Noncommercial License 1.0.0](LICENSE)
的源码可用软件，协议允许的用途可免费使用。超出协议已允许范围的商业使用需要单独书面授权；条款和授权联系入口见
[NOTICE](NOTICE)。第三方组件保留各自许可。

[报告问题或提出建议](https://github.com/YondFane/uTerm/issues/new)时，请附上操作系统、uTerm 版本及复现步骤。如果 uTerm 对你有帮助，欢迎点一个 Star，让更多开发者发现它。

## 开发

使用 Tauri、React、TypeScript、Rust 和 xterm.js 构建。环境配置、开发命令、数据库组件开发、验证与发布说明见[开发指南](docs/development.zh-CN.md)。参与贡献时请遵循
[AGENTS.md](AGENTS.md) 和[文档编写规范](docs/writing-rules.md)。
