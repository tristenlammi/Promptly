import Foundation
import SwiftUI
import WebKit
import PromptlyCore

/// This phone's own sign-in to the server (an app password made by pairing).
/// Kept in the Keychain. Photo backup and notifications will use it later.
struct DeviceAccount: Codable, Equatable {
    let username: String
    let password: String
    let deviceId: String
    let deviceName: String
}

/// What the whole app knows: which server, whether this phone is paired, and
/// anything waiting to be opened.
@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    @Published private(set) var server: ServerAddress?
    @Published private(set) var account: DeviceAccount?
    /// A page to open as soon as the web view can.
    @Published var pendingPath: String?
    /// A pairing code that arrived as a link, waiting for a yes.
    @Published var pendingPair: PairingLink?
    @Published var showingSettings = false

    private let defaults = UserDefaults.standard
    private static let serverKey = "server"

    private init() {
        if let data = defaults.data(forKey: Self.serverKey),
           let saved = try? JSONDecoder().decode(ServerAddress.self, from: data) {
            server = saved
            account = Self.loadAccount(for: saved)
        }
    }

    /// The server this build was made for, if any (shown ready-filled on first run).
    nonisolated static var builtInHost: String {
        (Bundle.main.object(forInfoDictionaryKey: "PromptlyServerHost") as? String ?? "")
            .trimmingCharacters(in: .whitespaces)
    }

    nonisolated static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    nonisolated static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
    }

    // MARK: Server

    func use(_ address: ServerAddress) {
        server = address
        if let data = try? JSONEncoder().encode(address) { defaults.set(data, forKey: Self.serverKey) }
        account = Self.loadAccount(for: address)
    }

    /// Forget the server: its saved sign-in in the web view and this phone's pairing.
    func forgetServer() async {
        if let server { Keychain.delete(account: server.origin) }
        account = nil
        server = nil
        pendingPath = nil
        defaults.removeObject(forKey: Self.serverKey)
        let store = WKWebsiteDataStore.default()
        let records = await store.dataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes())
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), for: records)
    }

    // MARK: Pairing

    /// Trades the one-time code for this phone's own sign-in and remembers it.
    func pair(with link: PairingLink) async throws {
        let answer = try await PairingClient.claim(link, deviceName: PairingClient.thisDeviceName)
        let account = DeviceAccount(
            username: answer.username, password: answer.password,
            deviceId: answer.deviceId, deviceName: answer.deviceName
        )
        let data = try JSONEncoder().encode(account)
        guard Keychain.save(data, account: link.server.origin) else { throw PairingClient.Failure.message("This iPhone couldn't keep its sign-in. Try again.") }
        if server != link.server { use(link.server) }
        self.account = account
    }

    /// Stops using this phone's sign-in here. (Revoke it on the server in Account → Devices.)
    func unpair() {
        guard let server else { return }
        Keychain.delete(account: server.origin)
        account = nil
    }

    private static func loadAccount(for server: ServerAddress) -> DeviceAccount? {
        guard let data = Keychain.load(account: server.origin) else { return nil }
        return try? JSONDecoder().decode(DeviceAccount.self, from: data)
    }

    // MARK: Things to open

    func open(_ url: URL) {
        if url.scheme?.lowercased() == "promptly", url.host == "settings" {
            showingSettings = true
            return
        }
        switch DeepLink.resolve(url, server: server) {
        case .page(let path)?:
            pendingPath = path
        case .pair(let link)?:
            pendingPair = link
        case nil:
            break
        }
    }

    func open(shortcutType: String) {
        if shortcutType.hasSuffix(".settings") {
            showingSettings = true
        } else if let action = DeepLink.QuickAction(shortcutType: shortcutType) {
            pendingPath = action.path
        }
    }
}
