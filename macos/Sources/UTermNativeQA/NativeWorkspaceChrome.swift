import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct NativeWorkspaceToolbar: View {
    @ObservedObject var model: WorkspaceModel
    var sidebarWidth: CGFloat = CGFloat(CoreChrome.sidebarDefaultWidth)
    var body: some View {
        HStack(spacing: 8) {
            if !model.sidebarVisible {
                sidebarTool(.sidebar, localized("Show sidebar", "显示侧栏")) { model.sidebarVisible = true }
            }
            Text(model.projects.first { $0["id"] == model.workspace["selectedProject"] }?["name"].string ?? localized("Terminal", "终端"))
                .font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            if model.busy { ProgressView().controlSize(.small) }
            if model.workspace["selectedProject"].string != nil {
                tool(.java, localized("Java build and run…", "Java 构建与运行…")) { model.openJavaRequested?() }
                tool(.python, localized("Python run…", "Python 运行…")) { model.openPythonRequested?() }
            }
            tool(model.paneZoomed ? .restore : .maximize, localized("Toggle pane zoom", "切换面板缩放")) { model.performCommandRequested?("zoom") }.disabled(model.commandIsAvailable?("zoom") != true)
            sidebarTool(.sidebarRight, localized("Toggle tools", "显示或隐藏工具")) { if model.inspectorVisible { model.hideInspector() } else { model.showInspector(.files) } }
        }
        .buttonStyle(.borderless).controlSize(.small)
        .disabled(!model.ready || model.busy || model.gitFavoritesRecoveryPresented)
        .padding(.leading, model.fullScreen ? 18 : max(18, 96 - sidebarWidth)).padding(.trailing, 18)
        .frame(height: CGFloat(CoreChrome.titlebarHeight))
        .background(Color(nsColor: NativePreferences.color(NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog)["sidebar"], fallback: .windowBackgroundColor)))
        .overlay(alignment: .bottom) { Color(nsColor: NativePreferences.color(NativePreferences.interfacePalette(model.settings, catalog: model.settingsCatalog)["border"], fallback: .separatorColor)).frame(height: 1) }
        .background(NativeChromeMeasurement { frame in
            model.measureToolbar(frame.height); model.measureToolbarTop(frame.minY)
        }.allowsHitTesting(false))
        .accessibilityIdentifier("native-workspace-toolbar")
    }
    private func tool(_ icon: CoreToolbarIcon, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { NativeChromeIcon(toolbar: icon).frame(width: 24, height: 24) }
            .help(title).accessibilityLabel(title)
    }
    private func sidebarTool(_ icon: CoreSidebarIcon, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { NativeChromeIcon(sidebar: icon).frame(width: 24, height: 24) }.help(title).accessibilityLabel(title)
    }
}

