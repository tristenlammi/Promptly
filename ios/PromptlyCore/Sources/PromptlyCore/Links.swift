import Foundation

/// Turning a link the phone was handed into a page inside the app.
public enum DeepLink {
    /// The long-press menu on the app's icon.
    public enum QuickAction: String, CaseIterable, Sendable {
        case rooms, mail, calendar, photos

        public var path: String { "/" + rawValue }

        /// The `type` of a Home-screen quick action, e.g. `org.promptly.rooms`.
        public init?(shortcutType: String) {
            guard let last = shortcutType.split(separator: ".").last, let action = QuickAction(rawValue: String(last)) else { return nil }
            self = action
        }
    }

    public enum Target: Equatable, Sendable {
        /// Open this page of the server (path, with any query and fragment).
        case page(String)
        /// A pairing QR opened as a link.
        case pair(PairingLink)
    }

    /// - `https://<the server>/rooms/abc` (a Universal Link) → that page.
    /// - `promptly://open?path=/rooms/abc` → that page.
    /// - A pairing link → pairing.
    /// Links to any other server are refused.
    public static func resolve(_ url: URL, server: ServerAddress?) -> Target? {
        guard let scheme = url.scheme?.lowercased() else { return nil }
        if let link = PairingLink.parse(url.absoluteString) {
            // A pairing link for the server we're already on, or for a first set-up.
            if server == nil || server == link.server || scheme != "https" && scheme != "http" { return .pair(link) }
            return nil
        }
        switch scheme {
        case "http", "https":
            guard let server, server.owns(url) else { return nil }
            return page(from: url).map(Target.page)
        case "promptly":
            guard url.host == "open",
                  let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let path = parts.queryItems?.first(where: { $0.name == "path" })?.value,
                  safePath(path) else { return nil }
            return .page(path)
        default:
            return nil
        }
    }

    static func page(from url: URL) -> String? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
        if let q = parts.percentEncodedQuery, !q.isEmpty { path += "?" + q }
        if let f = parts.percentEncodedFragment, !f.isEmpty { path += "#" + f }
        return safePath(path) ? path : nil
    }

    /// A path on this server only: starts with one `/`, no way to jump to another host.
    public static func safePath(_ path: String) -> Bool {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.hasPrefix("/\\"), path.count <= 2000 else { return false }
        return !path.contains(where: { $0.isNewline || $0 == "\\" })
    }
}

/// What the web view should do with a link someone tapped.
public enum LinkPolicy {
    public enum Decision: Equatable, Sendable {
        /// Load it in the app.
        case inApp
        /// Another website: show it in the in-app Safari sheet.
        case browser
        /// `mailto:`, `tel:`, `sms:`, a maps link…: hand it to the phone.
        case system
        /// Don't follow it.
        case block
    }

    static let internalSchemes: Set<String> = ["about", "blob", "data"]
    static let systemSchemes: Set<String> = ["mailto", "tel", "sms", "facetime", "facetime-audio", "maps", "itms-apps", "itms-beta"]

    /// - Parameter mainFrame: false for something loading inside a frame on the page.
    public static func decide(_ url: URL, server: ServerAddress, mainFrame: Bool) -> Decision {
        guard let scheme = url.scheme?.lowercased() else { return .block }
        if internalSchemes.contains(scheme) { return .inApp }
        if systemSchemes.contains(scheme) { return mainFrame ? .system : .block }
        guard scheme == "http" || scheme == "https" else { return .block }
        if server.owns(url) { return .inApp }
        // Frames from other sites (a video embed, a map) load where they are.
        return mainFrame ? .browser : .inApp
    }

    /// May a page ask for the camera or microphone? Only the server's own pages.
    public static func mayCapture(host: String, scheme: String, port: Int, server: ServerAddress) -> Bool {
        let usual = ServerAddress.usualPort(scheme.lowercased())
        var parts = URLComponents()
        parts.scheme = scheme.lowercased()
        parts.host = host
        if port != 0, port != usual { parts.port = port }
        guard let url = parts.url else { return false }
        return server.owns(url)
    }

    /// Show the response in the page, or save it as a file?
    public static func isDownload(contentDisposition: String?, canShow: Bool) -> Bool {
        if let d = contentDisposition?.trimmingCharacters(in: .whitespaces).lowercased(), d.hasPrefix("attachment") { return true }
        return !canShow
    }

    /// A safe file name for a download: no folders, no hidden files, not empty.
    public static func fileName(suggested: String?) -> String {
        var name = (suggested ?? "").replacingOccurrences(of: "\\", with: "/")
        name = name.split(separator: "/").last.map(String.init) ?? ""
        name = String(name.filter { !$0.isNewline && $0 != "\0" && $0 != ":" })
        while name.hasPrefix(".") { name.removeFirst() }
        name = name.trimmingCharacters(in: .whitespaces)
        if name.isEmpty { return "download" }
        return String(name.prefix(200))
    }
}
