## 中文

uTerm 0.1.3 改善了分支切换、项目整理、文件复制和跨工作空间的终端操作，并修复 macOS 粘贴时的二次确认问题。以下变化以 0.1.2 为基准。

### 新增功能

- **顶部切换 Git 分支**：当前分支名称改为下拉列表，可切换当前项目、Worktree 或独立会话目录中的现有本地分支。列表定时刷新，并在窗口重新获得焦点时更新。游离 HEAD 可切回本地分支；尚无首次提交的仓库显示当前分支但禁用切换。此入口不会获取远程分支，也不会创建跟踪分支。
- **文件树复制与粘贴**：右键菜单和 Ctrl+C/Ctrl+V（macOS 为 Cmd+C/Cmd+V）支持复制文件、二进制内容和整个目录。可以在一个项目复制，再切换到另一个项目粘贴；粘贴到目录时写入该目录，选中文件时写入其父目录，空白处写入项目根目录。应用内剪贴板一次保存一个条目，重新加载应用后清空，不从系统剪贴板导入文件。
- **复制项目地址**：项目右键菜单新增“复制项目地址”，将项目本地绝对目录复制到系统剪贴板。

### 改进

- **工作空间移动子菜单**：项目右键菜单将分散的“移至某空间”选项收进“移动到工作空间”。悬停、点击或右方向键展开后选择目标；左方向键或 Escape 返回父菜单。当前所属空间不会出现在目标列表中，没有其他空间时禁用。只改变项目归属，不搬动磁盘文件，也不重启会话。项目菜单移除了“新建终端”和“刷新 Worktree”，保留“新建 Worktree”；终端仍可从工具栏、欢迎页或快捷键创建，加载项目时仍会自动发现 Worktree。
- **跨工作空间切换会话**：“下一个会话”和“上一个会话”遍历全部工作空间，按保存的空间顺序访问项目会话和独立终端/聊天，跳过空集合并支持首尾循环。切换时同步选择项目及 Worktree，并记住原空间的选择。
- **Agent 品牌图标**：Kimi、OpenCode 和 Grok 在设置及会话控件中显示内置品牌图标，跟随界面颜色且无需联网；未知 Agent 保留终端图标。

### 问题修复与数据保护

- **macOS 终端粘贴**：Cmd+C/Cmd+V 改走原生复制/粘贴事件，避免异步浏览器剪贴板读取引发的“Paste”二次确认和 `NotAllowedError` 横幅。Control 按键继续交给终端程序，括号粘贴处理保持有效；其他真正的剪贴板或会话错误仍会显示。
- **跨空间关闭会话**：“关闭会话”在终止前先显示目标工作空间及会话，修复目标位于另一空间时操作无法正确落到目标上的问题。每次只关闭一个会话，关闭失败保留目标供重试。
- **文件操作错误提示**：新建、重命名、删除、复制、粘贴和在文件管理器中打开失败时，提示在三秒后隐藏；相同操作再次失败会重新计时，输入的名称仍保留。目录读取和搜索错误保持显示。
- **安全切换分支**：切换前保存并关闭编辑器文档，保存冲突时保留草稿并阻止切换；需解决冲突或明确放弃编辑器修改后才继续。Git 拒绝会覆盖文件修改的切换，以及其他 Worktree 占用的分支；不强制切换、不自动 stash 或丢弃文件修改。切换期间阻止重复请求和编辑器跳转，过期轮询不会覆盖新状态；成功后刷新文件、Git 和 GitHub 面板。
- **文件复制边界**：分别检查源项目与目标项目的目录边界，不覆盖同名文件或目录；拒绝链接、特殊文件、复制根目录及复制到自身或子目录。递归限制为 64 层、100,000 个条目；复制需要临时磁盘空间，最终写入失败可能留下未完成副本，并会提示检查目标目录。

### 兼容性与使用要求

- 提供 Windows x64、macOS Apple Silicon 和 macOS Intel 安装包；macOS 最低版本仍为 14.0，本次不提供 Linux 安装包。
- 分支切换需要可用的本地 Git，并遵守 Git 的工作目录冲突检查。现有项目、工作空间及设置数据格式保持不变，无需手动迁移。
- macOS 安装包使用临时签名，未经 Apple 公证。当前未配置 Windows 发布者代码签名证书；更新包签名独立于操作系统的发布者签名，首次安装仍可能触发系统安全提示。

### 验证与已知限制

- 本次在 macOS 完成锁定依赖安装、格式检查、文档一致性检查、国际化检查、139 项前端及构建工具测试、36 项后端测试、本地会话服务测试、TypeScript/生产构建和桌面调试构建。
- 独立 macOS QA 应用验证了中文终端直接粘贴、分支下拉菜单在临时仓库中往返切换及文件刷新，以及项目菜单展开、Escape 返回、准确复制路径和跨空间移动项目。未重启正在使用的正式应用。
- Windows/macOS 发布安装包由 CI 分别构建和校验；构建不等于安装或全面交互验收。Windows/Linux 原生菜单及分支切换、跨空间会话快捷键、多行终端粘贴和真实 Agent 剪贴板流程仍需专项验收。
- 前端仍有超过 500 kB 的代码包警告，macOS Rust 构建仍有未使用代码警告；本次未宣称安装包体积或运行性能改善。

