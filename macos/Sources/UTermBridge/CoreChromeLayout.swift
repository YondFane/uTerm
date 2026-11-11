public enum CoreChromeLayout {
    public struct Sidebar: Equatable, Sendable {
        public let width: Double
        public let minimum: Double
        public let maximum: Double
        public let hidden: Bool
    }
    public static let sidebarCollapseWidth = CoreChrome.sidebarRailWidth + CoreChrome.panelCollapseWidth
    public static func sidebar(available: Double, requested: Double) -> Sidebar {
        let maximum = max(CoreChrome.sidebarMinimumWide, min(CoreChrome.sidebarMaximumWidth, available * CoreChrome.sidebarMaximumRatio))
        return Sidebar(width: max(CoreChrome.sidebarRailWidth, min(maximum, requested)), minimum: CoreChrome.sidebarRailWidth, maximum: maximum, hidden: requested <= sidebarCollapseWidth)
    }
    public struct Inspector: Equatable, Sendable {
        public let available: Double
        public let minimum: Double
        public let maximum: Double
        public let width: Double
        public let ratio: Double
    }
    public static func inspector(available width: Double, ratio: Double) -> Inspector {
        let available = max(CoreChrome.inspectorMinimumAvailable, width)
        let maximum = min(available - CoreChrome.mainMinimumWidth, available * CoreChrome.inspectorMaximumRatio)
        let bounded = max(CoreChrome.panelCollapseWidth, min(maximum, available * ratio))
        return Inspector(available: available, minimum: CoreChrome.panelCollapseWidth, maximum: maximum, width: bounded, ratio: bounded / available)
    }
}
