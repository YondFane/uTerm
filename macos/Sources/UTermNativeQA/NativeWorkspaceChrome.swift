import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct NativeWorkspaceToolbar: View {
    @ObservedObject var model: WorkspaceModel
    var body: some View {
        HStack(spacing: 10) {
            tool("sidebar.left", localized("Toggle sidebar", "显示或隐藏侧栏")) { model.sidebarVisible.toggle() }
            tool("folder.badge.plus", localized("Open project", "打开项目")) { model.openProject() }
            tool("terminal", localized("New terminal", "新建终端")) { Task { await model.newTerminal() } }
            Menu {
                Button(localized("New Agent session", "新建 Agent 会话")) { Task { await model.newDefaultAgent() } }
                ForEach(model.environment["agents"].array.compactMap(\.string), id: \.self) { agent in
                    if model.settings["enabledAgents"].array.contains(.string(agent)) {
                        Button(agent) { Task { await model.newTerminal(agent: agent) } }
                    }
                }
                Divider()
                Button(localized("Manage Agents…", "管理 Agent…")) { model.openAgentsRequested?() }
            } label: { Image(systemName: "sparkle") }
            .help(localized("Agents", "Agent"))
            Spacer(minLength: 8)
            if model.busy { ProgressView().controlSize(.small) }
            tool("rectangle.split.2x1", localized("Split right", "向右分屏")) { Task { await model.split("horizontal") } }.disabled(model.selectedID == nil)
            tool("rectangle.split.1x2", localized("Split down", "向下分屏")) { Task { await model.split("vertical") } }.disabled(model.selectedID == nil)
            tool("gearshape", localized("Settings", "设置")) { model.openSettingsRequested?() }
            tool("sidebar.right", localized("Toggle tools", "显示或隐藏工具")) { if model.inspectorVisible { model.hideInspector() } else { model.showInspector(.files) } }
        }
        .buttonStyle(.borderless).controlSize(.small)
        .disabled(!model.ready || model.busy || model.gitFavoritesRecoveryPresented)
        .padding(.leading, model.fullScreen ? 12 : 83).padding(.trailing, 12)
        .frame(height: 40)
        .background(.bar)
        .background(GeometryReader { geometry in
            Color.clear.onAppear { model.measureToolbar(geometry.size.height) }
                .onChange(of: geometry.size.height) { _, height in model.measureToolbar(height) }
        })
        .accessibilityIdentifier("native-workspace-toolbar")
    }
    private func tool(_ symbol: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).frame(width: 24, height: 24) }
            .help(title).accessibilityLabel(title)
    }
}

@MainActor
struct NativeSidebarNavigation: View {
    @ObservedObject var model: WorkspaceModel
    var body: some View {
        VStack(spacing: 8) {
            Picker(localized("Workspace", "工作区"), selection: Binding(get: { model.groupID }, set: { id in Task { await model.mutate("workspace.switch", ["id": .string(id)]) } })) {
                ForEach(model.groupItems) { group in Text(group.name).tag(group.id) }
            }.labelsHidden()
            HStack(spacing: 4) {
                navigation("all", "square.grid.2x2", localized("All", "全部"))
                navigation("projects", "folder", localized("Projects", "项目"))
                navigation("sessions", "terminal", localized("Sessions", "会话"))
                if model.settings["showSshConnections"].bool != false { navigation("ssh", "network", localized("SSH connections", "SSH 连接")) }
                Spacer(minLength: 0)
            }.buttonStyle(.borderless)
            TextField(localized("Filter projects and sessions", "筛选项目和会话"), text: $model.sidebarQuery)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("native-sidebar-filter")
        }.padding(10).disabled(model.busy || model.gitFavoritesRecoveryPresented)
    }
    private func navigation(_ id: String, _ symbol: String, _ title: String) -> some View {
        Button { model.sidebarSection = id } label: {
            Image(systemName: symbol).frame(width: 28, height: 24)
                .background(model.sidebarSection == id ? Color.accentColor.opacity(0.18) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
        }.help(title).accessibilityLabel(title)
    }
}

@MainActor
struct NativeSessionTabs: View {
    @ObservedObject var model: WorkspaceModel
    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 2) {
                ForEach(model.sessionEntries, id: \.sessionID) { entry in
                    HStack(spacing: 6) {
                        Button { Task { await model.selectSession(entry.sessionID) } } label: {
                            Label(entry.session["name"].string ?? localized("Terminal", "终端"), systemImage: entry.session["agent"].string == nil ? "terminal" : "sparkle")
                                .lineLimit(1).frame(maxWidth: 180)
                        }
                        Button { Task { await model.closeSession(id: entry.sessionID) } } label: { Image(systemName: "xmark").font(.caption2) }
                            .help(localized("Close session", "关闭会话"))
                    }
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(model.selectedID == entry.sessionID ? Color.accentColor.opacity(0.18) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
                    .contextMenu {
                        Button(localized("Rename session", "重命名会话")) { model.renameSession(entry.sessionID) }
                        Button(localized("Close session", "关闭会话")) { Task { await model.closeSession(id: entry.sessionID) } }
                    }
                    .accessibilityIdentifier("native-session-tab-" + entry.sessionID)
                }
                Button { Task { await model.newTerminal() } } label: { Image(systemName: "plus").padding(8) }.help(localized("New terminal", "新建终端"))
            }.padding(.horizontal, 6)
        }
        .buttonStyle(.borderless).scrollIndicators(.hidden)
        .disabled(!model.ready || model.busy || model.gitFavoritesRecoveryPresented)
        .accessibilityIdentifier("native-session-tabs")
    }
}
