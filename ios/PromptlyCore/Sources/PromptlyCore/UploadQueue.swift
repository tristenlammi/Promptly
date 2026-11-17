import Foundation

/// The list of things waiting to be sent to the server (photo backup and
/// "Save to Promptly" will both use it). This is only the bookkeeping: what
/// may start, what to retry and when. Something else does the sending.
///
/// It is a value that can be saved and loaded, so the list survives the app
/// being closed. Every change goes through a method here; nothing else edits it.
public struct UploadQueue: Codable, Equatable, Sendable {
    public enum State: Codable, Equatable, Sendable {
        case waiting
        case sending(sent: Int64)
        /// Failed, and may be tried again at this time (seconds since 1970).
        case retry(at: Double, tries: Int)
        case done
        /// The server already had it, or the person deleted it there: never send.
        case skipped
        /// Given up on, with why.
        case failed(String)
    }

    public struct Item: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let bytes: Int64
        public var sha256: String?
        public var state: State

        public init(id: String, bytes: Int64, sha256: String? = nil, state: State = .waiting) {
            self.id = id
            self.bytes = bytes
            self.sha256 = sha256
            self.state = state
        }
    }

    public private(set) var items: [Item] = []
    /// How many may be sending at once.
    public var atOnce: Int
    /// Give up after this many failed tries.
    public var maxTries: Int

    public init(atOnce: Int = 2, maxTries: Int = 6) {
        self.atOnce = max(1, atOnce)
        self.maxTries = max(1, maxTries)
    }

    // MARK: Adding

    /// Adds what isn't already known. Returns how many were new.
    @discardableResult
    public mutating func add(_ new: [Item]) -> Int {
        var known = Set(items.map(\.id))
        var added = 0
        for item in new where !known.contains(item.id) {
            known.insert(item.id)
            items.append(Item(id: item.id, bytes: max(0, item.bytes), sha256: item.sha256, state: .waiting))
            added += 1
        }
        return added
    }

    // MARK: Choosing what to send

    /// The next items that may start now, oldest first. Marks them as sending.
    public mutating func startNext(now: Double) -> [Item] {
        var room = atOnce - sendingCount
        var started: [Item] = []
        guard room > 0 else { return [] }
        for index in items.indices where room > 0 {
            switch items[index].state {
            case .waiting:
                break
            case .retry(let at, _) where at <= now:
                break
            default:
                continue
            }
            let tries = triesSoFar(items[index].state)
            items[index].state = .sending(sent: 0)
            pendingTries[items[index].id] = tries
            started.append(items[index])
            room -= 1
        }
        return started
    }

    /// When the earliest retry is due, if anything is waiting on one.
    public func nextRetry() -> Double? {
        items.compactMap { item -> Double? in
            if case .retry(let at, _) = item.state { return at }
            return nil
        }.min()
    }

    // MARK: What happened

    public mutating func progress(_ id: String, sent: Int64) {
        guard let index = index(id), case .sending(let before) = items[index].state else { return }
        // Progress never goes backwards and never past the end.
        items[index].state = .sending(sent: min(max(before, sent), items[index].bytes))
    }

    public mutating func succeeded(_ id: String) {
        guard let index = index(id), case .sending = items[index].state else { return }
        items[index].state = .done
        pendingTries[id] = nil
    }

    /// The server said it has these already (`have`) or never wants them (`skip`).
    public mutating func serverAnswered(have: Set<String>, skip: Set<String>) {
        for index in items.indices {
            guard let hash = items[index].sha256?.lowercased() else { continue }
            switch items[index].state {
            case .waiting, .retry:
                if have.contains(hash) { items[index].state = .done }
                else if skip.contains(hash) { items[index].state = .skipped }
            default:
                continue
            }
        }
    }

    /// - Parameter canRetry: false for a refusal that won't change (too big, not allowed).
    public mutating func failed(_ id: String, reason: String, canRetry: Bool, now: Double) {
        guard let index = index(id), case .sending = items[index].state else { return }
        let tries = (pendingTries[id] ?? 0) + 1
        pendingTries[id] = nil
        if !canRetry || tries >= maxTries {
            items[index].state = .failed(reason)
        } else {
            items[index].state = .retry(at: now + UploadQueue.wait(afterTries: tries), tries: tries)
        }
    }

    /// The app was closed mid-send: everything "sending" goes back to waiting,
    /// keeping its count of tries. Call once after loading a saved queue.
    public mutating func resumeAfterRestart() {
        for index in items.indices {
            if case .sending = items[index].state {
                let tries = pendingTries[items[index].id] ?? 0
                items[index].state = tries > 0 ? .retry(at: 0, tries: tries) : .waiting
            }
        }
        pendingTries = [:]
    }

    /// Try the given-up ones again (the person tapped "Try again").
    public mutating func retryFailed() {
        for index in items.indices {
            if case .failed = items[index].state { items[index].state = .waiting }
        }
    }

    /// Forget what's finished, to keep the saved list small.
    public mutating func forgetFinished() {
        items.removeAll { item in
            switch item.state {
            case .done, .skipped: return true
            default: return false
            }
        }
    }

    // MARK: Counts for the status line

    public struct Summary: Equatable, Sendable {
        public var done = 0
        public var waiting = 0
        public var sending = 0
        public var failed = 0
        public var bytesLeft: Int64 = 0
    }

    public var summary: Summary {
        var s = Summary()
        for item in items {
            switch item.state {
            case .done, .skipped:
                s.done += 1
            case .waiting, .retry:
                s.waiting += 1
                s.bytesLeft += item.bytes
            case .sending(let sent):
                s.sending += 1
                s.bytesLeft += max(0, item.bytes - sent)
            case .failed:
                s.failed += 1
            }
        }
        return s
    }

    /// 30 s, 1 min, 2 min, 4 min… capped at an hour.
    public static func wait(afterTries tries: Int) -> Double {
        let steps = max(0, min(tries - 1, 10))
        return min(3600, 30 * pow(2, Double(steps)))
    }

    // MARK: Private

    /// Tries already used by items that are sending right now.
    private var pendingTries: [String: Int] = [:]

    private var sendingCount: Int {
        items.reduce(0) { count, item in
            if case .sending = item.state { return count + 1 }
            return count
        }
    }

    private func index(_ id: String) -> Int? { items.firstIndex { $0.id == id } }

    private func triesSoFar(_ state: State) -> Int {
        if case .retry(_, let tries) = state { return tries }
        return 0
    }
}
