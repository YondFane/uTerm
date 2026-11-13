import Foundation

public struct RunPanelLayout: Equatable, Sendable {
    public static func formColumns(viewportWidth: Double) -> Int {
        viewportWidth.isFinite && viewportWidth > CoreChrome.runPanelTwoColumnViewportWidth ? 3 : 2
    }
    public static func interpreterFillsRow(viewportWidth: Double) -> Bool {
        !viewportWidth.isFinite || viewportWidth <= CoreChrome.pythonInterpreterFullRowViewportWidth
    }

    public static func formGridMatches(_ bounds: CGRect, fields: [CGRect], columns: Int, interpreterFullRow: Bool, scale: Double) -> Bool {
        guard [2, 3].contains(columns), fields.count == 3, scale.isFinite, scale > 0, scale <= 8,
              [bounds.minX, bounds.minY, bounds.width, bounds.height].allSatisfy({ $0.isFinite }), bounds.width > 24, bounds.height > 0,
              fields.allSatisfy({ [$0.minX, $0.minY, $0.width, $0.height].allSatisfy({ $0.isFinite }) && $0.width > 0 && $0.height > 0 }) else { return false }
        let origin = Double(bounds.minX), width = Double(bounds.width), gap = 12.0
        let columnWidth = (width - gap * Double(columns - 1)) / Double(columns), epsilon = 0.000001
        func rasterized(_ actual: Double, _ ideal: Double) -> Bool {
            // AppKit may allocate adjacent columns to different physical pixels; require the measured grid's floor/ceiling bounds.
            // AppKit 可能将相邻列分配到不同物理像素；必须符合实测网格的向下／向上取整边界。
            actual >= floor(ideal * scale) / scale - epsilon && actual <= ceil(ideal * scale) / scale + epsilon
        }
        func placed(_ field: CGRect, column: Int, full: Bool = false) -> Bool {
            let left = origin + Double(column) * (columnWidth + gap), expectedWidth = full ? width : columnWidth
            return rasterized(Double(field.minX), left) && rasterized(Double(field.width), expectedWidth)
                && rasterized(Double(field.maxX), left + expectedWidth)
                && Double(field.maxX) <= ceil((origin + width) * scale) / scale + epsilon
        }
        func sameRow(_ left: CGRect, _ right: CGRect) -> Bool { abs(Double(left.minY - right.minY)) < 1 / scale }
        let first = fields[0], second = fields[1], third = fields[2]
        if interpreterFullRow {
            return columns == 2 && placed(first, column: 0, full: true) && placed(second, column: 0) && placed(third, column: 1)
                && sameRow(second, third) && second.minY >= first.maxY
        }
        guard placed(first, column: 0), placed(second, column: 1), sameRow(first, second) else { return false }
        return columns == 3 ? placed(third, column: 2) && sameRow(first, third)
            : placed(third, column: 0) && third.minY >= max(first.maxY, second.maxY)
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
