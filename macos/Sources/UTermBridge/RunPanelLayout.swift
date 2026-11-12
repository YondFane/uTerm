import Foundation

public struct RunPanelLayout: Equatable, Sendable {
    public let height: Double
    public let minimum: Double
    public let maximum: Double
    public let expandedTop: Double

    public init(kind: String, available: Double, viewport: Double, requested: Double?) {
        let available = max(0, available.isFinite ? available : 0)
        maximum = max(0, available - CoreChrome.runPanelReservedHeight)
        let compact = kind == "java" && viewport <= CoreChrome.runPanelCompactViewportHeight
        minimum = min(compact ? CoreChrome.runPanelCompactMinimumHeight : CoreChrome.runPanelMinimumHeight, maximum)
        let fallback = kind == "python" ? CoreChrome.pythonPanelDefaultHeight : CoreChrome.javaPanelDefaultHeight
        let candidate = requested.flatMap { $0.isFinite ? $0 : nil } ?? fallback
        height = max(minimum, min(maximum, candidate.rounded()))
        expandedTop = min(available, viewport <= CoreChrome.runPanelCompactViewportHeight ? CoreChrome.titlebarHeight : CoreChrome.runPanelExpandedTop)
    }
}
