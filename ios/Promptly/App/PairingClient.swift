import Foundation
import UIKit
import PromptlyCore

/// The two things the app itself asks the server (everything else is the web app).
enum PairingClient {
    enum Failure: LocalizedError {
        case message(String)

        var errorDescription: String? {
            switch self {
            case .message(let text): return text
            }
        }
    }

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration)
    }()

    @MainActor
    static var thisDeviceName: String {
        // Since iOS 16 this is just "iPhone" unless Apple grants a special
        // permission; the model is added so two phones can be told apart.
        let name = UIDevice.current.name
        let model = UIDevice.current.model
        return name == model ? "\(model) · Promptly app" : "\(name) · Promptly app"
    }

    /// Is there a Promptly server at this address?
    static func check(_ server: ServerAddress) async throws {
        guard let url = server.url(path: "/api/health/live") else { throw Failure.message("That doesn't look like a server address.") }
        do {
            let (_, response) = try await session.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                throw Failure.message("Something answered at that address, but it isn't Promptly.")
            }
        } catch let failure as Failure {
            throw failure
        } catch {
            throw Failure.message("Couldn't reach that server. Check the address and that this iPhone is online.")
        }
    }

    /// `POST /api/devices/pair/claim`: the code from the QR for this phone's own sign-in.
    static func claim(_ link: PairingLink, deviceName: String) async throws -> PairClaimResponse {
        guard let url = link.server.url(path: "/api/devices/pair/claim") else { throw Failure.message("That code isn't for a Promptly server.") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(PairClaimRequest(code: link.code, deviceName: deviceName))
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Failure.message("Couldn't reach the server. Check this iPhone is online and try again.")
        }
        guard let http = response as? HTTPURLResponse else { throw Failure.message("The server gave an answer this app didn't understand.") }
        guard http.statusCode == 200 else {
            throw Failure.message(ServerProblem.message(from: data) ?? "The server said no (\(http.statusCode)). Make a new code and try again.")
        }
        guard let answer = try? JSONDecoder().decode(PairClaimResponse.self, from: data) else {
            throw Failure.message("The server gave an answer this app didn't understand.")
        }
        return answer
    }
}
