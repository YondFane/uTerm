# uTerm presentation media / uTerm 展示素材

These assets show uTerm's actual Windows interface with a disposable local sample project. They are
maintained with the project and use the repository's license and notices.

这些素材使用真实 Windows 界面和临时本地演示项目，随项目维护，遵循仓库许可及版权说明。

- `workspace.png`: an inspected screenshot of the isolated native QA app
  (`sh.uterm.desktop.qa.presentation`), rendering the production App, Sidebar, TerminalWorkspace and
  GitPanel. Its initial Git panel and sample workspace are prepared for the presentation.

  `workspace.png`：检查通过的隔离原生 QA 应用实拍（`sh.uterm.desktop.qa.presentation`），使用产品实际 App、Sidebar、TerminalWorkspace 和 GitPanel。初始 Git 面板与演示工作区为展示预先配置。

- The two visible shells run a real loopback-only sample API and Node.js tests. The Worktree is a
  real Git Worktree. No personal workspace, stored credentials, model request or remote connection
  is included. The installed application and its sessions were not restarted.

  两个可见 Shell 运行真实的本机回环 API 与 Node.js 测试，Worktree 由 Git 实际创建。不包含个人工作区、已保存凭据、模型请求或远程连接；未重启安装版应用或其中的会话。

- `tour.html` adds five explanatory highlights around that unchanged screenshot. `workflow.gif` and
  `workflow.mp4` export the five inspected steps for six seconds each, totaling 30 seconds. They are
  annotated screenshot tours, not continuous recordings of user interaction or Agent work.

  `tour.html` 在原始截图周围添加五项说明标注，`workflow.gif` 和 `workflow.mp4`
  将检查通过的五步画面各展示六秒，总长 30 秒。它们是标注截图导览，不是用户操作或 Agent 工作的连续录屏。

- `social-preview.svg` is the editable source for the 1280×640 `social-preview.png` sharing card.
  The app screenshot and `../icon.svg` are project-owned source material; the card makes no model,
  performance or usage-count claims.

  `social-preview.svg` 是 1280×640 分享卡片 `social-preview.png` 的可编辑源文件。应用截图与
  `../icon.svg` 为项目自有素材；卡片不声称模型能力、性能或用户数量。

The screenshot documents Windows presentation only. It does not establish macOS/Linux runtime,
authenticated Agent, SSH or database acceptance; those remain in the feature guides.

截图仅说明 Windows 展示效果，不代表 macOS／Linux 运行、真实登录 Agent、SSH 或数据库验收；相关状态以功能指南为准。
