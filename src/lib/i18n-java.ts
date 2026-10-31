export const javaMessages: Record<string, string> = {
  "Java 启动列表": "Java running projects",
  "Python 启动列表": "Python running projects",
  "无法读取启动列表，请稍后重试。": "Could not read running projects. Retrying shortly.",
  "无法切换运行项目，请先完成当前操作或处理配置保存错误。":
    "Cannot switch run projects. Finish the current operation or resolve the configuration save error first.",
  "此运行项目已从工作区移除，请先重新添加项目。":
    "This running project was removed from the workspace. Add the project again first.",
  "正在切换运行项目…": "Switching run projects…",
  运行状态暂不可用: "Run status is temporarily unavailable",
  "上次确认：{count} 个项目运行中": "Last confirmed running projects: {count}",
  "正在读取运行状态…": "Reading run status…",
  "运行中：{count} 个项目": "Running projects: {count}",
  暂无运行项目: "No running projects",
  "任务日志读取失败，请停止任务后重新运行。 {p0}":
    "Could not read task logs. Stop the task and run it again. {p0}",
  自动检测: "Detected automatically",
  手动添加: "Added manually",
  "检测本机 JDK": "Detect local JDKs",
  "手动添加 JDK": "Add local JDK",
  "手动添加的 JDK": "Manually added JDKs",
  "JDK 主目录": "JDK home",
  "选择 JDK 主目录": "Choose JDK home",
  "选择包含 bin/java 和 bin/javac 的 JDK 8、11、17 或 21 目录。":
    "Choose a JDK 8, 11, 17 or 21 directory containing bin/java and bin/javac.",
  当前不可用: "Currently unavailable",
  移除记录: "Remove record",
  "仅移除记录，不删除 JDK 文件。": "Remove the record only; keep JDK files.",
  "无法读取本机 JDK 记录，原记录已保留。":
    "Cannot read local JDK records. Existing records have been preserved.",
  "最多手动添加 64 个 JDK，请先移除不需要的记录。":
    "Up to 64 JDKs can be added manually. Remove unused records first.",

  调整运行面板高度: "Resize build and run panel",
  "拖动调整运行面板高度，双击恢复默认高度":
    "Drag to resize the build and run panel; double-click to reset its height",
  启动主类: "Main class",
  "例如 com.example.Application": "For example, com.example.Application",
  自动识别: "Detect automatically",
  手动填写: "Enter manually",
  完整主类名: "Fully qualified main class",
  "启动主类必须是完整 Java 类名，例如 com.example.Application。":
    "Enter a fully qualified Java main class, such as com.example.Application.",
  "检测到多个启动主类，请选择一个或手动填写。":
    "Multiple main classes detected. Choose one or enter a class manually.",
  "无法读取 Java 源码，请检查文件权限后重新检测。":
    "Cannot read Java sources. Check file permissions and detect again.",
  "Java 源码超过检测上限，请选择较小的项目或模块。":
    "Java sources exceed the detection limit. Select a smaller project or module.",
  "未检测到启动主类，可手动填写；留空时由 Maven 插件查找。":
    "No main class detected. Enter one manually, or leave blank for the Maven plugin to find it.",
  "优先使用带 @SpringBootApplication 的主类。":
    "Prefer a main class annotated with @SpringBootApplication.",

  "选择 Maven 主目录": "Choose Maven home",
  "选择 Maven 设置文件": "Choose Maven settings file",
  "选择 Maven 本地仓库": "Choose Maven local repository",
  "检测到的 JDK": "Detected JDKs",
  可选托管工具: "Optional managed tools",
  "未检测到本机 JDK。可选择本机路径或安装所需版本。":
    "No local JDK detected. Choose a local path or install the required version.",
  重新读取已保存的配置: "Reload saved configuration",
  管理环境: "Manage tools",
  "无法读取项目 Wrapper 分发配置，请检查 HTTPS ZIP 地址及校验值。":
    "Could not read the project Wrapper distribution. Check its HTTPS ZIP URL and checksum.",
  "项目 Wrapper 尚未缓存，首次使用需要网络连接。":
    "The project Wrapper is not cached. Its first use needs an internet connection.",
  高级设置: "Advanced settings",
  选择: "Choose",
  "Java 构建与运行": "Java build and run",
  "Maven 设置": "Maven settings",
  "Java 开发环境": "Java development tools",
  构建与运行: "Build and run",
  运行配置: "Run configuration",
  "Maven 配置层级": "Maven configuration scope",
  系统全局配置: "System-wide configuration",
  项目独立配置: "Project configuration",
  "所有继承全局配置的项目共用以下设置。":
    "These settings apply to every project that inherits the system-wide configuration.",
  "仅影响当前项目，保存后启用项目独立配置。":
    "Applies to this project only. Saving enables its own configuration.",
  "Maven 来源": "Maven source",
  "本机 Maven": "Local Maven",
  "托管 Maven": "Managed Maven",
  "Maven 主目录": "Maven home",
  "留空自动检测本机 Maven": "Leave blank to detect local Maven",
  "用户设置文件 · settings.xml": "User settings file · settings.xml",
  "留空使用 Maven 默认设置文件": "Leave blank to use Maven's default settings file",
  "Maven 本地仓库": "Maven local repository",
  "留空由 settings.xml 或 Maven 默认值决定": "Leave blank to use settings.xml or Maven's default",
  "优先使用项目 Maven Wrapper": "Prefer the project's Maven Wrapper",
  "没有 Wrapper 时使用所选 Maven。项目独立配置不会修改系统环境变量或项目 POM。":
    "Uses the selected Maven when no Wrapper exists. Project configuration does not edit system environment variables or the project POM.",
  "配置已保存，下次构建和运行生效。": "Configuration saved. Applies to the next build and run.",
  从全局复制: "Copy from system-wide configuration",
  恢复继承全局: "Inherit system-wide configuration",
  保存全局配置: "Save system-wide configuration",
  保存项目配置: "Save project configuration",
  "优先使用本机 JDK，仅按需安装选择的版本。Maven 编译需要完整 JDK，数据库 JRE 不能代替。":
    "Prefers a local JDK. Install only the versions you need. Maven compilation needs a full JDK; the database JRE cannot replace it.",
  "安装前显示下载体积；下载中断可继续，也可手动下载后离线安装。":
    "Download sizes are shown before installation. Interrupted downloads can resume; manual downloads support offline installation.",
  "后台服务需要升级。请先关闭现有会话，再重新打开应用；已有进程未被终止。":
    "The background host needs an upgrade. Close existing sessions before reopening the app; existing processes have not been stopped.",
  "Java 构建配置无效，原配置已保留。":
    "Java build configuration is invalid. The original configuration was preserved.",
  "配置已被其他窗口修改，请重新读取后再保存。":
    "Another window changed this configuration. Reload before saving.",
  "无法保存构建配置，原配置已保留。":
    "Could not save the build configuration. The original configuration was preserved.",
  "项目路径必须位于所选根目录内。": "Project paths must remain inside the selected root.",
  "无法读取 Maven 项目，请检查 pom.xml 与模块路径。":
    "Could not read the Maven project. Check pom.xml and module paths.",
  "Maven 模块超过 200 个，请选择较小的项目根目录。":
    "More than 200 Maven modules. Select a smaller project root.",
  "请选择可运行的 Maven 模块。": "Select a runnable Maven module.",
  "未检测到所选版本的完整 JDK。请选择本机 JDK，或安装对应版本。":
    "No full JDK matches the selected version. Choose a local JDK or install that version.",
  "所选 JDK 与配置的 Java 版本不同，请重新选择。":
    "The selected JDK does not match the configured Java version. Choose it again.",
  "未找到 Maven。请选择本机 Maven、安装托管版本，或使用项目 Wrapper。":
    "Maven was not found. Choose local Maven, install the managed version, or use the project Wrapper.",
  "找不到所选 settings.xml，请检查文件路径。":
    "The selected settings.xml was not found. Check its path.",
  "无法确定可执行 JAR，请从项目内选择一个产物。":
    "Could not determine the executable JAR. Select an artifact inside the project.",
  "此项目已有任务正在运行，请先停止后再启动。":
    "A task is already running for this project. Stop it before starting another.",
  "后台任务已不存在，请重新启动任务。": "The background task no longer exists. Start a new task.",
  "已有安装或任务正在准备，请稍后重试。":
    "An installation or task is being prepared. Try again shortly.",
  "构建任务参数无效，请检查参数和环境变量。":
    "Build task parameters are invalid. Check arguments and environment variables.",
  "参数中的引号未闭合，或包含无效字符。":
    "An argument has an unclosed quote or an invalid character.",
  "环境变量须逐行填写 KEY=value，名称不可重复或以 UTERM_ 开头。":
    "Enter one KEY=value per line. Names must be unique and must not start with UTERM_.",
  "找不到所选开发组件。": "The selected development component was not found.",
  "开发组件缺少所需程序，请重新安装。":
    "The development component is missing required programs. Reinstall it.",
  "当前平台没有对应的开发组件，请选择本机环境。":
    "No development component is available for this platform. Choose local tools.",
  "Java 构建操作失败，请重试。": "Java build operation failed. Try again.",
  "选择完整 JDK 主目录": "Choose a full JDK home",
  "已请求停止；进程仍在运行时可强制停止。":
    "Stop requested. Force stop is available if the process keeps running.",
  "任务尚未退出，请先强制停止后再运行。":
    "The task has not exited. Force stop it before running again.",
  还原运行面板: "Restore run panel",
  展开运行面板: "Expand run panel",
  隐藏运行面板: "Hide run panel",
  目标模块: "Target module",
  启动方式: "Launch mode",
  开发启动: "Development run",
  "JAR 启动": "JAR run",
  "JDK 版本": "JDK version",
  已检测到: "Detected",
  需选择或安装: "Choose or install",
  "Maven 配置": "Maven configuration",
  "Maven 配置来源": "Maven configuration source",
  "Maven Profile": "Maven profile",
  "Spring Profile": "Spring profile",
  "可执行 JAR": "Executable JAR",
  "先构建，再选择唯一 JAR": "Build, then use the only JAR",
  "完整 JDK 主目录": "Full JDK home",
  留空自动检测所选版本: "Leave blank to detect the selected version",
  "JVM 参数": "JVM arguments",
  应用参数: "Application arguments",
  "环境变量 · 仅本次运行": "Environment variables · this run only",
  "逐行填写 KEY=value": "One KEY=value per line",
  跳过测试: "Skip tests",
  "Maven 离线模式": "Maven offline mode",
  保存配置: "Save configuration",
  进程运行中: "Process running",
  任务成功: "Task succeeded",
  "已退出，退出码 {code}": "Exited with code {code}",
  未运行: "Not running",
  "Maven 构建目标": "Maven build goal",
  "打包 package": "Package",
  "测试 test": "Test",
  "安装 install": "Install",
  构建: "Build",
  运行: "Run",
  重新运行: "Rerun",
  停止: "Stop",
  强制停止: "Force stop",
  任务日志: "Task output",
  "选择模块后构建或运行，输出显示在这里。":
    "Select a module and build or run. Output appears here.",
};
