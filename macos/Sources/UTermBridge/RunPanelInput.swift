import Foundation

public enum RunPanelInput {
    public enum Invalid: Error, Equatable { case arguments, environment }

    private static func whitespace(_ scalar: Unicode.Scalar) -> Bool {
        // Match ECMAScript whitespace; Foundation also treats U+0085 as a separator.
        // 对齐 ECMAScript 空白规则；Foundation 还会将 U+0085 视为分隔符。
        switch scalar.value {
        case 9...13, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        default: return false
        }
    }

    public static func arguments(_ text: String) throws -> [String] {
        let scalars = Array(text.unicodeScalars)
        var result: [String] = [], value = "", quote: Unicode.Scalar?, present = false, index = 0
        while index < scalars.count {
            let scalar = scalars[index]
            guard scalar.value != 0 else { throw Invalid.arguments }
            if scalar == "\\", let quote, index + 1 < scalars.count,
               scalars[index + 1] == quote || scalars[index + 1] == "\\" {
                value.unicodeScalars.append(scalars[index + 1]); present = true; index += 2; continue
            }
            if let current = quote {
                if scalar == current { quote = nil } else { value.unicodeScalars.append(scalar) }
                present = true
            } else if scalar == "\"" || scalar == "'" {
                quote = scalar; present = true
            } else if whitespace(scalar) {
                if present { result.append(value); value = ""; present = false }
            } else { value.unicodeScalars.append(scalar); present = true }
            index += 1
        }
        guard quote == nil else { throw Invalid.arguments }
        if present { result.append(value) }
        return result
    }

    public static func formatArguments(_ values: [String], retaining input: String? = nil) -> String {
        if let input, let parsed = try? arguments(input), parsed.map({ Array($0.utf8) }) == values.map({ Array($0.utf8) }) { return input }
        return values.map { value in
            if value.isEmpty || value.contains("\"") || value.contains("'") || value.unicodeScalars.contains(where: whitespace) {
                return "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
            }
            return value
        }.joined(separator: " ")
    }

    public static func environment(_ text: String) throws -> [String: String] {
        // Split LF scalars so a CRLF grapheme cannot hide the separator.
        // 按 LF 码点分行，避免 CRLF 字素隐藏分隔符。
        let lines = text.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false).map { String(String.UnicodeScalarView($0)) }
        var result: [String: String] = [:], names: Set<String> = []
        for (index, raw) in lines.enumerated() {
            let line = index < lines.count - 1 && raw.hasSuffix("\r") ? String(raw.dropLast()) : raw
            if line.unicodeScalars.allSatisfy(whitespace) { continue }
            guard let equal = line.firstIndex(of: "=") else { throw Invalid.environment }
            let name = String(line[..<equal]), value = String(line[line.index(after: equal)...])
            guard let first = name.unicodeScalars.first, first == "_" || (65...90).contains(first.value) || (97...122).contains(first.value),
                  name.unicodeScalars.allSatisfy({ $0 == "_" || (65...90).contains($0.value) || (97...122).contains($0.value) || (48...57).contains($0.value) }),
                  !value.unicodeScalars.contains(where: { [10, 13, 0x2028, 0x2029].contains($0.value) }),
                  !name.uppercased().hasPrefix("UTERM_"), names.insert(name.uppercased()).inserted else { throw Invalid.environment }
            result[name] = value
        }
        return result
    }
}
