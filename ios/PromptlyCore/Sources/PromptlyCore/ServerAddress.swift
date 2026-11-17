import Foundation

/// Where a Promptly server lives: scheme, host and (if unusual) port. Nothing else.
public struct ServerAddress: Equatable, Hashable, Codable, Sendable {
    public let scheme: String
    public let host: String
    public let port: Int?

    /// `https://example.org` or `http://192.168.1.20:8091`, never with a trailing slash.
    public var origin: String {
        let h = host.contains(":") ? "[\(host)]" : host
        if let port { return "\(scheme)://\(h):\(port)" }
        return "\(scheme)://\(h)"
    }

    public var url: URL { URL(string: origin + "/")! }

    /// The address of a page on this server. `path` starts with `/` and may carry a query.
    public func url(path: String) -> URL? {
        guard path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
        return URL(string: origin + path)
    }

    public enum Problem: Error, Equatable, Sendable {
        case empty
        case notAnAddress
        case hasPath
        case needsHttps

        /// What to tell the person, in plain words.
        public var message: String {
            switch self {
            case .empty: return "Type your server's address, like promptly.example.org."
            case .notAnAddress: return "That doesn't look like a server address."
            case .hasPath: return "Leave off everything after the server's name."
            case .needsHttps: return "A server on the internet has to use https."
            }
        }
    }

    /// Reads what someone typed. `promptly.example.org` becomes `https://promptly.example.org`.
    /// Plain `http` is only accepted for a server on the home network.
    public static func parse(_ typed: String) -> Result<ServerAddress, Problem> {
        var text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .failure(.empty) }
        if text.contains(" ") { return .failure(.notAnAddress) }
        let lower = text.lowercased()
        let hadScheme = lower.hasPrefix("http://") || lower.hasPrefix("https://")
        if !hadScheme {
            if text.contains("://") { return .failure(.notAnAddress) }
            text = "https://" + text
        }
        guard let parts = URLComponents(string: text),
              let scheme = parts.scheme?.lowercased(),
              let rawHost = parts.host, !rawHost.isEmpty
        else { return .failure(.notAnAddress) }
        if parts.user != nil || parts.password != nil { return .failure(.notAnAddress) }
        if !(parts.path.isEmpty || parts.path == "/") || parts.query != nil || parts.fragment != nil {
            return .failure(.hasPath)
        }
        var host = rawHost.lowercased()
        if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        guard validHost(host) else { return .failure(.notAnAddress) }
        var port = parts.port
        if let p = port, !(1...65535).contains(p) { return .failure(.notAnAddress) }
        if (scheme == "https" && port == 443) || (scheme == "http" && port == 80) { port = nil }
        var finalScheme = scheme
        if !hadScheme && isLocal(host) && port != nil && port != 443 {
            // "192.168.1.20:8091" typed with no scheme is almost always a plain home server.
            finalScheme = "http"
        }
        if finalScheme == "http" && !isLocal(host) { return .failure(.needsHttps) }
        return .success(ServerAddress(scheme: finalScheme, host: host, port: port))
    }

    /// The same server? Compares scheme, host and port.
    public func owns(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), var host = url.host?.lowercased() else { return false }
        if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        let theirs = url.port ?? ServerAddress.usualPort(scheme)
        let mine = port ?? ServerAddress.usualPort(self.scheme)
        return scheme == self.scheme && host == self.host && theirs == mine
    }

    static func usualPort(_ scheme: String) -> Int? {
        switch scheme {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }

    static func validHost(_ host: String) -> Bool {
        if host.isEmpty || host.count > 253 { return false }
        if host.contains(":") {
            // An IPv6 address: hex digits, colons, and at most one dotted tail.
            return host.allSatisfy { $0.isHexDigit || $0 == ":" || $0 == "." }
        }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        for label in labels {
            if label.isEmpty || label.count > 63 { return false }
            if label.hasPrefix("-") || label.hasSuffix("-") { return false }
            if !label.allSatisfy({ ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "-" }) { return false }
        }
        return true
    }

    /// On the home network (or this device): the only place plain http is allowed.
    public static func isLocal(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local")
            || host.hasSuffix(".lan") || host.hasSuffix(".home.arpa") { return true }
        if host == "::1" || host.hasPrefix("fe80:") || host.hasPrefix("fc") && host.contains(":")
            || host.hasPrefix("fd") && host.contains(":") { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, host.split(separator: ".").count == 4,
              parts.allSatisfy({ (0...255).contains($0) }) else {
            // A single word with no dots ("nas") can only be a local name.
            return !host.contains(".") && !host.contains(":")
        }
        if parts[0] == 10 || parts[0] == 127 { return true }
        if parts[0] == 192 && parts[1] == 168 { return true }
        if parts[0] == 172 && (16...31).contains(parts[1]) { return true }
        if parts[0] == 169 && parts[1] == 254 { return true }
        if parts[0] == 100 && (64...127).contains(parts[1]) { return true }  // Tailscale and similar
        return false
    }
}
