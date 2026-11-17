import XCTest
@testable import PromptlyCore

final class UploadQueueTests: XCTestCase {
    private func item(_ id: String, _ bytes: Int64 = 100, hash: String? = nil) -> UploadQueue.Item {
        UploadQueue.Item(id: id, bytes: bytes, sha256: hash)
    }

    func testAddingTwiceAddsOnce() {
        var q = UploadQueue()
        XCTAssertEqual(q.add([item("a"), item("b"), item("a")]), 2)
        XCTAssertEqual(q.add([item("b"), item("c")]), 1)
        XCTAssertEqual(q.items.map(\.id), ["a", "b", "c"])
    }

    func testOnlySoManyAtOnceOldestFirst() {
        var q = UploadQueue(atOnce: 2)
        q.add([item("a"), item("b"), item("c")])
        XCTAssertEqual(q.startNext(now: 0).map(\.id), ["a", "b"])
        XCTAssertEqual(q.startNext(now: 0).map(\.id), [])
        q.succeeded("a")
        XCTAssertEqual(q.startNext(now: 0).map(\.id), ["c"])
        XCTAssertEqual(q.summary.done, 1)
        XCTAssertEqual(q.summary.sending, 2)
    }

    func testProgressNeverGoesBackOrPastTheEnd() {
        var q = UploadQueue()
        q.add([item("a", 100)])
        _ = q.startNext(now: 0)
        q.progress("a", sent: 60)
        q.progress("a", sent: 40)
        XCTAssertEqual(q.items[0].state, .sending(sent: 60))
        q.progress("a", sent: 500)
        XCTAssertEqual(q.items[0].state, .sending(sent: 100))
        XCTAssertEqual(q.summary.bytesLeft, 0)
    }

    func testAFailureWaitsLongerEachTime() {
        var q = UploadQueue(atOnce: 1, maxTries: 3)
        q.add([item("a")])
        _ = q.startNext(now: 0)
        q.failed("a", reason: "no signal", canRetry: true, now: 0)
        XCTAssertEqual(q.items[0].state, .retry(at: 30, tries: 1))
        XCTAssertEqual(q.startNext(now: 29).count, 0, "not yet")
        XCTAssertEqual(q.nextRetry(), 30)
        XCTAssertEqual(q.startNext(now: 30).count, 1)
        q.failed("a", reason: "no signal", canRetry: true, now: 30)
        XCTAssertEqual(q.items[0].state, .retry(at: 90, tries: 2))
        _ = q.startNext(now: 90)
        q.failed("a", reason: "no signal", canRetry: true, now: 90)
        XCTAssertEqual(q.items[0].state, .failed("no signal"), "given up after three tries")
        XCTAssertEqual(q.summary.failed, 1)
        XCTAssertNil(q.nextRetry())
    }

    func testARefusalIsNotRetried() {
        var q = UploadQueue()
        q.add([item("a")])
        _ = q.startNext(now: 0)
        q.failed("a", reason: "too big", canRetry: false, now: 0)
        XCTAssertEqual(q.items[0].state, .failed("too big"))
        q.retryFailed()
        XCTAssertEqual(q.items[0].state, .waiting)
    }

    func testTheWaitIsCappedAtAnHour() {
        XCTAssertEqual(UploadQueue.wait(afterTries: 1), 30)
        XCTAssertEqual(UploadQueue.wait(afterTries: 2), 60)
        XCTAssertEqual(UploadQueue.wait(afterTries: 5), 480)
        XCTAssertEqual(UploadQueue.wait(afterTries: 50), 3600)
        XCTAssertEqual(UploadQueue.wait(afterTries: 0), 30)
    }

    func testWhatTheServerAlreadyHasIsNotSent() {
        var q = UploadQueue(atOnce: 1)
        q.add([item("a", hash: "AA"), item("b", hash: "bb"), item("c", hash: "cc"), item("d")])
        _ = q.startNext(now: 0)  // a is on its way already
        q.serverAnswered(have: ["aa", "bb"], skip: ["cc"])
        XCTAssertEqual(q.items[0].state, .sending(sent: 0), "one already sending is left alone")
        XCTAssertEqual(q.items[1].state, .done)
        XCTAssertEqual(q.items[2].state, .skipped)
        XCTAssertEqual(q.items[3].state, .waiting)
    }

    func testEventsForTheWrongStateDoNothing() {
        var q = UploadQueue()
        q.add([item("a")])
        q.succeeded("a")
        q.failed("a", reason: "x", canRetry: true, now: 0)
        q.progress("a", sent: 10)
        q.succeeded("nope")
        XCTAssertEqual(q.items[0].state, .waiting)
    }

    func testItSurvivesTheAppClosingMidSend() throws {
        var q = UploadQueue(atOnce: 2)
        q.add([item("a"), item("b"), item("c")])
        _ = q.startNext(now: 0)
        q.failed("a", reason: "no signal", canRetry: true, now: 0)
        _ = q.startNext(now: 100)  // a again (second try), b still sending
        var loaded = try JSONDecoder().decode(UploadQueue.self, from: JSONEncoder().encode(q))
        XCTAssertEqual(loaded, q)
        loaded.resumeAfterRestart()
        XCTAssertEqual(loaded.items[0].state, .retry(at: 0, tries: 1), "keeps its count of tries")
        XCTAssertEqual(loaded.items[1].state, .waiting)
        XCTAssertEqual(loaded.startNext(now: 1).map(\.id), ["a", "b"])
    }

    func testForgettingWhatIsFinished() {
        var q = UploadQueue(atOnce: 3)
        q.add([item("a"), item("b", hash: "bb"), item("c")])
        q.serverAnswered(have: [], skip: ["bb"])
        _ = q.startNext(now: 0)
        q.succeeded("a")
        q.forgetFinished()
        XCTAssertEqual(q.items.map(\.id), ["c"])
    }
}
