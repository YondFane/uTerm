// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "UTermNative",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "UTermNativeQA", targets: ["UTermNativeQA"])],
    dependencies: [.package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.20.0")],
    targets: [
        .systemLibrary(name: "UTermFFI", path: "Interop"),
        .target(name: "UTermBridge", dependencies: ["UTermFFI"]),
        .target(name: "UTermTestSupport", path: "Tests/UTermTestSupport", publicHeadersPath: "include"),
        .executableTarget(name: "UTermNativeQA", dependencies: ["UTermBridge", .product(name: "SwiftTerm", package: "SwiftTerm")]),
        .testTarget(name: "UTermBridgeTests", dependencies: ["UTermBridge", "UTermTestSupport", .product(name: "SwiftTerm", package: "SwiftTerm")])
    ]
)
