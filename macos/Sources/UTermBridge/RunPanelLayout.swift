import Foundation

public struct RunPanelLayout: Equatable, Sendable {
    public static func formColumns(viewportWidth: Double) -> Int {
        viewportWidth.isFinite && viewportWidth > CoreChrome.runPanelTwoColumnViewportWidth ? 3 : 2
    }
    public static func interpreterFillsRow(viewportWidth: Double) -> Bool {
        !viewportWidth.isFinite || viewportWidth <= CoreChrome.pythonInterpreterFullRowViewportWidth
    }

    public static func toolbar(width: Double, items: [CoreChromeLayout.HeaderItem]) -> CoreChromeLayout.HeaderFlow {
        let width = max(0, width.isFinite ? width : 0), gap = 6.0
        let widths = items.map { $0.id == "spacer" ? 0 : min(width, max(0, $0.width.isFinite ? $0.width : 0)) }
        var rows: [[Int]] = [], row: [Int] = [], used = 0.0
        for index in items.indices {
            if !row.isEmpty && used + gap + widths[index] > width { rows.append(row); row = []; used = 0 }
            used += (row.isEmpty ? 0 : gap) + widths[index]; row.append(index)
        }
        if !row.isEmpty { rows.append(row) }
        var frames = Array(repeating: CoreChromeLayout.HeaderFrame(x: 0, y: 0, width: 0, height: 0), count: items.count), top = 0.0
        for row in rows {
            let height = row.map { max(0, items[$0].height.isFinite ? items[$0].height : 0) }.max() ?? 0
            let occupied = row.reduce(0.0) { $0 + widths[$1] } + gap * Double(max(0, row.count - 1))
            let spaces = row.filter { items[$0].id == "spacer" }.count
            var left = 0.0
            for index in row {
                let actualWidth = widths[index] + (items[index].id == "spacer" && spaces > 0 ? max(0, width - occupied) / Double(spaces) : 0)
                let itemHeight = max(0, items[index].height.isFinite ? items[index].height : 0)
                frames[index] = .init(x: left, y: top + (height - itemHeight) / 2, width: actualWidth, height: itemHeight)
                left += actualWidth + gap
            }
            top += height + gap
        }
        return .init(height: max(0, top - (rows.isEmpty ? 0 : gap)), frames: frames)
    }

    public let height: Double
    public let minimum: Double
    public let maximum: Double
    public let expandedTop: Double
    public let expandedHeight: Double

    public init(kind: String, available: Double, viewport: Double, requested: Double?) {
        let available = max(0, available.isFinite ? available : 0)
        maximum = max(0, available - CoreChrome.runPanelReservedHeight)
        let compact = kind == "java" && viewport <= CoreChrome.runPanelCompactViewportHeight
        minimum = min(compact ? CoreChrome.runPanelCompactMinimumHeight : CoreChrome.runPanelMinimumHeight, maximum)
        let fallback = kind == "python" ? CoreChrome.pythonPanelDefaultHeight : CoreChrome.javaPanelDefaultHeight
        let candidate = requested.flatMap { $0.isFinite ? $0 : nil } ?? fallback
        height = max(minimum, min(maximum, candidate.rounded()))
        expandedTop = min(available, viewport <= CoreChrome.runPanelCompactViewportHeight ? CoreChrome.titlebarHeight : CoreChrome.runPanelExpandedTop)
        // The expanded inset is measured from the window; available space starts below the titlebar.
        // 展开位置相对窗口计算，可用空间则从标题栏下方开始。
        expandedHeight = max(0, available - max(0, expandedTop - CoreChrome.titlebarHeight))
    }
}
