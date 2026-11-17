import Foundation

/// What the pairing QR code carries: which server, and a one-time code.
///
/// The server makes the QR in Files → Devices. It is a link,
/// `https://server/sync?code=…`, the same one the Android app scans.
public struct PairingLink: Equatable, Sendable {
    public let server: ServerAddress
    public let code: String

    public static func parse(_ scanned: String) -> PairingLink? {
        let text = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: text), let scheme = parts.scheme?.lowercased() else { return nil }
        let items = parts.queryItems ?? []
        func value(_ name: String) -> String? { items.first(where: { $0.name == name })?.value }

        switch scheme {
        case "http", "https":
            var path = parts.path
            while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
            guard path == "/sync", let code = value("code"), validCode(code) else { return nil }
            var origin = URLComponents()
            origin.scheme = scheme
            origin.host = parts.host
            origin.port = parts.port
            guard let text = origin.string, case .success(let server) = ServerAddress.parse(text) else { return nil }
            return PairingLink(server: server, code: code)
        case "promptlysync", "promptly":
            // promptlysync://pair?server=https://…&code=…  (kept the same as Android)
            guard parts.host == "pair", let raw = value("server"), let code = value("code"), validCode(code),
                  raw.lowercased().hasPrefix("http"),
                  case .success(let server) = ServerAddress.parse(raw) else { return nil }
            return PairingLink(server: server, code: code)
        default:
            return nil
        }
    }

    /// The server accepts 8 to 64 characters; its own codes are URL-safe base64.
    static func validCode(_ code: String) -> Bool {
        (8...64).contains(code.count) && code.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }
}

/// `POST /api/devices/pair/claim`: the phone's half of pairing.
public struct PairClaimRequest: Codable, Equatable, Sendable {
    public let code: String
    public let deviceName: String

    public init(code: String, deviceName: String) {
        self.code = code
        self.deviceName = DeviceName.clean(deviceName)
    }

    enum CodingKeys: String, CodingKey {
        case code
        case deviceName = "device_name"
    }
}

/// What the server answers: this phone's own sign-in (an app password), shown once.
public struct PairClaimResponse: Codable, Equatable, Sendable {
    public let username: String
    public let password: String
    public let deviceId: String
    public let deviceName: String

    enum CodingKeys: String, CodingKey {
        case username, password
        case deviceId = "device_id"
        case deviceName = "device_name"
    }
}

/// FastAPI's error shape, `{"detail": "…"}`. The detail is already written for people.
public struct ServerProblem: Decodable, Sendable {
    public let detail: String

    public static func message(from body: Data) -> String? {
        (try? JSONDecoder().decode(ServerProblem.self, from: body))?.detail
    }
}

public enum DeviceName {
    /// One line, 1 to 80 characters, as the server stores it.
    public static func clean(_ raw: String) -> String {
        let words = raw.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
        let joined = words.joined(separator: " ")
        let cut = String(joined.prefix(80))
        return cut.isEmpty ? "iPhone" : cut
    }
}

public enum UserAgent {
    /// Added to the web view's user agent, so the web app knows it's inside the iPhone app.
    public static func suffix(version: String) -> String {
        let safe = version.filter { $0.isASCII && ($0.isNumber || $0.isLetter || $0 == ".") }
        return "PromptlyiOS/" + (safe.isEmpty ? "0" : safe)
    }
}
