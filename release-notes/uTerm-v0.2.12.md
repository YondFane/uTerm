# uTerm 0.2.12

## 中文

- 修复 OpenCode
  2.2.2 从专用入口启动时报未知参数并退出的问题，保留会话恢复和自定义参数。v2 使用终端提醒，兼容的旧版保留认证事件通知。
- macOS 原生个人版新增顶栏分支选择器，支持切换本地／远端分支，右键打开 Push、Pull、Fetch 等操作。侧栏可直接选择 Redis 和数据库连接。
- macOS 原生个人版将 Git、Redis、数据库和 SSH 等工具整合到主工作区，切换或隐藏面板时保留内容与操作草稿。Java／Python 顶栏按钮显示运行状态，右键可选择已有运行任务。
- 设置支持分类搜索；macOS 原生个人版完善设置分类、主题预览、默认 Agent 选择和兼容配置导出，按回车只保存当前编辑字段。
- 修复 macOS 原生个人版独立 SSH 窗口超出可用桌面区域的问题。

## English

- Fix OpenCode 2.2.2 exiting with unknown flags when launched from its dedicated entry. Preserve
  session restoration and custom arguments. v2 uses terminal reminders; compatible older versions
  retain authenticated events.
- The native personal macOS app adds a toolbar branch picker for local/remote branches. Right-click
  for Push, Pull, Fetch and related actions; select Redis and database connections in the sidebar.
- The native personal macOS app integrates Git, Redis, databases and SSH into the main workspace,
  retaining content and operation drafts when panels are switched or hidden. Java/Python toolbar
  buttons show running status; right-click to select an existing task.
- Settings supports category search. The native personal macOS app improves category layout, theme
  previews, default Agent selection and compatibility export; Return saves only the edited field.
- Fix standalone SSH windows extending beyond the usable desktop in the native personal macOS app.
