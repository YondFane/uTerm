import AppKit
import CoreText
import CryptoKit
import UTermBridge

@MainActor
enum NativeBundledFonts {
    private struct Manifest: Decodable { let family: String; let version: String; let files: [String: String] }
    static private(set) var regularSHA256 = ""
    static func register() throws {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("Fonts") else { throw BridgeFailure(code: "BUNDLED_FONT", message: "Missing font resources") }
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: root.appendingPathComponent("manifest.json")))
        guard manifest.family == "Cascadia Code", manifest.version == "2407.24", manifest.files.count == 5 else { throw BridgeFailure(code: "BUNDLED_FONT", message: "Invalid bundled font manifest") }
        for (name, expected) in manifest.files {
            guard name.hasPrefix("CascadiaCode-"), name.hasSuffix(".ttf"), !name.contains("/"), !name.contains("\\") else { throw BridgeFailure(code: "BUNDLED_FONT", message: "Invalid font path") }
            let url = root.appendingPathComponent(name)
            let data = try Data(contentsOf: url)
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard digest == expected else { throw BridgeFailure(code: "BUNDLED_FONT", message: "Bundled font checksum mismatch: " + name) }
            var error: Unmanaged<CFError>?
            guard CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) else {
                let message = error.map { CFErrorCopyDescription($0.takeRetainedValue()) as String } ?? "Font registration failed"
                throw BridgeFailure(code: "BUNDLED_FONT", message: message)
            }
            if name == "CascadiaCode-Regular.ttf" { regularSHA256 = digest }
        }
        guard NSFont(name: "CascadiaCode-Regular", size: 17)?.familyName == "Cascadia Code" else { throw BridgeFailure(code: "BUNDLED_FONT", message: "Registered font family is unavailable") }
    }
}
