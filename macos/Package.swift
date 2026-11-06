// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "UTermNative",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "UTermNativeQA", targets: ["UTermNativeQA"])],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.20.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.1")
    ],
    targets: [
        .systemLibrary(name: "UTermFFI", path: "Interop"),
        .target(name: "UTermBridge", dependencies: ["UTermFFI"]),
        .target(name: "UTermTestSupport", path: "Tests/UTermTestSupport", publicHeadersPath: "include"),
        .executableTarget(name: "UTermNativeQA", dependencies: ["UTermBridge", .product(name: "SwiftTerm", package: "SwiftTerm"), .product(name: "Sparkle", package: "Sparkle")]),
        .testTarget(name: "UTermBridgeTests", dependencies: ["UTermBridge", "UTermTestSupport", .product(name: "SwiftTerm", package: "SwiftTerm")])
    ]
)
