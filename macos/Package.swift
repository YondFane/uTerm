// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "UTermNative",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "UTermNativeQA", targets: ["UTermNativeQA"])],
    targets: [
        .systemLibrary(name: "UTermFFI", path: "Interop"),
        .target(name: "UTermBridge", dependencies: ["UTermFFI"]),
        .executableTarget(name: "UTermNativeQA", dependencies: ["UTermBridge"]),
        .testTarget(name: "UTermBridgeTests", dependencies: ["UTermBridge"])
    ]
)
