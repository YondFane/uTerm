// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "UTermNative",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "UTermNativeQA", targets: ["UTermNativeQA"])],
    targets: [.executableTarget(name: "UTermNativeQA")]
)
