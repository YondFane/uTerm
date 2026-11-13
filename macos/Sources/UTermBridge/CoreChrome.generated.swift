// Generated from chrome-ui-v1.json; run pnpm chrome:generate.
// 由 chrome-ui-v1.json 生成；执行 pnpm chrome:generate。

import Foundation

public enum CoreSidebarIcon: String, CaseIterable, Sendable {
    case home, folder, folderClosed, terminal, sqlDatabase, database, sidebarRight, sidebar, chevron, plus, more, branch
}

public enum CoreToolbarIcon: String, CaseIterable, Sendable {
    case folder, copy, python, java, swap, compare, previous, next, expandAll, collapseAll, info, command, settings, agent, github, gitlab, files, newFile, newFolder, splitRight, splitDown, maximize, restore, search, quick, tree, close, remove, link, restart
}

public enum CoreChrome {
    public static let contractSHA256 = "f0a50e18d5977f706a4e419b2f43b99efc846d818e6b46722933e527a06d0a5d"
    public static let titlebarHeight: Double = 44
    public static let sidebarRailWidth: Double = 48
    public static let sidebarDefaultWidth: Double = 248
    public static let sidebarMaximumWidth: Double = 320
    public static let sidebarMinimumWide: Double = 180
    public static let sidebarMaximumRatio: Double = 0.3
    public static let railButtonSize: Double = 34
    public static let railIconSize: Double = 18
    public static let toolbarIconSize: Double = 17
    public static let sidebarIconSize: Double = 15
    public static let sidebarRowHeight: Double = 32
    public static let sidebarSectionHeight: Double = 32
    public static let sidebarSectionGap: Double = 18
    public static let sidebarListTop: Double = 8
    public static let sidebarRowCorner: Double = 5
    public static let panelCollapseWidth: Double = 30
    public static let mainMinimumWidth: Double = 320
    public static let inspectorMinimumAvailable: Double = 350
    public static let inspectorMaximumRatio: Double = 0.6
    public static let inspectorDefaultRatio: Double = 0.35
    public static let javaPanelDefaultHeight: Double = 380
    public static let pythonPanelDefaultHeight: Double = 470
    public static let runPanelMinimumHeight: Double = 240
    public static let runPanelCompactMinimumHeight: Double = 200
    public static let runPanelCompactViewportHeight: Double = 550
    public static let runPanelReservedHeight: Double = 88
    public static let runPanelExpandedTop: Double = 80
    public static let runPanelResizeStep: Double = 24
    public static let runPanelHeaderHeight: Double = 46
    public static let runPanelTwoColumnViewportWidth: Double = 900
    public static let pythonInterpreterFullRowViewportWidth: Double = 850
    public static let sidebar: [String: String] = [
        "home": "M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9",
        "folder": "M3 8V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v1M3 8h5l2 3h11l-2 8H5a2 2 0 0 1-2-2Z",
        "folderClosed": "M3 7V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
        "terminal": "M8 9l3 3-3 3m6 0h3M8 3h8q5 0 5 5v8q0 5-5 5H8q-5 0-5-5V8q0-5 5-5Z",
        "sqlDatabase": "M20 5c0 1.7-3.6 3-8 3S4 6.7 4 5s3.6-3 8-3 8 1.3 8 3ZM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
        "database": "m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5",
        "sidebarRight": "M8 3h8q5 0 5 5v8q0 5-5 5H8q-5 0-5-5V8q0-5 5-5Zm7 0v18",
        "sidebar": "M8 3h8q5 0 5 5v8q0 5-5 5H8q-5 0-5-5V8q0-5 5-5Zm1 0v18M5.5 7h1m-1 3h1",
        "chevron": "m8 5 7 7-7 7",
        "plus": "M12 5v14M5 12h14",
        "more": "M5 12h.01M12 12h.01M19 12h.01",
        "branch": "M6 8v8m12-8a7 7 0 0 1-7 7H6M6 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"
    ]
    public static let toolbar: [String: String] = [
        "folder": "M3 6h6l2 2h10v12H3ZM3 6V4h6l2 2h10v2",
        "copy": "M8 8h13v13H8ZM16 8V3H3v13h5",
        "python": "M12 3H8a3 3 0 0 0-3 3v3h8v2H5a3 3 0 0 0-3 3v1a3 3 0 0 0 3 3h3v-4h8V6a3 3 0 0 0-3-3Zm0 18h4a3 3 0 0 0 3-3v-3h-8v-2h8a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3h-1v8h-8v4a3 3 0 0 0 3 3M8 6h.01M16 18h.01",
        "java": "M12 2 3.34 7v10L12 22l8.66-5V7ZM12 6v6M8.6 8.8a5 5 0 1 0 6.8 0",
        "swap": "M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4",
        "compare": "M12 3v18M3 7h6L6 4m3 3-3 3m15 7h-6l3-3m-3 3 3 3",
        "previous": "m14 6-6 6 6 6",
        "next": "m10 6 6 6-6 6",
        "expandAll": "m7 6 5 5 5-5m-10 7 5 5 5-5",
        "collapseAll": "m7 11 5-5 5 5m-10 7 5-5 5 5",
        "info": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 8v6m0-10v.01",
        "command": "M5 7l4 5-4 5m7 0h7",
        "settings": "M4 7h16M4 17h16M8 4v6m8 4v6",
        "agent": "M9 3h6m-3 0v3M5 7h14v13H5ZM8 11v2m8-2v2m-7 4h6M2 11v5m20-5v5",
        "github": "M9 19c-4 1-4-2-6-2m12 5v-4c0-1-.3-1.7-1-2 3-.3 6-1.5 6-6 0-1.3-.4-2.3-1.2-3.2.2-1 .1-2-.3-3-1.5 0-3 .7-3.8 1.3a13 13 0 0 0-6.4 0C7.5 4.5 6 3.8 4.5 3.8c-.4 1-.5 2-.3 3C3.4 7.7 3 8.7 3 10c0 4.5 3 5.7 6 6-.7.3-1 1-1 2v4",
        "gitlab": "M12 21 2 14 5 3l4 8h6l4-8 3 11ZM2 14h7l3 7 3-7h7M9 11v3m6-3v3",
        "files": "M8 3h8l4 4v13H8ZM16 3v5h4M4 7v15h12",
        "newFile": "M5 3h9l4 4v4M14 3v5h4M5 3v18h7m5-7v8m-4-4h8",
        "newFolder": "M3 7V5h6l2 2h10v6M3 7v13h9m5-6v8m-4-4h8",
        "splitRight": "M3 4h18v16H3Zm9 0v16",
        "splitDown": "M3 4h18v16H3Zm0 8h18",
        "maximize": "M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6",
        "restore": "M3 9h6V3m6 0v6h6M9 21v-6H3m18 0h-6v6",
        "search": "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6",
        "quick": "M5 3h10l4 4v14H5ZM14 3v5h5M8 12h7m-7 4h4",
        "tree": "M4 3v14h4M4 7h4m3-3h9v6h-9Zm0 10h9v6h-9Z",
        "close": "m6 6 12 12M6 18 18 6",
        "remove": "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6",
        "link": "M9 15l6-6m-5-3 2-2a5 5 0 0 1 7 7l-2 2m-3 5-2 2a5 5 0 0 1-7-7l2-2",
        "restart": "M20 7v5h-5m5 0a8 8 0 1 0-2 6"
    ]
}