## English

uTerm 0.1.3 improves branch switching, project organization, file copying and terminal operations across workspaces, and fixes the extra paste confirmation on macOS. These changes are relative to 0.1.2.

### Features

- **Switch Git branches from the toolbar**: The current branch name is now a dropdown for existing local branches in the displayed project, Worktree or standalone session directory. It refreshes periodically and when the window regains focus. Detached HEAD can switch back to a local branch; repositories without a first commit show their branch with switching disabled. This control does not fetch remote branches or create tracking branches.
- **Copy and paste in the file tree**: The context menu and Ctrl+C/Ctrl+V (Cmd+C/Cmd+V on macOS) support files, binary content and entire directories. Copy in one project and paste into another. A selected directory receives the copy, a selected file targets its parent, and blank space targets the project root. The internal clipboard holds one entry, resets on application reload and does not import files from the system clipboard.
- **Copy project path**: The project context menu now copies the project's absolute local directory to the system clipboard.

### Improvements

- **Move to workspace submenu**: Separate destination entries in the project context menu are grouped under Move to workspace. Hover, click or Right Arrow opens the choices; Left Arrow or Escape returns to the parent menu. The current workspace is excluded, and moving is disabled when there are no other workspaces. This changes membership without moving disk files or restarting sessions. New terminal and Refresh Worktrees have been removed from this menu; New Worktree remains. Terminal creation is still available from the toolbar, welcome page and shortcuts, and Worktrees are still discovered when projects load.
- **Navigate sessions across workspaces**: Next session and Previous session traverse all workspaces in saved workspace order, visiting project sessions and standalone terminals/chats, skipping empty collections and wrapping at both ends. Navigation selects the destination project and Worktree together and remembers the previous workspace selection.
- **Agent brand icons**: Kimi, OpenCode and Grok have bundled brand icons in settings and session controls, with theme-aware colors and no network requirement. Unknown agents retain the terminal icon.

### Fixes and data protection

- **macOS terminal paste**: Cmd+C/Cmd+V use native copy/paste events, avoiding the extra “Paste” confirmation and `NotAllowedError` banner caused by asynchronous browser clipboard reads. Control keys remain available to terminal programs, and bracketed paste is preserved. Other genuine clipboard and session errors remain visible.
- **Close sessions across workspaces**: Close Session reveals its target workspace and session before requesting termination, fixing operations aimed at sessions in another workspace. Each invocation closes one session; failure retains the target for retry.
- **File-operation error messages**: Errors from creation, renaming, deletion, copying, pasting and opening in the file manager hide after three seconds. Repeating a failed action restarts the timer, including identical errors, while retaining typed names. Directory-loading and search errors remain visible.
- **Safe branch switching**: The editor saves and closes its document before switching. Save conflicts retain the draft and block the switch until resolved or the editor changes are explicitly discarded. Git rejects switches that would overwrite file changes or target a branch checked out in another Worktree. No force, automatic stash or discard of file changes is used. Switching blocks repeat requests and editor transitions; stale polling cannot replace newer state. Success refreshes the file, Git and GitHub panels.
- **File-copy boundaries**: Source and destination project boundaries are checked separately, with no overwriting of existing names. Links, special files, root copies and self/descendant destinations are rejected. Recursion is limited to 64 levels and 100,000 entries. Copying requires temporary disk space; a final write failure can leave an incomplete copy and displays a message to inspect the destination.

### Compatibility and requirements

- Installers are provided for Windows x64, macOS Apple Silicon and macOS Intel. The macOS minimum remains 14.0; this release does not provide a Linux installer.
- Branch switching requires an available local Git installation and follows Git's working-directory conflict checks. Existing project, workspace and settings formats remain unchanged; no manual migration is required.
- macOS packages use temporary signing and are not notarized by Apple. No Windows publisher code-signing certificate is currently configured. Update-artifact signing is separate from OS publisher signing, so first-time installation may still trigger system security prompts.

### Validation and known limitations

- This release was checked locally on macOS with frozen dependency installation, formatting, documentation consistency, localization, 139 frontend/build-helper tests, 36 backend tests, local session-service tests, TypeScript/production build and a desktop debug build.
- Isolated macOS QA apps verified direct Chinese terminal paste, switching branches in a temporary repository and refreshing its file list, plus project submenu expansion, Escape return, exact path copying and moving a project between workspaces. The running production app was not restarted.
- Windows/macOS release packages are built and checked separately by CI; a successful build is not installation or full interaction acceptance. Native Windows/Linux menus and branch switching, cross-workspace session shortcuts, multiline terminal paste and clipboard use in live Agent sessions still need focused acceptance testing.
- Frontend chunks over 500 kB and macOS Rust dead-code warnings remain. This release makes no claim of reduced installer size or improved runtime performance.
