/**
 * Calls WP-D5: the rules for a call on a shaky connection, kept apart from
 * LiveKit so they're unit-tested (``link.test.ts``). The same rules as the
 * Android app's (``CallMedia.kt``: ``WeakLink``, ``VideoPlan``).
 *
 *  - ``WeakLink``: whether the connection counts as weak, without flapping:
 *    weak after 4 s of poor (at once when lost), strong again after 10 s of
 *    good;
 *  - ``videoPlan``: cameras come in at the lowest layer and yours goes out
 *    small when it's weak or Data saver is on (Voice & video settings);
 *  - ``reconnectWords``: what the call screen says while it gets back.
 */

export type LinkQuality = "excellent" | "good" | "poor" | "lost" | "unknown";

export class WeakLink {
  weak = false;
  private since = 0;
  private bad: boolean | null = null;

  constructor(
    private readonly weakAfterMs = 4000,
    private readonly strongAfterMs = 10000,
  ) {}

  /** The latest quality; returns whether it's weak now. */
  input(q: LinkQuality, now: number): boolean {
    if (q === "unknown") return this.weak;
    const isBad = q === "poor" || q === "lost";
    if (isBad !== this.bad) {
      this.bad = isBad;
      this.since = now;
    }
    if (q === "lost") this.weak = true;
    return this.tick(now);
  }

  /** Time passing (call every second or two). */
  tick(now: number): boolean {
    if (this.bad === null) return this.weak;
    if (this.bad && !this.weak && now - this.since >= this.weakAfterMs) this.weak = true;
    if (!this.bad && this.weak && now - this.since >= this.strongAfterMs) this.weak = false;
    return this.weak;
  }
}

export interface VideoPlan {
  /** Why video is lowered, or null. */
  lowered: "weak" | "saver" | null;
  /** The layer to take others' cameras at. */
  receive: "low" | "high";
  /** Your camera's capture height (720 normally, 360 lowered). */
  sendHeight: 360 | 720;
}

export function videoPlan(weak: boolean, dataSaver: boolean): VideoPlan {
  const lowered = weak ? "weak" : dataSaver ? "saver" : null;
  return { lowered, receive: lowered ? "low" : "high", sendHeight: lowered ? 360 : 720 };
}

/** The line over the call while it's getting back, or null. */
export function reconnectWords(s: { status: string; offline: boolean; phone: boolean }): string | null {
  if (s.offline) return "You're offline. The call carries on as soon as you're connected again.";
  if (s.status !== "reconnecting") return null;
  return s.phone ? "The picture dropped. Getting it back… (the call's sound carries on in the app)" : "Your connection dropped. Getting you back into the call…";
}

export function loweredWords(lowered: VideoPlan["lowered"]): string | null {
  if (lowered === "weak") return "Weak connection: video lowered";
  if (lowered === "saver") return "Data saver is on: video lowered";
  return null;
}
