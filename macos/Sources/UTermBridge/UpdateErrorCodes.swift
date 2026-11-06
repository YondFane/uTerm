import Foundation

// SDK installation errors can wrap the actual signature failure; preserve both without logging userInfo.
// SDK 安装错误可能包裹实际的签名失败；保留两者的代码，不记录 userInfo。
public func updateErrorCodes(_ error: Error) -> [String] {
    var codes: [String] = []
    var visited = Set<ObjectIdentifier>()
    func append(_ value: NSError, depth: Int) {
        guard depth < 8, codes.count < 64, visited.insert(ObjectIdentifier(value)).inserted else { return }
        codes.append(value.domain + ":" + String(value.code))
        if let underlying = value.userInfo[NSUnderlyingErrorKey] as? NSError { append(underlying, depth: depth + 1) }
        for key in ["NSMultipleUnderlyingErrors", "NSDetailedErrors"] {
            for underlying in value.userInfo[key] as? [NSError] ?? [] { append(underlying, depth: depth + 1) }
        }
    }
    append(error as NSError, depth: 0)
    return codes
}