@MainActor
struct NativeSidebarNavigation: View {
    @ObservedObject var model: WorkspaceModel
    var body: some View {
        HStack(spacing: 6) {
            Menu {
                ForEach(model.groupItems) { group in
                    Button(group.name) { Task { await model.mutate("workspace.switch", ["id": .string(group.id)]) } }
                }
                Divider()
                Button(localized("New workspace…", "新建工作区…")) { model.newWorkspace() }
                Button(localized("Rename workspace…", "重命名工作区…")) { model.renameWorkspace() }
                Button(localized("Delete workspace…", "删除工作区…")) { model.removeWorkspace() }.disabled(!model.canRemoveWorkspace)
            } label: {
                Text(model.groupItems.first { $0.id == model.groupID }?.name ?? localized("Workspace", "工作区"))
                    .font(.system(size: 12, weight: .semibold)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            }.menuStyle(.borderlessButton).menuIndicator(.hidden)
                .help(localized("Switch workspace", "切换工作区"))
                .accessibilityIdentifier("native-workspace-switcher")
            Button { model.sidebarVisible = false } label: { NativeChromeIcon(sidebar: .sidebar).frame(width: 18, height: 24) }
                .help(localized("Hide sidebar", "隐藏侧栏")).accessibilityLabel(localized("Hide sidebar", "隐藏侧栏"))
        }
        .buttonStyle(.borderless)
        .padding(.leading, model.fullScreen ? 0 : 36)
        .frame(height: CGFloat(CoreChrome.titlebarHeight))
        .disabled(!model.ready || model.busy || model.gitFavoritesRecoveryPresented)
    }
}

@MainActor
struct NativeSidebarRail: View {
    @ObservedObject var model: WorkspaceModel
    var body: some View {
        VStack(spacing: 6) {
            navigation("all", .home, localized("All", "全部"))
            navigation("projects", .folder, localized("Projects and sessions", "项目与会话"))
            if model.settings["showSshConnections"].bool != false { navigation("ssh", .terminal, localized("SSH connections", "SSH 连接")) }
            if model.settings["showRedisConnections"].bool != false { navigation("redis", .database, localized("Redis connections", "Redis 连接")) }
            if model.settings["showDatabaseConnections"].bool != false { navigation("database", .sqlDatabase, localized("Database connections", "数据库连接")) }
            Spacer(minLength: 12)
            Menu {
                Button(localized("Open project…", "打开项目…")) { model.openProject() }
                Button(localized("Open file…", "打开文件…")) { model.openFileRequested?() }.disabled(model.workspace["selectedProject"].string == nil)
                Button(localized("New terminal", "新建终端")) { Task { await model.newTerminal() } }
                Button(localized("New Agent session", "新建 Agent 会话")) { Task { await model.newDefaultAgent() } }
                ForEach(model.environment["agents"].array.compactMap(\.string), id: \.self) { agent in
                    if model.settings["enabledAgents"].array.contains(.string(agent)) {
                        Button(agent) { Task { await model.newTerminal(agent: agent) } }
                    }
                }
                Divider()
                Button(localized("SSH connections…", "SSH 连接…")) { model.openSSHRequested?(nil) }
                Button(localized("Databases…", "数据库…")) { model.openDatabasesRequested?() }
                Button(localized("Redis connections…", "Redis 连接…")) { model.openRedisRequested?() }
                Divider()
                Button(localized("Command palette", "命令面板")) { model.performCommandRequested?("palette") }.disabled(model.commandIsAvailable?("palette") != true)
                Button(localized("Split right", "向右分屏")) { Task { await model.split("horizontal") } }.disabled(model.selectedID == nil)
                Button(localized("Split down", "向下分屏")) { Task { await model.split("vertical") } }.disabled(model.selectedID == nil)
                Button(localized("Files", "文件")) { model.performCommandRequested?("files") }.disabled(model.commandIsAvailable?("files") != true)
                Button(localized("Quick open", "快速打开")) { model.performCommandRequested?("quick") }.disabled(model.commandIsAvailable?("quick") != true)
                Button(localized("Search file contents", "搜索文件内容")) { model.performCommandRequested?("search") }.disabled(model.commandIsAvailable?("search") != true)
                Button(localized("Swap tools position", "交换工具位置")) { model.performCommandRequested?("swapPanes") }.disabled(model.commandIsAvailable?("swapPanes") != true)
                Button("Git") { model.performCommandRequested?("git") }.disabled(model.commandIsAvailable?("git") != true)
                Button("GitHub") { model.performCommandRequested?("github") }.disabled(model.commandIsAvailable?("github") != true)
                Divider()
                Button(localized("New workspace…", "新建工作区…")) { model.newWorkspace() }
                Button(localized("Manage Agents…", "管理 Agent…")) { model.openAgentsRequested?() }
            } label: { NativeChromeIcon(sidebar: .plus, size: CGFloat(CoreChrome.railIconSize)).frame(width: CGFloat(CoreChrome.railButtonSize), height: CGFloat(CoreChrome.railButtonSize)) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).help(localized("Add", "添加"))
            Button { model.openSettingsRequested?() } label: {
                NativeChromeIcon(toolbar: .settings, size: CGFloat(CoreChrome.railIconSize)).frame(width: CGFloat(CoreChrome.railButtonSize), height: CGFloat(CoreChrome.railButtonSize))
            }.help(localized("Settings", "设置")).accessibilityLabel(localized("Settings", "设置"))
        }
        .buttonStyle(.borderless).padding(.horizontal, 6).padding(.top, CGFloat(CoreChrome.titlebarHeight) + 8).padding(.bottom, 8)
        .frame(width: CGFloat(CoreChrome.sidebarRailWidth))
        .disabled(!model.ready || model.busy || model.gitFavoritesRecoveryPresented)
        .accessibilityIdentifier("native-sidebar-rail")
    }
    private func navigation(_ id: String, _ icon: CoreSidebarIcon, _ title: String) -> some View {
        Button { model.sidebarSection = id; model.sidebarVisible = true } label: {
            NativeChromeIcon(sidebar: icon, size: CGFloat(CoreChrome.railIconSize))
                .frame(width: CGFloat(CoreChrome.railButtonSize), height: CGFloat(CoreChrome.railButtonSize))
                .background(model.sidebarSection == id ? Color.accentColor.opacity(0.18) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
        }.help(title).accessibilityLabel(title)
            .accessibilityAddTraits(model.sidebarSection == id ? .isSelected : [])
            .accessibilityIdentifier("native-sidebar-category-" + id)
    }
}
