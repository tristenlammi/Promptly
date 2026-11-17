import XCTest
@testable import PromptlyCore

final class ServerAddressTests: XCTestCase {
    private func ok(_ typed: String) -> String? {
        if case .success(let address) = ServerAddress.parse(typed) { return address.origin }
        return nil
    }

    private func problem(_ typed: String) -> ServerAddress.Problem? {
        if case .failure(let problem) = ServerAddress.parse(typed) { return problem }
        return nil
    }

    func testABareNameBecomesHttps() {
        XCTAssertEqual(ok("promptly.example.org"), "https://promptly.example.org")
        XCTAssertEqual(ok("  Promptly.Example.org/ "), "https://promptly.example.org")
        XCTAssertEqual(ok("https://promptly.example.org:443"), "https://promptly.example.org")
        XCTAssertEqual(ok("https://promptly.example.org:8443/"), "https://promptly.example.org:8443")
    }

    func testPlainHttpOnlyAtHome() {
        XCTAssertEqual(ok("http://192.168.1.20:8091"), "http://192.168.1.20:8091")
        XCTAssertEqual(ok("192.168.1.20:8091"), "http://192.168.1.20:8091")
        XCTAssertEqual(ok("192.168.1.20"), "https://192.168.1.20")
        XCTAssertEqual(ok("http://nas.local"), "http://nas.local")
        XCTAssertEqual(ok("http://localhost:8091"), "http://localhost:8091")
        XCTAssertEqual(ok("http://100.101.102.103:8091"), "http://100.101.102.103:8091")
        XCTAssertEqual(problem("http://promptly.example.org"), .needsHttps)
        XCTAssertEqual(problem("http://8.8.8.8"), .needsHttps)
        XCTAssertEqual(problem("http://172.32.0.1"), .needsHttps)
    }

    func testWhatIsRefused() {
        XCTAssertEqual(problem(""), .empty)
        XCTAssertEqual(problem("   "), .empty)
        XCTAssertEqual(problem("my server"), .notAnAddress)
        XCTAssertEqual(problem("ftp://example.org"), .notAnAddress)
        XCTAssertEqual(problem("https://user:pw@example.org"), .notAnAddress)
        XCTAssertEqual(problem("https://exa_mple.org"), .notAnAddress)
        XCTAssertEqual(problem("https://-bad.example.org"), .notAnAddress)
        XCTAssertEqual(problem("https://example.org/files"), .hasPath)
        XCTAssertEqual(problem("https://example.org/?a=1"), .hasPath)
        XCTAssertEqual(problem("example.org#x"), .hasPath)
    }

    func testEveryProblemHasWords() {
        for p in [ServerAddress.Problem.empty, .notAnAddress, .hasPath, .needsHttps] {
            XCTAssertFalse(p.message.isEmpty)
        }
    }

    func testOwnsComparesSchemeHostAndPort() throws {
        let server = try ServerAddress.parse("promptly.example.org").get()
        XCTAssertTrue(server.owns(URL(string: "https://promptly.example.org/rooms/1")!))
        XCTAssertTrue(server.owns(URL(string: "https://PROMPTLY.example.org:443/")!))
        XCTAssertFalse(server.owns(URL(string: "http://promptly.example.org/")!))
        XCTAssertFalse(server.owns(URL(string: "https://promptly.example.org:8443/")!))
        XCTAssertFalse(server.owns(URL(string: "https://promptly.example.org.evil.test/")!))
        XCTAssertFalse(server.owns(URL(string: "https://evil.test/promptly.example.org")!))
        XCTAssertFalse(server.owns(URL(string: "mailto:someone@promptly.example.org")!))
    }

    func testPagesOnTheServer() throws {
        let server = try ServerAddress.parse("http://192.168.1.20:8091").get()
        XCTAssertEqual(server.url(path: "/rooms?x=1")?.absoluteString, "http://192.168.1.20:8091/rooms?x=1")
        XCTAssertNil(server.url(path: "rooms"))
        XCTAssertNil(server.url(path: "//evil.test"))
        XCTAssertEqual(server.url.absoluteString, "http://192.168.1.20:8091/")
    }

    func testItSavesAndLoads() throws {
        let server = try ServerAddress.parse("https://promptly.example.org:8443").get()
        let again = try JSONDecoder().decode(ServerAddress.self, from: JSONEncoder().encode(server))
        XCTAssertEqual(server, again)
    }
}

