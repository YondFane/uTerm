## 中文

- 新增工作区标签栏：在主工作区顶部切换当前终端和已打开的文件，文件内容在切换后保留。点击文件标签的 × 关闭文件；macOS Cmd+W／Windows Ctrl+W 优先关闭当前文件，终端会话仍通过侧栏关闭。
- Git 差异可在中栏展示并保留工具面板：在 Git 面板点击“全展示”，通过顶部差异标签切回比较；切换终端或文件后仍可返回，关闭差异标签将比较恢复到工具面板。
- 可见文件树及展开的文件夹自动刷新，创建或修改文件后无需反复手动刷新。
- macOS Shell 会话识别直接运行的 Claude／Codex，侧栏显示对应 Agent 图标，退出后恢复终端图标。
- 改善终端和 Agent 会话的输入法标点提交，并减少大量终端输出与历史回放时的临时内存分配。

## English

- Use the new workspace tab bar to switch between the current terminal and open files while retaining file contents. Close a file with its tab’s ×; Cmd+W on macOS or Ctrl+W on Windows closes the current file first. Close terminal sessions from the sidebar.
- Show Git comparisons in the main workspace while keeping the inspector: click “Expand diff” in the Git panel, then use the diff tab to return to the comparison after switching to a terminal or file. Closing the diff tab returns the comparison to the inspector.
- The visible file tree and expanded folders refresh automatically, reducing manual refreshes after creating or changing files.
- macOS shell sessions recognize directly launched Claude/Codex executables and show the corresponding Agent icon in the sidebar, restoring the terminal icon after exit.
- Improve IME punctuation commits in terminal and Agent sessions and reduce temporary memory allocations during large terminal output and history replay.
