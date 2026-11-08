/**
 * Your speaking edges for everyone looking at the space (the rings in the
 * channel list): debounced (on after 150 ms of talking, off after 400 ms
 * of quiet), one request at a time, and polite when the server says 429
 * (it allows 40 updates per 10 s): wait out the window, then send the
 * latest state once. Connected people see rings from LiveKit directly;
 * this is for the others.
 */

export const SPEAKING_ON_MS = 150;
export const SPEAKING_OFF_MS = 400;
export const RATE_LIMIT_BACKOFF_MS = 10_000;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Error shapes the sender may throw (axios-like). */
function statusOf(err: unknown): number | null {
  const e = err as { response?: { status?: number }; status?: number };
  return e?.response?.status ?? e?.status ?? null;
}

export class SpeakingReporter {
  /** The debounced state (what the rings should show). */
  private stable = false;
  /** What the server last accepted. */
  private sent = false;
  private raw = false;
  private edgeTimer: unknown = null;
  private retryTimer: unknown = null;
  private inFlight = false;
  private blockedUntil = 0;
  private stopped = false;

  constructor(
    private readonly send: (on: boolean) => Promise<void>,
    private readonly clock: Clock = realClock,
    private readonly onStable?: (on: boolean) => void,
  ) {}

  /** The raw talking signal (the gate, or LiveKit's speaking flag). */
  input(on: boolean): void {
    if (this.stopped || on === this.raw) return;
    this.raw = on;
    if (this.edgeTimer !== null) {
      this.clock.clearTimeout(this.edgeTimer);
      this.edgeTimer = null;
    }
    if (on === this.stable) return;
    this.edgeTimer = this.clock.setTimeout(
      () => {
        this.edgeTimer = null;
        this.stable = on;
        this.onStable?.(on);
        this.flush();
      },
      on ? SPEAKING_ON_MS : SPEAKING_OFF_MS,
    );
  }

  /** Muted, deafened or leaving: off at once. */
  forceOff(): void {
    if (this.edgeTimer !== null) {
      this.clock.clearTimeout(this.edgeTimer);
      this.edgeTimer = null;
    }
    this.raw = false;
    if (this.stable) {
      this.stable = false;
      this.onStable?.(false);
    }
    this.flush();
  }

  get speaking(): boolean {
    return this.stable;
  }

  stop(): void {
    this.stopped = true;
    if (this.edgeTimer !== null) this.clock.clearTimeout(this.edgeTimer);
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.edgeTimer = this.retryTimer = null;
  }

  private flush(): void {
    if (this.stopped || this.inFlight || this.stable === this.sent) return;
    const wait = this.blockedUntil - this.clock.now();
    if (wait > 0) {
      if (this.retryTimer === null) {
        this.retryTimer = this.clock.setTimeout(() => {
          this.retryTimer = null;
          this.flush();
        }, wait);
      }
      return;
    }
    const want = this.stable;
    this.inFlight = true;
    this.send(want).then(
      () => {
        this.inFlight = false;
        this.sent = want;
        this.flush();
      },
      (err) => {
        this.inFlight = false;
        const status = statusOf(err);
        if (status === 429) {
          this.blockedUntil = this.clock.now() + RATE_LIMIT_BACKOFF_MS;
        } else if (status === 404) {
          // Not in voice any more: nothing to report.
          this.stop();
          return;
        } else {
          // A network blip: count it as done rather than retrying in a loop;
          // the next edge sends again.
          this.sent = want;
        }
        this.flush();
      },
    );
  }
}
