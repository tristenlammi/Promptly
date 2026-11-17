import SwiftUI
import UIKit
import PromptlyCore

@main
struct PromptlyApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var state = AppState.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .tint(Color("AccentColor"))
                // promptly://… and, in a signed build, https links to the server.
                .onOpenURL { state.open($0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { state.open(url) }
                }
        }
    }
}

/// Only here for the long-press menu on the app's icon, which SwiftUI has no hook for.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        if let item = options.shortcutItem {
            // The app was closed when the menu item was tapped.
            Task { @MainActor in AppState.shared.open(shortcutType: item.type) }
        }
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        Task { @MainActor in
            AppState.shared.open(shortcutType: shortcutItem.type)
            completionHandler(true)
        }
    }
}