final class PairingTests: XCTestCase {
    func testTheQrLink() {
        let link = PairingLink.parse("https://promptly.example.org/sync?code=AbC-123_xyzAbC-123_xyz00")
        XCTAssertEqual(link?.server.origin, "https://promptly.example.org")
        XCTAssertEqual(link?.code, "AbC-123_xyzAbC-123_xyz00")
        XCTAssertEqual(PairingLink.parse(" http://192.168.1.20:8091/sync/?code=abcdefgh12 ")?.server.origin, "http://192.168.1.20:8091")
    }

    func testTheAppLink() {
        let link = PairingLink.parse("promptlysync://pair?server=https%3A%2F%2Fpromptly.example.org&code=abcdefgh12")
        XCTAssertEqual(link?.server.origin, "https://promptly.example.org")
        XCTAssertEqual(link?.code, "abcdefgh12")
    }

    func testWhatIsNotAPairingLink() {
        XCTAssertNil(PairingLink.parse("https://promptly.example.org/sync"))
        XCTAssertNil(PairingLink.parse("https://promptly.example.org/files?code=abcdefgh12"))
        XCTAssertNil(PairingLink.parse("https://promptly.example.org/sync?code=short"))
        XCTAssertNil(PairingLink.parse("https://promptly.example.org/sync?code=has%20space%20in%20it"))
        XCTAssertNil(PairingLink.parse("http://promptly.example.org/sync?code=abcdefgh12"), "plain http on the internet")
        XCTAssertNil(PairingLink.parse("promptlysync://pair?server=javascript:alert(1)&code=abcdefgh12"))
        XCTAssertNil(PairingLink.parse("just some words"))
        XCTAssertNil(PairingLink.parse(""))
    }

