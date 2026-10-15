## 中文

uTerm 0.1.4 扩展了 Git 分支与同步操作，补齐 Worktree 目录打开入口，并修复安装版因启动 PATH 不同而找不到 Kimi 的问题。以下变化以 0.1.3 为基准。

### 新增功能

- **Local / Remote 分支列表**：点击顶部的分支选择器，分别查看本地分支和以“远程名/分支名”显示的远程分支。打开列表时查询所有已配置远程仓库公开的分支，包含尚未 Fetch 到本地以及单分支克隆获取配置之外的分支；不混入标签或远程 HEAD 符号引用。本地列表继续定时刷新，并在窗口获得焦点时更新。
- **选择远程分支**：选择 Remote 条目时，获取该分支并创建同名本地跟踪分支；必要时补充单分支克隆的获取配置。已有同名本地分支仅在跟踪该远程分支时复用，否则提示冲突，不重置本地分支。游离 HEAD 和尚无首次提交的仓库也可选择可用分支。
- **分支右键 Git 操作**：在分支控件上右击，或使用 Shift+F10，打开 Push、Pull（仅快进）、Fetch 和刷新分支列表。Push 推送当前分支到已配置的上游；Pull 获取上游并快进；Fetch 更新所有远程仓库的分支引用并清理已删除的远程引用，不切换或合并分支；刷新重新读取 Local/Remote 列表。
- **打开 Worktree 目录**：Worktree 右键菜单新增“在文件管理器中打开”，打开该 Worktree 自己的目录。目录缺失时禁用该项，打开失败时显示错误。

### 交互与数据保护

- 分支菜单支持方向键、Home/End、Enter、Escape 和外部点击关闭，靠近窗口边缘时限制位置并支持滚动。菜单打开时不触发应用快捷键。远程读取显示加载状态及各远程仓库的错误，同时保留其他远程仓库的成功结果。
- 切换及同步操作复用编辑器保存/关闭保护；保存冲突保留草稿并阻止操作。Git 拒绝会覆盖文件修改的切换及其他 Worktree 占用的分支，不强制切换、不自动 stash、不丢弃文件修改。
- Pull 要求工作区干净，历史分叉时拒绝操作，不自动合并或变基。Push 不强制推送、不自动推送标签；游离 HEAD、无提交分支或缺少上游时禁用 Push/Pull，并提示先在终端配置上游。
- Git 操作在后台线程中串行执行，控件显示进度，右键菜单显示完成提示。错误会显示；操作结束后刷新文件、Git 和 GitHub 面板，部分失败也会刷新，以反映已经完成的步骤。重复请求和过期响应受到保护。

### 问题修复

- **macOS 安装版检测不到 Kimi**：检测和 Agent 启动路径补充 `~/.kimi-code/bin`。通过图形界面启动、PATH 不包含该目录时，也能发现默认位置安装的 Kimi。保留已有 PATH 的优先级和手动配置的绝对程序路径；自定义安装位置仍可通过 Kimi“配置”中的“程序路径或命令”指定。

### 兼容性与使用要求

- Git 分支与同步操作需要本地 Git、远程访问权限及已有凭证。远程读取或同步失败会显示错误，可重新打开列表或重试；现有命令执行时限仍适用，慢网络或大型获取操作可能需要在终端完成。
- 现有项目、工作空间和设置数据格式保持不变，无需手动迁移。更新应用不会重新安装 Kimi；本次增加的是检测与启动路径。
- 提供 Windows x64、macOS Apple Silicon 和 macOS Intel 安装包，macOS 最低版本仍为 14.0；不提供 Linux 安装包。macOS 使用临时签名，未经 Apple 公证；Windows 发布者代码签名证书未配置。更新包签名与操作系统发布者签名独立，首次安装仍可能出现系统安全提示。

### 验证与已知限制

- 本次在 macOS 完成锁定依赖安装、139 项前端及构建工具测试、39 项后端测试、本地会话服务测试、格式与国际化检查、文档同步/检查、TypeScript/生产构建及桌面调试构建。
- 独立 macOS QA 应用验证了 Worktree 菜单与 Finder 打开对应目录、Local/Remote 菜单布局、从单分支克隆选择未获取的远程分支并建立跟踪关系，以及通过界面 Push 测试提交、Pull 远程新提交并刷新文件列表、Fetch 新增远程分支且保持当前分支不变。测试推送仅写入临时本地裸仓库。
- 回归测试覆盖保存冲突、过期和重复请求、部分远程读取失败、认证失败提示、同名分支冲突、脏工作区、历史分叉及防止强制推送。Kimi 子进程测试使用空 PATH 验证检测及启动 PATH，并验证已有 PATH 优先级和绝对路径。
- Windows/Linux 原生交互、真实网络认证流程、需认证的 Kimi 会话及各平台安装/更新流程仍需专项验收；CI 构建不等于原生运行验收。未替换或重启用户正在使用的安装版应用。
- 前端超过 500 kB 的代码包警告和 macOS Rust 未使用代码警告仍存在；本次不宣称安装包体积或性能改善。

