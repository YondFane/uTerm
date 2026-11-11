public enum CoreChromeLayout {
    public struct Sidebar: Equatable, Sendable {
        public let width: Double
        public let minimum: Double
        public let maximum: Double
        public let hidden: Bool
    }
    public static let sidebarCollapseWidth = CoreChrome.sidebarRailWidth + 30
    public static func sidebar(available: Double, requested: Double) -> Sidebar {
        let maximum = max(CoreChrome.sidebarMinimumWide, min(CoreChrome.sidebarMaximumWidth, available * CoreChrome.sidebarMaximumRatio))
        return Sidebar(width: max(CoreChrome.sidebarRailWidth, min(maximum, requested)), minimum: CoreChrome.sidebarRailWidth, maximum: maximum, hidden: requested <= sidebarCollapseWidth)
    }
}
