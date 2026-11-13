import Foundation

public enum ProjectRunRoots {
    public static func key(_ path: String) -> String {
        var display = path
        let windows = path.replacingOccurrences(of: "/", with: "\\")
        if windows.range(of: #"^\\\\\?\\[a-z]:\\"#, options: [.regularExpression, .caseInsensitive]) != nil {
            display = String(windows.dropFirst(4))
        } else if windows.lowercased().hasPrefix("\\\\?\\unc\\") {
            display = "\\\\" + windows.dropFirst(8)
        } else if path.range(of: #"^[a-z]:[\\/]|^\\\\"#, options: [.regularExpression, .caseInsensitive]) != nil {
            display = windows
        }
        let isWindows = display.range(of: #"^[a-z]:[\\/]|^\\\\"#, options: [.regularExpression, .caseInsensitive]) != nil
        while display.last == "/" || display.last == "\\" { display.removeLast() }
        return isWindows ? display.lowercased() : display
    }

    public static func languages(_ tasks: [JSONValue]) -> [String: String] {
        var roots: [String: String] = [:]
        // Match the ordinary summary: Python wins when both languages run at the same root.
        // 对齐普通版汇总：同一根目录同时运行两种语言时显示 Python。
        for language in ["java", "python"] {
            for task in tasks where task["running"].bool == true {
                let action = task["task"]["action"].string ?? ""
                let matches = language == "java" ? action == "run" : action == "python:run" || action.hasPrefix("python:run|")
                if matches, let root = task["task"]["root"].string, !root.isEmpty { roots[key(root)] = language }
            }
        }
        return roots
    }
}
