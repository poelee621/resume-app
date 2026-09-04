// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0"),
        .package(name: "CapacitorCommunityMedia", path: "../../../node_modules/@capacitor-community/media"),
        .package(name: "CapacitorBrowser", path: "../../../node_modules/@capacitor/browser"),
        .package(name: "CapgoCapacitorWechat", path: "../../../node_modules/@capgo/capacitor-wechat")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorCommunityMedia", package: "CapacitorCommunityMedia"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapgoCapacitorWechat", package: "CapgoCapacitorWechat")
            ]
        )
    ]
)
