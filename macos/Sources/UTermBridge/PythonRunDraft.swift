import Foundation

public enum PythonRunDraft {
    public static func serviceURL(task: JSONValue) -> URL? {
        let parts = (task["task"]["action"].string ?? "").split(separator: "|", omittingEmptySubsequences: false)
        guard parts.count > 1, !parts[1].isEmpty, let components = URLComponents(string: String(parts[1])),
              components.scheme == "http", let host = components.host, !host.isEmpty,
              host.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "0123456789abcdefABCDEF.:[]").contains($0) }),
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              ["", "/"].contains(components.path), components.port.map({ (1...65535).contains($0) }) ?? true else { return nil }
        return components.url
    }

    public static func make(project: CorePythonRunConfig, configured: Bool, candidates: [JSONValue], interpreters: [JSONValue]) -> CorePythonRunConfig {
        guard !configured else { return project }
        let frameworks = candidates.filter { !["script", "module"].contains($0["mode"].string ?? "") }
        let main = candidates.filter { $0["mode"].string == "script" && ($0["target"].string ?? "").split(separator: "/").last == "main.py" }
        let preferred = !frameworks.isEmpty ? frameworks : !main.isEmpty ? main : candidates
        var draft = project
        if preferred.count == 1 {
            draft.mode = preferred[0]["mode"].string
            draft.target = preferred[0]["target"].string
            draft.working_directory = preferred[0]["working_directory"].string
        }
        draft.interpreter = interpreters.first?["path"].string ?? ""
        draft.port = preferred.count == 1 && preferred[0]["mode"].string == "flask" ? 5000 : 8000
        return draft
    }

    public static func changingMode(_ project: CorePythonRunConfig, to mode: String, candidates: [JSONValue]) -> CorePythonRunConfig {
        let matches = candidates.filter { $0["mode"].string == mode }
        var draft = project
        draft.mode = mode
        draft.target = matches.count == 1 ? matches[0]["target"].string ?? "" : ""
        draft.working_directory = matches.count == 1 ? matches[0]["working_directory"].string ?? "." : "."
        draft.port = mode == "flask" ? 5000 : 8000
        return draft
    }
}
