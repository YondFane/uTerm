# uTerm 0.2.1

## 中文

- 新增 Java 构建与运行面板。从项目菜单或顶部 Java 按钮打开，选择模块与完整 JDK，即可执行 Maven 打包、测试、安装，或以开发／JAR 模式启动 Spring
  Boot；开发模式支持检测和选择启动主类。
- 新增全局与项目独立 Maven 配置。在“设置 →
  Maven 设置”或运行面板的 Maven 设置中选择 Maven、settings.xml 和本地仓库；“Java 开发环境”可添加本机 JDK，或按需安装 JDK
  8／11／17／21 与 Maven。
- 新增 Python 运行面板。从项目菜单或顶部 Python 按钮打开，选择已有 Python
  3 或虚拟环境，即可运行脚本、模块、FastAPI、Flask 或 Django；日志支持搜索、复制与自动跟随，Python 和项目依赖需提前准备。
- 顶部 Java／Python 图标显示所有项目及 Worktree 的运行状态，切换项目或隐藏面板后仍可查看。重新打开面板可恢复后台任务与日志；普通“停止”允许进程完成清理，仍在运行时可选择“强制停止”。
- 文件树新增 Git 状态标记与目录汇总，展开“文件”即可查看已修改、新增、删除、重命名及冲突状态；普通目录不再显示 Git 的致命错误信息。
- 改善会话切换与分屏拖动的响应速度。运行日志在调整面板宽度、重新打开或切换历史时保留长行末尾，回放后可直接看到最近日志。

## English

- Add the Java build and run panel. Open it from the project menu or top Java button, select a
  module and full JDK, then package, test or install with Maven, or launch Spring Boot in
  Development/JAR mode; Development mode detects and selects main classes.
- Add global and project-specific Maven configuration. Choose Maven, settings.xml and a local
  repository under Settings → Maven settings or the run panel's Maven settings; Java development
  tools can register local JDKs or install JDK 8/11/17/21 and Maven on demand.
- Add the Python run panel. Open it from the project menu or top Python button, select an existing
  Python 3 or virtual environment, then run a script, module, FastAPI, Flask or Django project. Logs
  support search, copying and Auto follow; prepare Python and project dependencies first.
- Top Java/Python icons show running tasks across projects and Worktrees, including after switching
  projects or hiding a panel. Reopen a panel to restore its background task and logs; Stop allows
  process cleanup to finish, with Force stop available while it remains running.
- Add Git status markers and folder summaries to the file tree. Open Files to see modified, added,
  deleted, renamed and conflicting paths; ordinary directories no longer display Git's fatal
  diagnostics.
- Improve responsiveness when switching sessions and dragging split panes. Run logs preserve
  long-line endings across panel-width changes, reopening and history switches, and show recent
  retained text immediately after replay.
