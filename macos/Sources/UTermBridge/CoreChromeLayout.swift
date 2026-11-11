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
    public struct HeaderItem: Equatable, Sendable {
        public let id: String
        public let width: Double
        public let height: Double
        public init(_ id: String, width: Double, height: Double) { self.id = id; self.width = width; self.height = height }
    }
    public struct HeaderFrame: Equatable, Sendable {
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double
    }
    public struct HeaderFlow: Equatable, Sendable {
        public let height: Double
        public let frames: [HeaderFrame]
    }
    public static func terminalHeader(width: Double, items: [HeaderItem]) -> HeaderFlow {
        // Match the session-controls flex bases; the directory fills the remaining space in its row.
        // 对齐 session-controls 的弹性基础宽度，由目录填满其所在行的剩余空间。
        let width = max(0, width.isFinite ? width : 0), gap = 8.0
        let bases = items.map { item in item.id == "name" ? max(45, min(item.width, width * 0.25)) : item.id == "directory" ? 100 : item.width }
        var rows: [[Int]] = [], current: [Int] = [], used = 0.0
        for index in items.indices {
            let addition = bases[index] + (current.isEmpty ? 0 : gap)
            if !current.isEmpty && used + addition > width {
                rows.append(current); current = []; used = 0
            }
            used += bases[index] + (current.isEmpty ? 0 : gap); current.append(index)
        }
        if !current.isEmpty { rows.append(current) }
        var frames = Array(repeating: HeaderFrame(x: 0, y: 0, width: 0, height: 0), count: items.count), top = 0.0
        for row in rows {
            let height = row.map { items[$0].height }.max() ?? 0
            let occupied = row.reduce(0.0) { $0 + bases[$1] } + gap * Double(max(0, row.count - 1))
            var left = 0.0
            for index in row {
                let item = items[index]
                let actualWidth = item.id == "directory" ? max(0, bases[index] + width - occupied) : bases[index]
                frames[index] = HeaderFrame(x: left, y: top + (height - item.height) / 2, width: actualWidth, height: item.height)
                left += actualWidth + gap
            }
            top += height + gap
        }
        return HeaderFlow(height: max(25, top - (rows.isEmpty ? 0 : gap)) + 9, frames: frames)
    }
}
