import CoreGraphics
import Foundation

public enum ChromeVectorError: Error { case invalidPath }

public enum ChromeVectorPath {
    public static func parse(_ source: String) throws -> CGPath {
        guard source.count <= 32000 else { throw ChromeVectorError.invalidPath }
        let pattern = "[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:[0-9]*\\.[0-9]+|[0-9]+\\.?[0-9]*)(?:[eE][-+]?[0-9]+)?"
        let regex = try NSRegularExpression(pattern: pattern)
        let range = NSRange(source.startIndex..., in: source)
        let matches = regex.matches(in: source, range: range)
        let remainder = regex.stringByReplacingMatches(in: source, range: range, withTemplate: "")
        guard remainder.trimmingCharacters(in: CharacterSet(charactersIn: " ,\n\r\t")).isEmpty else { throw ChromeVectorError.invalidPath }
        let tokens = matches.compactMap { Range($0.range, in: source).map { String(source[$0]) } }
        var parser = Parser(tokens: tokens)
        return try parser.run()
    }

    private struct Parser {
        let tokens: [String]
        var index = 0
        var point = CGPoint.zero
        var start = CGPoint.zero
        var cubic: CGPoint?
        var quadratic: CGPoint?
        let path = CGMutablePath()
        mutating func number() throws -> CGFloat {
            guard index < tokens.count, let value = Double(tokens[index]), value.isFinite, abs(value) <= 1_000_000 else { throw ChromeVectorError.invalidPath }
            index += 1; return CGFloat(value)
        }
        mutating func pair(_ relative: Bool) throws -> CGPoint {
            let x = try number(), y = try number()
            return CGPoint(x: x + (relative ? point.x : 0), y: y + (relative ? point.y : 0))
        }
        mutating func flag() throws -> Bool {
            let value = try number()
            guard value == 0 || value == 1 else { throw ChromeVectorError.invalidPath }
            return value == 1
        }
        mutating func run() throws -> CGPath {
            guard tokens.first?.lowercased() == "m" else { throw ChromeVectorError.invalidPath }
            var command: String?
            while index < tokens.count {
                if tokens[index].count == 1, tokens[index].first?.isLetter == true { command = tokens[index]; index += 1 }
                guard let code = command else { throw ChromeVectorError.invalidPath }
                let relative = code == code.lowercased()
                switch code.lowercased() {
                case "m":
                    point = try pair(relative); start = point; path.move(to: point)
                    command = relative ? "l" : "L"; cubic = nil; quadratic = nil
                case "l": point = try pair(relative); path.addLine(to: point); cubic = nil; quadratic = nil
                case "h":
                    let x = try number(); point.x = x + (relative ? point.x : 0); path.addLine(to: point); cubic = nil; quadratic = nil
                case "v":
                    let y = try number(); point.y = y + (relative ? point.y : 0); path.addLine(to: point); cubic = nil; quadratic = nil
                case "c":
                    let first = try pair(relative), second = try pair(relative), end = try pair(relative)
                    path.addCurve(to: end, control1: first, control2: second); point = end; cubic = second; quadratic = nil
                case "s":
                    let first = cubic.map { CGPoint(x: 2 * point.x - $0.x, y: 2 * point.y - $0.y) } ?? point
                    let second = try pair(relative), end = try pair(relative)
                    path.addCurve(to: end, control1: first, control2: second); point = end; cubic = second; quadratic = nil
                case "q", "t":
                    let control: CGPoint
                    if code.lowercased() == "q" { control = try pair(relative) }
                    else { control = quadratic.map { CGPoint(x: 2 * point.x - $0.x, y: 2 * point.y - $0.y) } ?? point }
                    let end = try pair(relative)
                    path.addQuadCurve(to: end, control: control); point = end; quadratic = control; cubic = nil
                case "a":
                    let rx = try number(), ry = try number(), rotation = try number(), large = try flag(), sweep = try flag(), end = try pair(relative)
                    try arc(to: end, rx: abs(rx), ry: abs(ry), rotation: rotation, large: large, sweep: sweep)
                    point = end; cubic = nil; quadratic = nil
                case "z": path.closeSubpath(); point = start; cubic = nil; quadratic = nil; command = nil
                default: throw ChromeVectorError.invalidPath
                }
            }
            return path
        }
        func arc(to end: CGPoint, rx originalRX: CGFloat, ry originalRY: CGFloat, rotation: CGFloat, large: Bool, sweep: Bool) throws {
            if point == end { return }
            guard originalRX > 0, originalRY > 0 else { path.addLine(to: end); return }
            let phi = rotation * .pi / 180, cosPhi = cos(phi), sinPhi = sin(phi)
            let dx = (point.x - end.x) / 2, dy = (point.y - end.y) / 2
            let x = cosPhi * dx + sinPhi * dy, y = -sinPhi * dx + cosPhi * dy
            let scale = max(1, hypot(x / originalRX, y / originalRY))
            let rx = originalRX * scale, ry = originalRY * scale
            guard rx.isFinite, ry.isFinite, rx <= 1e12, ry <= 1e12 else { throw ChromeVectorError.invalidPath }
            let denominator = rx * rx * y * y + ry * ry * x * x
            guard denominator.isFinite, denominator > 0 else { throw ChromeVectorError.invalidPath }
            let numerator = max(0, rx * rx * ry * ry - denominator)
            let sign: CGFloat = large == sweep ? -1 : 1
            let factor = sign * sqrt(numerator / denominator)
            let cxPrime = factor * rx * y / ry, cyPrime = -factor * ry * x / rx
            let cx = cosPhi * cxPrime - sinPhi * cyPrime + (point.x + end.x) / 2
            let cy = sinPhi * cxPrime + cosPhi * cyPrime + (point.y + end.y) / 2
            let ux = (x - cxPrime) / rx, uy = (y - cyPrime) / ry
            let vx = (-x - cxPrime) / rx, vy = (-y - cyPrime) / ry
            let angle = atan2(uy, ux)
            var delta = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
            if sweep && delta < 0 { delta += 2 * .pi }
            if !sweep && delta > 0 { delta -= 2 * .pi }
            let count = max(1, Int(ceil(abs(delta) / (.pi / 2))))
            func position(_ value: CGFloat) -> CGPoint { CGPoint(x: cx + rx * cosPhi * cos(value) - ry * sinPhi * sin(value), y: cy + rx * sinPhi * cos(value) + ry * cosPhi * sin(value)) }
            func derivative(_ value: CGFloat) -> CGPoint { CGPoint(x: -rx * cosPhi * sin(value) - ry * sinPhi * cos(value), y: -rx * sinPhi * sin(value) + ry * cosPhi * cos(value)) }
            for index in 0..<count {
                let a = angle + delta * CGFloat(index) / CGFloat(count), b = angle + delta * CGFloat(index + 1) / CGFloat(count)
                let alpha = (4.0 / 3.0) * tan((b - a) / 4)
                let first = position(a), last = position(b), firstDerivative = derivative(a), lastDerivative = derivative(b)
                path.addCurve(to: index + 1 == count ? end : last,
                              control1: CGPoint(x: first.x + alpha * firstDerivative.x, y: first.y + alpha * firstDerivative.y),
                              control2: CGPoint(x: last.x - alpha * lastDerivative.x, y: last.y - alpha * lastDerivative.y))
            }
        }
    }
}