## English

uTerm 0.1.4 expands Git branch and synchronization controls, adds direct access to Worktree directories, and fixes Kimi detection when the installed app starts with a different PATH. These changes are relative to 0.1.3.

### Features

- **Local / Remote branch lists**: Click the toolbar branch picker to see local branches and remote entries displayed as “remote/branch.” Opening the list queries every configured remote for its advertised branches, including branches not fetched locally and branches outside a single-branch clone's fetch configuration. Tags and symbolic remote HEAD entries are excluded. Local branches continue to refresh periodically and when the window regains focus.
- **Select remote branches**: Selecting a Remote entry fetches it and creates a same-named local tracking branch, extending a narrow fetch configuration when necessary. An existing local branch is reused only if it tracks that exact remote branch; other name collisions report an error without resetting local branches. Detached HEAD and repositories without a first commit can also select available branches.
- **Git actions from the branch context menu**: Right-click the branch control, or press Shift+F10, for Push, Pull (fast-forward only), Fetch and Refresh branches. Push sends the current branch to its configured upstream. Pull fetches the upstream and fast-forwards. Fetch updates branch references from all configured remotes and prunes deleted remote references without switching or merging. Refresh re-reads both Local and Remote lists.
- **Open Worktree directories**: The Worktree context menu now offers Open in File Manager, targeting that Worktree's own directory. The action is disabled for missing directories, and opening failures are displayed.

### Interaction and data protection

- Branch menus support arrows, Home/End, Enter, Escape and outside-click dismissal, stay within window edges and scroll when needed. Application shortcuts are suppressed while a menu is open. Remote loading shows progress and per-remote failures while retaining successful results from other remotes.
- Switching and synchronization reuse the editor's save/close protection. Save conflicts retain drafts and block operations. Git rejects switches that would overwrite file changes or use branches occupied by another Worktree. There is no forced switching, automatic stash or discarding of file changes.
- Pull requires a clean working tree and rejects divergent history without automatically merging or rebasing. Push does not force updates or automatically push tags. Push/Pull are disabled for detached HEAD, unborn branches and branches without an upstream, with a prompt to configure the upstream in a terminal first.
- Git actions run serially on background threads. The control shows progress and its context menu reports completion. Errors are displayed, and the file, Git and GitHub panels refresh after operations, including partial failures, to reflect steps that already completed. Repeated requests and stale responses are guarded.

### Fixes

- **Kimi missing in the installed macOS app**: Detection and Agent launch paths now include `~/.kimi-code/bin`. Apps launched through the GUI can find Kimi installed in its default location even when that directory is absent from PATH. Existing PATH precedence and explicitly configured executable paths are preserved. Custom installation locations can still be specified through Kimi → Configure → Program path or command.

### Compatibility and requirements

- Git branch and synchronization actions require local Git, remote access and existing credentials. Remote query or synchronization failures are displayed and can be retried by reopening the list or repeating the action. Existing command time limits still apply; slow networks or large fetches may require a terminal.
- Existing project, workspace and settings formats remain unchanged, with no manual migration required. Updating uTerm does not reinstall Kimi; this change adds detection and launch paths.
- Installers are provided for Windows x64, macOS Apple Silicon and macOS Intel. The macOS minimum remains 14.0; no Linux installer is provided. macOS packages use temporary signing and are not notarized by Apple. No Windows publisher code-signing certificate is configured. Update-artifact signing is separate from OS publisher signing, so first-time installation may still trigger system security prompts.

### Validation and known limitations

- Checks completed on macOS include frozen dependency installation, 139 frontend/build-helper tests, 39 backend tests, local session-service tests, formatting, localization, documentation synchronization/checks, TypeScript/production build and a desktop debug build.
- Isolated macOS QA apps verified the Worktree menu and Finder opening its directory, Local/Remote menu layouts, selecting an unfetched remote branch from a single-branch clone and establishing tracking, and using the UI to Push a test commit, Pull a newer remote commit with file-list refresh, and Fetch a new remote branch while retaining the current branch. Test pushes only wrote to temporary local bare repositories.
- Regression tests cover save conflicts, stale and repeated requests, partial remote failures, authentication error display, branch-name collisions, dirty working trees, divergent history and force-push prevention. Kimi subprocess tests use an empty PATH to verify detection and the launch PATH, and also verify existing PATH precedence and absolute paths.
- Native Windows/Linux interaction, real network authentication, authenticated Kimi sessions and installation/update flows on each platform still need focused acceptance testing. CI builds are not native runtime acceptance. The user's running installed app was neither replaced nor restarted.
- Frontend chunks over 500 kB and macOS Rust dead-code warnings remain. This release makes no claim of reduced installer size or improved performance.