    func testTheClaimIsShapedAsTheServerExpects() throws {
        let body = try JSONEncoder().encode(PairClaimRequest(code: "abcdefgh12", deviceName: "  Sam's\n iPhone  "))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json, ["code": "abcdefgh12", "device_name": "Sam's iPhone"])
    }

    func testTheAnswerIsRead() throws {
        let body = Data(#"{"username":"sam","password":"not-a-real-one","device_id":"7f0a","device_name":"iPhone"}"#.utf8)
        let answer = try JSONDecoder().decode(PairClaimResponse.self, from: body)
        XCTAssertEqual(answer.username, "sam")
        XCTAssertEqual(answer.deviceId, "7f0a")
        XCTAssertEqual(ServerProblem.message(from: Data(#"{"detail":"That code has expired."}"#.utf8)), "That code has expired.")
        XCTAssertNil(ServerProblem.message(from: Data("<html>".utf8)))
    }

    func testDeviceNames() {
        XCTAssertEqual(DeviceName.clean(""), "iPhone")
        XCTAssertEqual(DeviceName.clean(" \n "), "iPhone")
        XCTAssertEqual(DeviceName.clean(String(repeating: "a", count: 200)).count, 80)
    }

    func testUserAgent() {
        XCTAssertEqual(UserAgent.suffix(version: "1.2.3"), "PromptlyiOS/1.2.3")
        XCTAssertEqual(UserAgent.suffix(version: "1.0 (beta)"), "PromptlyiOS/1.0beta")
        XCTAssertEqual(UserAgent.suffix(version: ""), "PromptlyiOS/0")
    }
}

final class LinkTests: XCTestCase {
    private let server = try! ServerAddress.parse("promptly.example.org").get()

    func testALinkToTheServerOpensThatPage() {
        XCTAssertEqual(DeepLink.resolve(URL(string: "https://promptly.example.org/rooms/abc?m=1#x")!, server: server), .page("/rooms/abc?m=1#x"))
        XCTAssertEqual(DeepLink.resolve(URL(string: "https://promptly.example.org")!, server: server), .page("/"))
        XCTAssertEqual(DeepLink.resolve(URL(string: "promptly://open?path=/mail")!, server: server), .page("/mail"))
    }

    func testLinksElsewhereAreRefused() {
        XCTAssertNil(DeepLink.resolve(URL(string: "https://evil.test/rooms")!, server: server))
        XCTAssertNil(DeepLink.resolve(URL(string: "https://promptly.example.org/rooms")!, server: nil))
        XCTAssertNil(DeepLink.resolve(URL(string: "promptly://open?path=//evil.test")!, server: server))
        XCTAssertNil(DeepLink.resolve(URL(string: "promptly://open?path=https://evil.test")!, server: server))
        XCTAssertNil(DeepLink.resolve(URL(string: "promptly://other?path=/mail")!, server: server))
        XCTAssertNil(DeepLink.resolve(URL(string: "tel:000")!, server: server))
    }

    func testAPairingLinkPairs() {
        let url = URL(string: "https://promptly.example.org/sync?code=abcdefgh12")!
        guard case .pair(let link)? = DeepLink.resolve(url, server: nil) else { return XCTFail("not a pairing link") }
        XCTAssertEqual(link.code, "abcdefgh12")
        XCTAssertNotNil(DeepLink.resolve(url, server: server))
        // A web link that would quietly move the app to a different server is refused…
        XCTAssertNil(DeepLink.resolve(URL(string: "https://other.example.org/sync?code=abcdefgh12")!, server: server))
    }

    func testQuickActions() {
        XCTAssertEqual(DeepLink.QuickAction(shortcutType: "org.promptly.rooms")?.path, "/rooms")
        XCTAssertEqual(DeepLink.QuickAction(shortcutType: "photos")?.path, "/photos")
        XCTAssertNil(DeepLink.QuickAction(shortcutType: "org.promptly.unknown"))
        XCTAssertEqual(DeepLink.QuickAction.allCases.count, 4)
    }

    func testWhereATappedLinkGoes() {
        func decide(_ s: String, main: Bool = true) -> LinkPolicy.Decision {
            LinkPolicy.decide(URL(string: s)!, server: server, mainFrame: main)
        }
        XCTAssertEqual(decide("https://promptly.example.org/files"), .inApp)
        XCTAssertEqual(decide("blob:https://promptly.example.org/1234"), .inApp)
        XCTAssertEqual(decide("about:blank"), .inApp)
        XCTAssertEqual(decide("https://example.com/"), .browser)
        XCTAssertEqual(decide("http://promptly.example.org/"), .browser, "not the same server over plain http")
        XCTAssertEqual(decide("https://www.youtube.com/embed/x", main: false), .inApp)
        XCTAssertEqual(decide("mailto:sam@example.org"), .system)
        XCTAssertEqual(decide("tel:+61000000"), .system)
        XCTAssertEqual(decide("tel:+61000000", main: false), .block)
        XCTAssertEqual(decide("javascript:alert(1)"), .block)
        XCTAssertEqual(decide("file:///etc/passwd"), .block)
        XCTAssertEqual(decide("someapp://do"), .block)
    }

    func testOnlyTheServerMayUseTheCameraAndMicrophone() {
        XCTAssertTrue(LinkPolicy.mayCapture(host: "promptly.example.org", scheme: "https", port: 0, server: server))
        XCTAssertTrue(LinkPolicy.mayCapture(host: "promptly.example.org", scheme: "https", port: 443, server: server))
        XCTAssertFalse(LinkPolicy.mayCapture(host: "evil.test", scheme: "https", port: 0, server: server))
        XCTAssertFalse(LinkPolicy.mayCapture(host: "promptly.example.org", scheme: "http", port: 0, server: server))
        XCTAssertFalse(LinkPolicy.mayCapture(host: "promptly.example.org", scheme: "https", port: 8443, server: server))
    }

    func testDownloads() {
        XCTAssertTrue(LinkPolicy.isDownload(contentDisposition: "attachment; filename=\"a.pdf\"", canShow: true))
        XCTAssertTrue(LinkPolicy.isDownload(contentDisposition: nil, canShow: false))
        XCTAssertFalse(LinkPolicy.isDownload(contentDisposition: "inline", canShow: true))
        XCTAssertFalse(LinkPolicy.isDownload(contentDisposition: nil, canShow: true))
        XCTAssertEqual(LinkPolicy.fileName(suggested: "../../etc/passwd"), "passwd")
        XCTAssertEqual(LinkPolicy.fileName(suggested: "C:\\Users\\x\\report.pdf"), "report.pdf")
        XCTAssertEqual(LinkPolicy.fileName(suggested: ".hidden"), "hidden")
        XCTAssertEqual(LinkPolicy.fileName(suggested: nil), "download")
        XCTAssertEqual(LinkPolicy.fileName(suggested: "  "), "download")
        XCTAssertEqual(LinkPolicy.fileName(suggested: "holiday photo.jpg"), "holiday photo.jpg")
    }
}
