import Foundation

// SDK installation errors can wrap the actual signature failure; preserve both without logging userInfo.
// SDK 安装错误可能包裹实际的签名失败；保留两者的代码，不记录 userInfo。
private func updateErrorChain(_ error: Error) -> [NSError] {
    var chain: [NSError] = []
    var visited = Set<ObjectIdentifier>()
    func append(_ value: NSError, depth: Int) {
        guard depth < 8, chain.count < 64, visited.insert(ObjectIdentifier(value)).inserted else { return }
        chain.append(value)
        if let underlying = value.userInfo[NSUnderlyingErrorKey] as? NSError { append(underlying, depth: depth + 1) }
        for key in ["NSMultipleUnderlyingErrors", "NSDetailedErrors"] {
            for underlying in value.userInfo[key] as? [NSError] ?? [] { append(underlying, depth: depth + 1) }
        }
    }
    append(error as NSError, depth: 0)
    return chain
}

public func updateErrorCodes(_ error: Error) -> [String] { updateErrorChain(error).map { $0.domain + ":" + String($0.code) } }

// Sparkle 2.10.1's Ed25519 verifier uses SUValidationError, also used for unrelated failures.
// Sparkle 2.10.1 的 Ed25519 验证器使用 SUValidationError，此代码也会用于无关错误。
public func updateHasSignatureMismatch(_ error: Error) -> Bool {
    updateErrorChain(error).contains { value in
        value.domain == "SUSparkleErrorDomain" && value.code == 3002 &&
        (value.userInfo[NSLocalizedDescriptionKey] as? String)?.hasPrefix("EdDSA signature does not match.") == true
    }
}
