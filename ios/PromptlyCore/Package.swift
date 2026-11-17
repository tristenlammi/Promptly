// swift-tools-version:5.9
import PackageDescription

// The parts of the iPhone app that are plain logic: no screens, no Apple-only
// frameworks. That lets its tests run on Linux (and in CI without a simulator).
let package = Package(
    name: "PromptlyCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "PromptlyCore", targets: ["PromptlyCore"]),
    ],
    targets: [
        .target(name: "PromptlyCore"),
        .testTarget(name: "PromptlyCoreTests", dependencies: ["PromptlyCore"]),
    ]
)
